import { describe, expect, it } from 'vitest';

import { HostedIdentityError, type OidcRuntime } from '@selene/identity-runtime';

import { createElectronOidcLogin } from './oidc';

const state = 'state-12345678901234567890';
const runtime: OidcRuntime = {
  async begin() {
    return {
      authorizationUrl: new URL('https://idp.example.test/authorize?state=' + state),
      state,
      nonce: 'nonce-12345678901234567890',
      codeVerifier: 'verifier-1234567890123456789012345678901234567890'
    };
  },
  async exchange({ callback, transaction }) {
    if (callback.searchParams.get('state') !== transaction.state) throw new Error('state');
    return {
      claims: { sub: 'desktop-subject' },
      subjectKey: 'https://idp.example.test|desktop-subject',
      expiresAt: Date.now() + 60_000
    };
  },
  async revoke() {},
  async endSession() {
    return undefined;
  }
};

describe('Electron system-browser OIDC', () => {
  it('opens the provider only in the system browser and consumes the loopback callback once', async () => {
    const opened: string[] = [];
    const login = createElectronOidcLogin(
      {
        issuer: 'https://idp.example.test',
        clientId: 'desktop-client',
        redirectUri: 'http://127.0.0.1:48123/auth/callback'
      },
      runtime,
      async (url) => {
        opened.push(url);
      }
    );
    const started = await login.begin();
    expect(opened).toEqual([started.authorizationUrl]);
    await expect(
      login.complete(
        `http://127.0.0.1:48123/auth/callback?code=code&state=${state}`,
        started.transactionId
      )
    ).resolves.toMatchObject({ claims: { sub: 'desktop-subject' } });
    await expect(
      login.complete(
        `http://127.0.0.1:48123/auth/callback?code=code&state=${state}`,
        started.transactionId
      )
    ).rejects.toMatchObject({ code: 'TRANSACTION_REPLAYED' });
  });

  it('rejects a callback redirect substitution before token exchange', async () => {
    const login = createElectronOidcLogin(
      {
        issuer: 'https://idp.example.test',
        clientId: 'desktop-client',
        redirectUri: 'http://127.0.0.1:48123/auth/callback'
      },
      runtime,
      async () => {}
    );
    const started = await login.begin();
    await expect(
      login.complete(`http://127.0.0.1:48123/other?code=code&state=${state}`, started.transactionId)
    ).rejects.toBeInstanceOf(HostedIdentityError);
  });
});
