import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  HostedIdentityError,
  HostedOidcBff,
  assertPublicOidcAddress,
  assertSameOriginPost,
  createOidcSsrfSafeFetch,
  createOpenIdClientRuntime,
  createInMemoryHostedBffStore,
  createDirectHostedOidcBffEffects,
  parseBffCookie,
  serializeBffCookie,
  validateElectronRedirectUri,
  validateHostedOidcProviderConfig,
  validateReturnTo,
  type OidcAddressPinnedTransport,
  type OidcRuntime
} from './index';

// @ts-expect-error Host-clock fields are not part of the public identity context.
const rejectedHostClockContext: import('./index').HostedIdentityCallContext = {
  remainingDurationMs: 1,
  cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined },
  ownerGeneration: 1
};
// @ts-expect-error Deadline timestamps are not part of the public identity context.
const rejectedDeadlineContext: import('./index').HostedIdentityCallContext = {
  remainingDurationMs: 1,
  cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined },
  deadlineMs: 1
};
// @ts-expect-error A portable remaining duration is required.
const rejectedMissingDuration: import('./index').HostedIdentityCallContext = {
  cancellation: { isCancellationRequested: () => false, subscribe: () => () => undefined }
};
void rejectedHostClockContext;
void rejectedDeadlineContext;
void rejectedMissingDuration;

const transactionState = 'state-12345678901234567890';
const sessionState = 'session-12345678901234567890';
const directContext = {
  remainingDurationMs: 10_000,
  cancellation: {
    isCancellationRequested: () => false,
    subscribe: () => () => undefined
  }
};

function runtime(failure?: string): OidcRuntime {
  return {
    async begin() {
      return {
        authorizationUrl: new URL('https://idp.example.test/authorize'),
        state: transactionState,
        nonce: 'nonce-12345678901234567890',
        codeVerifier: 'verifier-1234567890123456789012345678901234567890'
      };
    },
    async exchange({ callback, transaction }) {
      if (callback.searchParams.get('state') !== transaction.state) throw new Error('state');
      if (failure) throw new Error(failure);
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: 'id-token',
        claims: { sub: 'subject-1', email: 'person@example.test' },
        subjectKey: 'https://idp.example.test|subject-1',
        expiresAt: 100_000
      };
    },
    async revoke() {},
    async endSession() {
      return undefined;
    }
  };
}

function bff(failure?: string) {
  const service = new HostedOidcBff({
    effects: createDirectHostedOidcBffEffects(
      runtime(failure),
      createInMemoryHostedBffStore({ now: () => 1_000 })
    ),
    issuer: 'https://idp.example.test',
    allowedIssuerHosts: ['idp.example.test'],
    redirectUri: 'https://app.example.test/auth/callback',
    now: () => 1_000
  });
  return {
    begin: (returnTo?: string) => service.begin(directContext, returnTo),
    complete: (callback: URL, transactionId: string) =>
      service.complete(directContext, callback, transactionId),
    authenticate: (sessionId: string) => service.authenticate(directContext, sessionId),
    bindSessionAccess: (
      sessionId: string,
      access: Parameters<HostedOidcBff['bindSessionAccess']>[2]
    ) => service.bindSessionAccess(directContext, sessionId, access),
    revokeSession: (sessionId: string) => service.revokeSession(directContext, sessionId),
    logout: (sessionId: string) => service.logout(directContext, sessionId),
    cookieMaxAgeSeconds: service.cookieMaxAgeSeconds.bind(service),
    transactionCookieMaxAgeSeconds: service.transactionCookieMaxAgeSeconds.bind(service)
  };
}

describe('hosted OIDC BFF security fixtures', () => {
  it('captures adapter methods once and invokes captured ports without bind wrappers', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const capture = source.slice(
      source.indexOf('function captureMethods('),
      source.indexOf('function boundedAdapterCall(')
    );
    expect(capture).not.toContain('.bind(');
    expect(capture).toContain('Reflect.apply');
  });

  it('bounds aggregate adapter snapshots without rereading a hostile prototype chain', async () => {
    let descriptorPasses = 0;
    const observedRuntime = new Proxy(runtime(), {
      ownKeys(target) {
        descriptorPasses += 1;
        return Reflect.ownKeys(target);
      }
    });
    const observed = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(observedRuntime, createInMemoryHostedBffStore()),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback'
    });
    await observed.begin(directContext);
    expect(descriptorPasses).toBe(0);

    const oversizedStore = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 129; index += 1) oversizedStore[`noise${index}`] = index;
    const oversized = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(runtime(), oversizedStore as never),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback'
    });
    await expect(oversized.begin(directContext)).rejects.toThrow('OIDC host effects are invalid');
  });

  it('completes the Authorization Code + PKCE transaction and creates a fresh session', async () => {
    const service = bff();
    const start = await service.begin('/projects/p-1');
    const callback = new URL('https://app.example.test/auth/callback');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', transactionState);
    const result = await service.complete(callback, start.transactionId);
    expect(result.returnTo).toBe('/projects/p-1');
    expect(result.session.id).not.toBe(start.transactionId);
    await expect(service.authenticate(result.session.id)).resolves.toMatchObject({
      subject: 'https://idp.example.test|subject-1'
    });
  });

  it('runs standard adversarial callback fixtures and consumes every failed transaction', async () => {
    const fixtures = JSON.parse(
      await readFile(new URL('./fixtures/oidc-security.json', import.meta.url), 'utf8')
    ) as { readonly failures: readonly string[] };
    await Promise.all(
      fixtures.failures.map(async (failure) => {
        const service = bff(failure);
        const start = await service.begin();
        const callback = new URL('https://app.example.test/auth/callback');
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', transactionState);
        await expect(service.complete(callback, start.transactionId)).rejects.toMatchObject({
          code: 'INVALID_RUNTIME',
          message: 'OIDC runtime exchange failed'
        });
        await expect(service.complete(callback, start.transactionId)).rejects.toMatchObject({
          code: 'TRANSACTION_REPLAYED'
        });
      })
    );
  });

  it('rejects open redirects, SSRF-shaped discovery URLs, CSRF, and malformed cookies', () => {
    expect(() => validateReturnTo('https://attacker.example')).toThrow('safe relative');
    expect(() => validateReturnTo('//attacker.example')).toThrow('safe relative');
    expect(() =>
      validateHostedOidcProviderConfig({
        issuer: 'http://127.0.0.1:8080',
        allowedIssuerHosts: ['idp.example.test'],
        clientId: 'client',
        redirectUri: 'https://app.example.test/auth/callback'
      })
    ).toThrow('public HTTPS');
    expect(() =>
      validateHostedOidcProviderConfig({
        issuer: 'https://169.254.169.254',
        allowedIssuerHosts: ['idp.example.test'],
        clientId: 'client',
        redirectUri: 'https://app.example.test/auth/callback'
      })
    ).toThrow('public HTTPS');
    expect(() =>
      validateHostedOidcProviderConfig({
        issuer: 'https://idp.example.test',
        allowedIssuerHosts: ['other.example.test'],
        clientId: 'client',
        redirectUri: 'https://app.example.test/auth/callback'
      })
    ).toThrow('explicit allowlist');
    expect(() => validateElectronRedirectUri('http://localhost/callback')).toThrow('loopback HTTP');
    expect(() =>
      assertSameOriginPost(
        new Request('https://app.example.test/auth/logout', { method: 'GET' }),
        'https://app.example.test'
      )
    ).toThrow('same-origin POST');
    expect(() =>
      assertSameOriginPost(
        new Request('https://app.example.test/auth/logout', {
          method: 'POST',
          headers: { origin: 'https://evil.example' }
        }),
        'https://app.example.test'
      )
    ).toThrow('same-origin POST');
    const cookie = serializeBffCookie('__Host-selene_session', sessionState, 60);
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(
      parseBffCookie(
        `__Host-selene_session=${sessionState}; __Host-selene_session=attacker-12345678901234567890`,
        '__Host-selene_session'
      )
    ).toBeUndefined();
    expect(() => assertPublicOidcAddress('8.8.8.8')).not.toThrow();
    expect(() => assertPublicOidcAddress('100.64.0.1')).toThrow('DNS target');
    expect(() => assertPublicOidcAddress('::ffff:127.0.0.1')).toThrow('DNS target');
  });

  it('allows OIDC HTTP only to the configured public issuer hosts and forbids redirects', async () => {
    const requests: { readonly url: string; readonly redirect?: RequestRedirect }[] = [];
    const transport: OidcAddressPinnedTransport = {
      async resolve() {
        return ['8.8.8.8'];
      },
      async fetch(request, addresses) {
        requests.push({ url: request.url, redirect: request.redirect });
        expect(addresses).toEqual(['8.8.8.8']);
        return new Response('{}');
      }
    };
    const restricted = createOidcSsrfSafeFetch(['idp.example.test'], transport);
    await restricted('https://idp.example.test/.well-known/openid-configuration');
    await expect(restricted('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'allowlist policy'
    );
    await expect(restricted('https://evil.example.test/jwks')).rejects.toThrow('allowlist policy');
    await expect(restricted('https://idp.example.test:8443/jwks')).rejects.toThrow(
      'allowlist policy'
    );
    expect(requests).toEqual([
      { url: 'https://idp.example.test/.well-known/openid-configuration', redirect: 'error' }
    ]);
    await expect(
      createOidcSsrfSafeFetch(['idp.example.test'], {
        async resolve() {
          return ['127.0.0.1'];
        },
        async fetch() {
          throw new Error('must not be called');
        }
      })('https://idp.example.test/jwks')
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONFIG' });
    expect(() =>
      createOpenIdClientRuntime(
        {
          issuer: 'https://idp.example.test',
          allowedIssuerHosts: ['idp.example.test'],
          clientId: 'client',
          redirectUri: 'https://app.example.test/auth/callback'
        },
        {} as never
      )
    ).toThrow('transport');
  });

  it('rejects hostile config values and detaches all administrator-provided lists', () => {
    const config = {
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      clientId: 'client',
      redirectUri: 'https://app.example.test/auth/callback',
      scopes: ['openid', 'profile']
    };
    const validated = validateHostedOidcProviderConfig(config);
    config.allowedIssuerHosts[0] = 'evil.example.test';
    config.scopes?.push('admin');
    expect(validated.allowedIssuerHosts).toEqual(['idp.example.test']);
    expect(validated.scopes).toEqual(['openid', 'profile']);
    expect(Object.isFrozen(validated.allowedIssuerHosts)).toBe(true);
    let descriptorPasses = 0;
    const observedConfig = new Proxy(
      {
        ...config,
        allowedIssuerHosts: ['idp.example.test'],
        scopes: ['openid', 'profile']
      },
      {
        ownKeys(target) {
          descriptorPasses += 1;
          return Reflect.ownKeys(target);
        }
      }
    );
    validateHostedOidcProviderConfig(observedConfig);
    expect(descriptorPasses).toBe(1);
    expect(() => validateHostedOidcProviderConfig(null as never)).toThrow('plain data object');
    expect(() =>
      validateHostedOidcProviderConfig({ ...config, [Symbol('extra')]: 'unexpected' } as never)
    ).toThrow('plain data object');
    const withGetter = { ...config };
    Object.defineProperty(withGetter, 'issuer', {
      get() {
        throw new Error('getter trap');
      }
    });
    expect(() => validateHostedOidcProviderConfig(withGetter)).toThrow('plain data object');
    expect(() =>
      validateHostedOidcProviderConfig({
        ...config,
        allowedIssuerHosts: ['idp.example.test', 'idp.example.test']
      })
    ).toThrow('is invalid');
    expect(() =>
      validateHostedOidcProviderConfig({
        ...config,
        allowedIssuerHosts: Array(33).fill('idp.example.test')
      })
    ).toThrow('invalid');
    expect(() =>
      validateHostedOidcProviderConfig({
        issuer: 'https://idp.example.test',
        allowedIssuerHosts: ['idp.example.test'],
        clientId: 'client',
        redirectUri: 'https://app.example.test:8443/auth/callback'
      })
    ).toThrow('public HTTPS');
  });

  it('bounds clocks, inputs, adapter failures, and snapshots mutable store values', async () => {
    expect(
      () =>
        new HostedOidcBff({
          effects: createDirectHostedOidcBffEffects(runtime(), createInMemoryHostedBffStore()),
          issuer: 'https://idp.example.test',
          allowedIssuerHosts: ['idp.example.test'],
          redirectUri: 'https://app.example.test/auth/callback',
          now: () => Number.NaN
        })
    ).toThrow('clock is invalid');
    expect(
      () =>
        new HostedOidcBff({
          effects: createDirectHostedOidcBffEffects(runtime(), createInMemoryHostedBffStore()),
          issuer: 'https://idp.example.test',
          allowedIssuerHosts: ['idp.example.test'],
          redirectUri: 'https://app.example.test/auth/callback',
          transactionTtlMs: Infinity
        })
    ).toThrow('TTL is invalid');
    expect(() => validateReturnTo('/' + 'a'.repeat(2_048))).toThrow('safe relative');
    expect(parseBffCookie('x'.repeat(8_193), '__Host-selene_session')).toBeUndefined();
    expect(() =>
      serializeBffCookie('__Host-selene_session', sessionState, Number.POSITIVE_INFINITY)
    ).toThrow('lifetime');

    const store = createInMemoryHostedBffStore({ now: () => 1_000 });
    const mutable = {
      id: sessionState,
      subject: 'issuer|subject',
      expiresAt: 61_000,
      tokens: {
        subjectKey: 'issuer|subject',
        claims: { sub: 'subject' },
        expiresAt: 61_000
      }
    };
    await store.createSession(mutable);
    mutable.tokens.claims.sub = 'attacker';
    const snapshot = await store.readSession(sessionState);
    expect(snapshot).toMatchObject({
      subject: 'issuer|subject',
      tokens: { claims: { sub: 'subject' } }
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.tokens ?? {})).toBe(true);
    await expect(
      store.createSession({
        ...mutable,
        id: 'expired-session-12345678901234567890',
        expiresAt: 1_000,
        tokens: { ...mutable.tokens, expiresAt: 1_000 }
      })
    ).rejects.toMatchObject({ code: 'INVALID_CALLBACK' });
    const hostileStoreOptions = {} as Record<string, unknown>;
    Object.defineProperty(hostileStoreOptions, 'now', {
      get: () => {
        throw new Error('getter');
      }
    });
    expect(() => createInMemoryHostedBffStore(hostileStoreOptions as never)).toThrow(
      'store options must be a plain data object'
    );

    const failing = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async begin() {
            throw new Error('secret provider detail '.repeat(1_000));
          }
        },
        createInMemoryHostedBffStore()
      ),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: () => 1_000
    });
    await expect(failing.begin(directContext)).rejects.toMatchObject({
      code: 'INVALID_RUNTIME',
      message: 'OIDC runtime begin failed'
    });
    const forged = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async begin() {
            throw new HostedIdentityError('CSRF', 'forged adapter error');
          }
        },
        createInMemoryHostedBffStore()
      ),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: () => 1_000
    });
    await expect(forged.begin(directContext)).rejects.toMatchObject({ code: 'INVALID_RUNTIME' });
    const backwards = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(runtime(), createInMemoryHostedBffStore()),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: (() => {
        let current = 2_000;
        return () => current--;
      })()
    });
    await expect(backwards.begin(directContext)).rejects.toMatchObject({ code: 'INVALID_RUNTIME' });

    let subscriptions = 0;
    const hostileContext = {
      remainingDurationMs: 10_000,
      cancellation: {
        isCancellationRequested: () => false,
        subscribe: () => {
          subscriptions += 1;
          return () => {
            subscriptions -= 1;
          };
        }
      }
    };
    const syncThrow = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          begin() {
            throw new Error('synchronous hostile adapter failure');
          }
        },
        createInMemoryHostedBffStore({ now: () => 1_000 })
      ),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: () => 1_000
    });
    await expect(syncThrow.begin(hostileContext)).rejects.toMatchObject({
      code: 'INVALID_RUNTIME'
    });
    expect(subscriptions).toBe(0);

    const fixedSchemaContext = new Proxy(
      {
        remainingDurationMs: 10_000,
        cancellation: {
          isCancellationRequested: () => false,
          subscribe: () => () => undefined
        }
      },
      {
        ownKeys() {
          throw new Error('context enumeration must not occur');
        }
      }
    );
    const fixedSchemaService = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(runtime(), createInMemoryHostedBffStore()),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: () => 1_000
    });
    await expect(fixedSchemaService.begin(fixedSchemaContext)).resolves.toMatchObject({
      transactionId: expect.any(String)
    });
  });

  it('atomically consumes malformed callbacks and concurrent logout sessions', async () => {
    const store = createInMemoryHostedBffStore({ now: () => 1_000 });
    let endSessions = 0;
    const service = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async endSession() {
            endSessions += 1;
            return undefined;
          }
        },
        store
      ),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback',
      now: () => 1_000
    });
    const start = await service.begin(directContext);
    await expect(
      service.complete(
        directContext,
        new URL('https://evil.example.test/auth/callback'),
        start.transactionId
      )
    ).rejects.toMatchObject({ code: 'INVALID_REDIRECT' });
    await expect(
      service.complete(
        directContext,
        new URL('https://app.example.test/auth/callback'),
        start.transactionId
      )
    ).rejects.toMatchObject({ code: 'TRANSACTION_REPLAYED' });
    await store.createSession({
      id: sessionState,
      subject: 'https://idp.example.test|subject-1',
      expiresAt: 100_000,
      tokens: {
        idToken: 'id-token',
        subjectKey: 'https://idp.example.test|subject-1',
        claims: { sub: 'subject-1' },
        expiresAt: 100_000
      }
    });
    await Promise.all([
      service.logout(directContext, sessionState),
      service.logout(directContext, sessionState)
    ]);
    expect(endSessions).toBe(1);
    await expect(service.authenticate(directContext, sessionState)).resolves.toBeUndefined();
  });

  it('requires complete captured adapters and allowlists runtime URLs and subject issuers', async () => {
    const options = {
      redirectUri: 'https://app.example.test/auth/callback',
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      now: () => 1_000
    };
    expect(() => new HostedOidcBff({ ...options, effects: {} as never })).toThrow('host effects');

    const unsafeAuthorization = new HostedOidcBff({
      ...options,
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async begin() {
            return {
              ...(await runtime().begin({
                redirectUri: new URL(options.redirectUri),
                scopes: ['openid', 'profile', 'email']
              })),
              authorizationUrl: new URL('https://evil.example.test/authorize')
            };
          }
        },
        createInMemoryHostedBffStore({ now: options.now })
      )
    });
    await expect(unsafeAuthorization.begin(directContext)).rejects.toMatchObject({
      code: 'INVALID_RUNTIME'
    });

    const unsafeSubject = new HostedOidcBff({
      ...options,
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async exchange() {
            return {
              claims: { sub: 'subject-1' },
              subjectKey: 'https://evil.example.test|subject-1',
              expiresAt: 100_000
            };
          }
        },
        createInMemoryHostedBffStore({ now: options.now })
      )
    });
    const started = await unsafeSubject.begin(directContext);
    await expect(
      unsafeSubject.complete(
        directContext,
        new URL(options.redirectUri + '?state=' + started.transactionId),
        started.transactionId
      )
    ).rejects.toMatchObject({ code: 'INVALID_RUNTIME' });
    const sameHostDifferentIssuer = new HostedOidcBff({
      ...options,
      effects: createDirectHostedOidcBffEffects(
        {
          ...runtime(),
          async exchange() {
            return {
              claims: { sub: 'subject-1' },
              subjectKey: 'https://idp.example.test/another-tenant|subject-1',
              expiresAt: 100_000
            };
          }
        },
        createInMemoryHostedBffStore({ now: options.now })
      )
    });
    const sameHostStart = await sameHostDifferentIssuer.begin(directContext);
    await expect(
      sameHostDifferentIssuer.complete(
        directContext,
        new URL(options.redirectUri + '?state=' + sameHostStart.transactionId),
        sameHostStart.transactionId
      )
    ).rejects.toMatchObject({ code: 'INVALID_RUNTIME' });
    expect(() => validateReturnTo('/%2f%2fevil.example.test')).toThrow('encoded separators');
  });
});
