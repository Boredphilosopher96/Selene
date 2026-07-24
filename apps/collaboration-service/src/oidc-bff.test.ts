import { describe, expect, it } from 'vitest';

import {
  HostedIdentityError,
  HostedOidcBff,
  createDirectHostedOidcBffEffects,
  createInMemoryHostedBffStore,
  type OidcRuntime
} from '@selene/identity-runtime';

import { createBffIdentityProvider, createOidcBffHttpHandler } from './oidc-bff';

const state = 'state-12345678901234567890';
const directContext = {
  remainingDurationMs: 10_000,
  cancellation: {
    isCancellationRequested: () => false,
    subscribe: () => () => undefined
  }
};
const runtime: OidcRuntime = {
  async begin() {
    return {
      authorizationUrl: new URL('https://idp.example.test/authorize?client_id=client'),
      state,
      nonce: 'nonce-12345678901234567890',
      codeVerifier: 'verifier-1234567890123456789012345678901234567890'
    };
  },
  async exchange() {
    return {
      accessToken: 'never-returned-to-browser',
      refreshToken: 'never-returned-to-browser',
      idToken: 'never-returned-to-browser',
      claims: { sub: 'oidc-subject' },
      subjectKey: 'https://idp.example.test|oidc-subject',
      expiresAt: Date.now() + 60_000
    };
  },
  async revoke() {},
  async endSession() {
    return undefined;
  }
};

function service(runtimeAdapter: OidcRuntime = runtime, store = createInMemoryHostedBffStore()) {
  const bff = new HostedOidcBff({
    effects: createDirectHostedOidcBffEffects(runtimeAdapter, store),
    issuer: 'https://idp.example.test',
    allowedIssuerHosts: ['idp.example.test'],
    redirectUri: 'https://app.example.test/auth/callback'
  });
  return { bff, store, handler: createOidcBffHttpHandler(bff, 'https://app.example.test') };
}

function cookieValue(cookie: string, name: string): string {
  const value = new RegExp(`${name}=([^;]+)`).exec(cookie)?.[1];
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value;
}

describe('hosted BFF HTTP boundary', () => {
  it('bounds resolver descriptor snapshots under hostile prototype traversal', () => {
    const noisy = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 65; index += 1) noisy[`noise${index}`] = index;
    expect(() => createBffIdentityProvider(service().bff, noisy as never)).toThrow(
      'External subject resolver is invalid'
    );
  });
  it('uses one resolver descriptor map and fences a self-referential prototype', () => {
    let descriptorPasses = 0;
    const resolver = new Proxy(
      {
        async resolveExternalSubject() {
          return undefined;
        }
      },
      {
        ownKeys(target) {
          descriptorPasses += 1;
          return Reflect.ownKeys(target);
        }
      }
    );
    createBffIdentityProvider(service().bff, resolver);
    expect(descriptorPasses).toBe(0);

    let cyclePasses = 0;
    const cycle = new Proxy(
      {},
      {
        ownKeys() {
          cyclePasses += 1;
          return [];
        },
        getPrototypeOf() {
          return cycle;
        }
      }
    );
    expect(() => createBffIdentityProvider(service().bff, cycle as never)).toThrow(
      'External subject resolver is invalid'
    );
    expect(cyclePasses).toBe(0);
  });
  it('keeps OIDC credentials server-side and uses one-time transaction/session cookies', async () => {
    const { bff, handler } = service();
    const login = await handler.fetch(
      new Request('https://app.example.test/auth/login?returnTo=/projects/p-1')
    );
    expect(login).toMatchObject({ status: 303 });
    expect(login?.headers.get('location')).toBe(
      'https://idp.example.test/authorize?client_id=client'
    );
    const transactionCookie = login?.headers.get('set-cookie');
    expect(transactionCookie).toContain('__Host-selene_oidc_tx=');
    expect(transactionCookie).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(login?.headers.get('cache-control')).toContain('no-store');
    expect(login?.headers.get('pragma')).toBe('no-cache');
    expect(login?.headers.get('referrer-policy')).toBe('no-referrer');

    const callback = await handler.fetch(
      new Request('https://app.example.test/auth/callback?code=code&state=' + state, {
        headers: { cookie: transactionCookie ?? '' }
      })
    );
    expect(callback).toMatchObject({ status: 303 });
    expect(callback?.headers.get('location')).toBe('/projects/p-1');
    const sessionCookie = callback?.headers.get('set-cookie') ?? '';
    expect(sessionCookie).toContain('__Host-selene_session=');
    expect(sessionCookie).not.toContain('never-returned-to-browser');

    let accessVersion = 1;
    const identity = createBffIdentityProvider(bff, {
      async resolveExternalSubject(session) {
        return session.subject === 'https://idp.example.test|oidc-subject' &&
          (session.accessVersion === undefined || session.accessVersion === accessVersion)
          ? { userId: 'internal-user', organizationId: 'org-1', accessVersion: 1 }
          : undefined;
      }
    });
    await expect(
      identity.authenticate(
        new Request('https://app.example.test/v1/projects', { headers: { cookie: sessionCookie } })
      )
    ).resolves.toBe('internal-user');
    await expect(
      bff.authenticate(directContext, cookieValue(sessionCookie, '__Host-selene_session'))
    ).resolves.toMatchObject({
      organizationId: 'org-1',
      accessVersion: 1
    });
    accessVersion = 2;
    await expect(
      identity.authenticate(
        new Request('https://app.example.test/v1/projects', { headers: { cookie: sessionCookie } })
      )
    ).resolves.toBeUndefined();
  });

  it('rejects logout CSRF and clears the server-side session after same-origin POST', async () => {
    const { handler } = service();
    const csrf = await handler.fetch(
      new Request('https://app.example.test/auth/logout', { method: 'POST' })
    );
    expect(csrf).toMatchObject({ status: 403 });
    expect(await csrf?.json()).toEqual({ error: 'csrf' });
    const logout = await handler.fetch(
      new Request('https://app.example.test/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://app.example.test' }
      })
    );
    expect(logout).toMatchObject({ status: 200 });
    expect(logout?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(logout?.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(logout?.headers.get('cache-control')).toContain('no-store');
  });

  it('fails closed for a foreign request origin and clears a failed callback transaction cookie', async () => {
    const { handler } = service();
    const foreign = await handler.fetch(new Request('https://evil.example.test/auth/login'));
    expect(foreign).toMatchObject({ status: 400 });
    expect(foreign?.headers.get('cache-control')).toContain('no-store');
    const callback = await handler.fetch(
      new Request('https://app.example.test/auth/callback?state=bad', {
        headers: { cookie: '__Host-selene_oidc_tx=bad' }
      })
    );
    expect(callback).toMatchObject({ status: 400 });
    expect(callback?.headers.get('set-cookie')).toContain('__Host-selene_oidc_tx=;');
    const staleLogin = await handler.fetch(
      new Request('https://app.example.test/auth/login?returnTo=//evil.example.test', {
        headers: { cookie: '__Host-selene_oidc_tx=state-12345678901234567890' }
      })
    );
    expect(staleLogin).toMatchObject({ status: 400 });
    expect(staleLogin?.headers.get('set-cookie')).toContain('__Host-selene_oidc_tx=;');
    const hostileBody = await handler.fetch(
      new Request('https://app.example.test/auth/login', {
        headers: {
          'content-length': '1',
          cookie: '__Host-selene_oidc_tx=state-12345678901234567890'
        }
      })
    );
    expect(hostileBody).toMatchObject({ status: 400 });
    expect(hostileBody?.headers.get('set-cookie')).toContain('__Host-selene_oidc_tx=;');
    expect(hostileBody?.headers.get('set-cookie')).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
  });

  it('rejects an actual unframed BFF body and never lets forged errors control browser output', async () => {
    const { handler } = service();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      }
    });
    const bodyResponse = await handler.fetch(
      new Request('https://app.example.test/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://app.example.test' },
        body,
        duplex: 'half'
      } as never)
    );
    expect(bodyResponse).toMatchObject({ status: 400 });

    const forged = Object.create(HostedIdentityError.prototype);
    Object.defineProperty(forged, 'code', {
      get: () => {
        throw new Error('trap');
      }
    });
    const hostileHandler = createOidcBffHttpHandler(
      {
        begin: async () => {
          throw forged;
        }
      } as never,
      'https://app.example.test'
    );
    const response = await hostileHandler.fetch(new Request('https://app.example.test/auth/login'));
    expect(response).toMatchObject({ status: 503 });
    expect(await response?.json()).toEqual({ error: 'authentication_failed' });
  });

  it('clears the browser session cookie when the server-side logout adapter fails', async () => {
    const store = createInMemoryHostedBffStore();
    const { handler } = service(
      {
        ...runtime,
        async endSession() {
          throw new Error('provider detail');
        }
      },
      store
    );
    const sessionId = 'session-logout-failure-12345678901234567890';
    await store.createSession({
      id: sessionId,
      subject: 'https://idp.example.test|oidc-subject',
      expiresAt: Date.now() + 60_000,
      tokens: {
        idToken: 'never-returned-to-browser',
        subjectKey: 'https://idp.example.test|oidc-subject',
        claims: { sub: 'oidc-subject' },
        expiresAt: Date.now() + 60_000
      }
    });
    const response = await handler.fetch(
      new Request('https://app.example.test/auth/logout', {
        method: 'POST',
        headers: {
          origin: 'https://app.example.test',
          cookie: `__Host-selene_session=${sessionId}`
        }
      })
    );
    expect(response).toMatchObject({ status: 503 });
    expect(response?.headers.get('set-cookie')).toContain('__Host-selene_session=;');
  });

  it('binds a concurrent first request once and revokes any later organization/version mismatch', async () => {
    const store = createInMemoryHostedBffStore();
    const bff = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(runtime, store),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback'
    });
    const sessionId = 'session-12345678901234567890';
    await store.createSession({
      id: sessionId,
      subject: 'https://idp.example.test|subject',
      expiresAt: Date.now() + 60_000,
      tokens: {
        subjectKey: 'https://idp.example.test|subject',
        claims: { sub: 'subject' },
        expiresAt: Date.now() + 60_000
      }
    });
    const request = new Request('https://app.example.test/v1/projects', {
      headers: { cookie: `__Host-selene_session=${sessionId}` }
    });
    const consistent = createBffIdentityProvider(bff, {
      async resolveExternalSubject() {
        return { userId: 'user-1', organizationId: 'org-1', accessVersion: 1 };
      }
    });
    await expect(
      Promise.all([consistent.authenticate(request), consistent.authenticate(request)])
    ).resolves.toEqual(['user-1', 'user-1']);
    const mismatched = createBffIdentityProvider(bff, {
      async resolveExternalSubject() {
        return { userId: 'user-1', organizationId: 'org-2', accessVersion: 2 };
      }
    });
    await expect(mismatched.authenticate(request)).resolves.toBeUndefined();
    await expect(bff.authenticate(directContext, sessionId)).resolves.toBeUndefined();
  });
});
