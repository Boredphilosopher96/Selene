import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  HostedOidcBff,
  applyFixtureExchange,
  assertSameOriginPost,
  createInMemoryHostedBffStore,
  parseBffCookie,
  serializeBffCookie,
  validateElectronRedirectUri,
  validateHostedOidcProviderConfig,
  validateReturnTo,
  type OidcRuntime
} from './index';

const transactionState = 'state-12345678901234567890';
const sessionState = 'session-12345678901234567890';

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
      applyFixtureExchange(callback, transaction, failure);
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

function bff(failure?: string): HostedOidcBff {
  return new HostedOidcBff({
    runtime: runtime(failure),
    store: createInMemoryHostedBffStore(),
    redirectUri: 'https://app.example.test/auth/callback',
    now: () => 1_000
  });
}

describe('hosted OIDC BFF security fixtures', () => {
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
        await expect(service.complete(callback, start.transactionId)).rejects.toThrow(failure);
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
        clientId: 'client',
        redirectUri: 'https://app.example.test/auth/callback'
      })
    ).toThrow('public HTTPS');
    expect(() =>
      validateHostedOidcProviderConfig({
        issuer: 'https://169.254.169.254',
        clientId: 'client',
        redirectUri: 'https://app.example.test/auth/callback'
      })
    ).toThrow('public HTTPS');
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
  });
});
