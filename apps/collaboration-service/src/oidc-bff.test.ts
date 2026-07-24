import { describe, expect, it } from 'vitest';

import {
  HostedOidcBff,
  createInMemoryHostedBffStore,
  type OidcRuntime
} from '@selene/identity-runtime';

import { createBffIdentityProvider, createOidcBffHttpHandler } from './oidc-bff';

const state = 'state-12345678901234567890';
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

function service() {
  const bff = new HostedOidcBff({
    runtime,
    store: createInMemoryHostedBffStore(),
    redirectUri: 'https://app.example.test/auth/callback'
  });
  return { bff, handler: createOidcBffHttpHandler(bff, 'https://app.example.test') };
}

function cookieValue(cookie: string, name: string): string {
  const value = new RegExp(`${name}=([^;]+)`).exec(cookie)?.[1];
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value;
}

describe('hosted BFF HTTP boundary', () => {
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
      bff.authenticate(cookieValue(sessionCookie, '__Host-selene_session'))
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
    expect(csrf).toMatchObject({ status: 400 });
    expect(await csrf?.json()).toEqual({ error: 'csrf' });
    const logout = await handler.fetch(
      new Request('https://app.example.test/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://app.example.test' }
      })
    );
    expect(logout).toMatchObject({ status: 200 });
    expect(logout?.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
