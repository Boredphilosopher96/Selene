import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  IdentityContractError,
  applyScimUser,
  assertPkceVerifier,
  identityContract,
  redactIdentityAuditEvent,
  validateOidcAuthorizationCallback,
  type AuthenticatedIdentity,
  type ScimDirectoryPort
} from './identity';

const verifier = 'a'.repeat(43);
const localIdentity: AuthenticatedIdentity = {
  contract: identityContract,
  subject: {
    id: 'user-1',
    organizationId: 'org-1',
    email: 'local@selene.test',
    displayName: 'Local',
    provider: 'local'
  },
  organization: { id: 'org-1', slug: 'local', name: 'Local' },
  membership: { organizationId: 'org-1', subjectId: 'user-1', role: 'owner' }
};

describe('identity contracts', () => {
  it('accepts only the expected single OIDC authorization callback', async () => {
    const fixtures = JSON.parse(
      await readFile(new URL('./fixtures/oidc-callbacks.json', import.meta.url), 'utf8')
    ) as {
      readonly valid: string;
      readonly invalid: readonly { readonly query: string; readonly error: string }[];
    };
    expect(
      validateOidcAuthorizationCallback(new URLSearchParams(fixtures.valid), {
        state: 'state-1',
        codeVerifier: verifier
      })
    ).toEqual({ code: 'code-1', state: 'state-1' });
    for (const fixture of fixtures.invalid) {
      expect(() =>
        validateOidcAuthorizationCallback(new URLSearchParams(fixture.query), {
          state: 'state-1',
          codeVerifier: verifier
        })
      ).toThrow(fixture.error);
    }
  });

  it('rejects malformed PKCE verifiers before a token exchange', () => {
    expect(() => assertPkceVerifier('too-short')).toThrow(IdentityContractError);
    expect(() => assertPkceVerifier(`${'a'.repeat(42)}!`)).toThrow('PKCE verifier');
  });

  it('makes SCIM deprovisioning idempotent', async () => {
    const active = new Set(['scim-1']);
    const directory: ScimDirectoryPort = {
      async upsertUser() {
        return localIdentity;
      },
      async deprovisionUser(id) {
        if (!active.delete(id)) return 'already_deprovisioned';
        return 'deprovisioned';
      }
    };
    const user = { id: 'scim-1', userName: 'former@selene.test', active: false };
    await expect(applyScimUser(directory, user)).resolves.toBe('deprovisioned');
    await expect(applyScimUser(directory, user)).resolves.toBe('already_deprovisioned');
  });

  it('redacts nested credentials, assertions, and session material from audit events', () => {
    expect(
      redactIdentityAuditEvent({
        occurredAt: '2026-07-24T00:00:00Z',
        action: 'login.failed',
        attributes: {
          provider: 'oidc',
          accessToken: 'never-log',
          nested: { samlAssertion: 'never-log' },
          safe: 'kept'
        }
      })
    ).toMatchObject({
      attributes: {
        provider: 'oidc',
        accessToken: '[REDACTED]',
        nested: { samlAssertion: '[REDACTED]' },
        safe: 'kept'
      }
    });
  });
});
