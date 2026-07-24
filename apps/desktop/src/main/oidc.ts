import { createServer } from 'node:http';

import {
  HostedIdentityError,
  validateElectronRedirectUri,
  type HostedOidcProviderConfig,
  type OidcAuthorizationTransaction,
  type OidcRuntime,
  type OidcTokenSet
} from '@selene/identity-runtime';

export interface ElectronOidcLogin {
  begin(): Promise<{ readonly authorizationUrl: string; readonly transactionId: string }>;
  complete(callbackUrl: string, transactionId: string): Promise<OidcTokenSet>;
  signInWithLoopback(): Promise<OidcTokenSet>;
}

/**
 * Native Authorization Code + PKCE controller. `begin` is main-process only
 * and launches the system browser; no renderer ever receives a verifier,
 * nonce, token, or client secret. A loopback listener or claimed-HTTPS
 * protocol handler must pass its complete callback URL to `complete`.
 */
export function createElectronOidcLogin(
  provider: HostedOidcProviderConfig,
  runtime: OidcRuntime,
  openExternal: (url: string) => Promise<void>
): ElectronOidcLogin {
  const redirectUri = validateElectronRedirectUri(provider.redirectUri);
  const pending = new Map<string, OidcAuthorizationTransaction>();
  return {
    async begin() {
      const prepared = await runtime.begin({
        redirectUri,
        scopes: provider.scopes ?? ['openid', 'profile', 'email']
      });
      const transaction: OidcAuthorizationTransaction = {
        id: prepared.state,
        state: prepared.state,
        nonce: prepared.nonce,
        codeVerifier: prepared.codeVerifier,
        redirectUri: redirectUri.href,
        returnTo: '/',
        expiresAt: Date.now() + 5 * 60_000
      };
      pending.set(transaction.id, transaction);
      await openExternal(prepared.authorizationUrl.href);
      return { authorizationUrl: prepared.authorizationUrl.href, transactionId: transaction.id };
    },
    async complete(callbackUrl, transactionId) {
      const transaction = pending.get(transactionId);
      // Consume before validation/exchange: no redirect can be replayed after a failure.
      pending.delete(transactionId);
      if (!transaction || transaction.expiresAt <= Date.now()) {
        throw new HostedIdentityError(
          'TRANSACTION_REPLAYED',
          'Electron OIDC transaction is missing or expired'
        );
      }
      const callback = new URL(callbackUrl);
      if (callback.origin !== redirectUri.origin || callback.pathname !== redirectUri.pathname) {
        throw new HostedIdentityError(
          'INVALID_REDIRECT',
          'Electron OIDC callback does not match the configured redirect'
        );
      }
      return runtime.exchange({ callback, transaction });
    },
    async signInWithLoopback() {
      if (redirectUri.protocol !== 'http:') {
        throw new HostedIdentityError(
          'INVALID_REDIRECT',
          'Loopback login requires a loopback HTTP redirect URI'
        );
      }
      const listener = await listenForLoopbackCallback(redirectUri);
      try {
        const started = await this.begin();
        return this.complete(await listener.callback, started.transactionId);
      } finally {
        listener.close();
      }
    }
  };
}

async function listenForLoopbackCallback(redirectUri: URL): Promise<{
  readonly callback: Promise<string>;
  close(): void;
}> {
  if (!redirectUri.port) {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'Loopback redirect URI must use an explicit registered port'
    );
  }
  let resolveCallback!: (url: string) => void;
  const callback = new Promise<string>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((request, response) => {
    const received = new URL(request.url ?? '/', redirectUri);
    if (request.method !== 'GET' || received.pathname !== redirectUri.pathname) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end('Selene sign-in completed. You may return to the desktop app.');
    resolveCallback(new URL(received.pathname + received.search, redirectUri).href);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: redirectUri.hostname, port: Number(redirectUri.port) }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { callback, close: () => server.close() };
}
