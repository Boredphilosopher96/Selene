import { timingSafeEqual } from 'node:crypto';

/** Replace this adapter with OIDC/SAML/session middleware in a host deployment. */
export interface IdentityProvider {
  authenticate(request: Request): Promise<string | undefined>;
}

function secretsMatch(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * The reverse proxy supplies both a verified principal and a server-only
 * shared secret. A browser-provided identity header is never trusted alone.
 */
export function createHeaderIdentityProvider(proxySecret: string): IdentityProvider {
  return {
    async authenticate(request) {
      if (!secretsMatch(request.headers.get('x-selene-proxy-secret'), proxySecret)) {
        return undefined;
      }
      return request.headers.get('x-selene-user-id') ?? undefined;
    }
  };
}
