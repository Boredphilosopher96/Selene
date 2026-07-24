import { timingSafeEqual } from 'node:crypto';

import {
  createLocalIdentityProvider as createContractLocalIdentityProvider,
  identityContract
} from '@selene/collaboration/identity';

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

/**
 * Account-free mode for a local desktop/demo host. This provider never reads
 * browser identity headers; production deployments must use the proxy or BFF
 * adapter after OIDC/SAML verification.
 */
export function createNoLoginIdentityProvider(userId: string): IdentityProvider {
  const local = createContractLocalIdentityProvider({
    contract: identityContract,
    subject: {
      id: userId,
      organizationId: 'local',
      email: `${userId}@local.invalid`,
      displayName: 'Local user',
      provider: 'local'
    },
    organization: { id: 'local', slug: 'local', name: 'Local workspace' },
    membership: { organizationId: 'local', subjectId: userId, role: 'owner' }
  });
  return {
    async authenticate() {
      return (await local.authenticate()).subject.id;
    }
  };
}
