import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  IdentityContractError,
  applyScimUser,
  assertPkceVerifier,
  acceptOrganizationInvitation,
  createBreakGlassRecoveryAuditEvent,
  createIdentityAdministrationService,
  evaluateOrganizationSsoPolicy,
  findOrganizationForVerifiedEmail,
  identityContract,
  mayInviteGuest,
  redactIdentityAuditEvent,
  roleFromVerifiedGroups,
  sessionHasActiveMembership,
  validateBreakGlassRecovery,
  validateOidcAuthorizationCallback,
  type AuthenticatedIdentity,
  type IdentityAdministrationRepository,
  type OrganizationInvitation,
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

  it('discovers only a uniquely verified organization domain and enforces its SSO policy', () => {
    const domains = [
      { organizationId: 'org-1', domain: 'example.test', verifiedAt: '2026-07-24T00:00:00Z' },
      { organizationId: 'org-2', domain: 'other.test', verifiedAt: '2026-07-24T00:00:00Z' }
    ];
    expect(findOrganizationForVerifiedEmail('Person@EXAMPLE.test', domains)).toBe('org-1');
    expect(findOrganizationForVerifiedEmail('person@unverified.test', domains)).toBeUndefined();
    expect(
      evaluateOrganizationSsoPolicy(
        {
          organizationId: 'org-1',
          enforcement: 'required',
          allowedProviders: ['oidc'],
          allowedIssuers: ['https://id.example.test']
        },
        {
          organizationId: 'org-1',
          provider: 'oidc',
          issuer: 'https://id.example.test',
          email: 'person@example.test',
          providerAssertionVerified: true,
          emailVerified: true
        },
        domains
      )
    ).toEqual({ allowed: true });
    expect(
      evaluateOrganizationSsoPolicy(
        {
          organizationId: 'org-1',
          enforcement: 'required',
          allowedProviders: ['oidc'],
          allowedIssuers: ['https://id.example.test']
        },
        {
          organizationId: 'org-1',
          provider: 'oidc',
          issuer: 'https://id.example.test',
          email: 'person@example.test',
          providerAssertionVerified: false,
          emailVerified: true
        },
        domains
      )
    ).toEqual({ allowed: false, reason: 'UNVERIFIED_ASSERTION' });
    expect(
      evaluateOrganizationSsoPolicy(
        {
          organizationId: 'org-1',
          enforcement: 'required',
          allowedProviders: ['oidc'],
          allowedIssuers: ['https://id.example.test']
        },
        {
          organizationId: 'org-1',
          provider: 'local',
          email: 'person@example.test',
          providerAssertionVerified: true,
          emailVerified: true
        },
        domains
      )
    ).toEqual({ allowed: false, reason: 'SSO_REQUIRED' });
  });

  it('grants group-derived roles only for verified immutable provider group claims', () => {
    const mappings = [
      {
        id: 'mapping-editor',
        organizationId: 'org-1',
        provider: 'oidc' as const,
        issuer: 'https://id.example.test',
        externalGroupId: 'group-design',
        role: 'editor' as const
      },
      {
        id: 'mapping-admin',
        organizationId: 'org-1',
        provider: 'oidc' as const,
        issuer: 'https://id.example.test',
        externalGroupId: 'group-admin',
        role: 'admin' as const
      }
    ];
    expect(
      roleFromVerifiedGroups(
        {
          organizationId: 'org-1',
          provider: 'oidc',
          issuer: 'https://id.example.test',
          subject: 'subject-1',
          groups: ['group-design', 'group-admin'],
          verified: true
        },
        mappings
      )
    ).toBe('admin');
    expect(
      roleFromVerifiedGroups(
        {
          organizationId: 'org-1',
          provider: 'oidc',
          issuer: 'https://attacker.example.test',
          subject: 'subject-1',
          groups: ['group-admin'],
          verified: true
        },
        mappings
      )
    ).toBeUndefined();
    expect(
      roleFromVerifiedGroups(
        {
          organizationId: 'org-1',
          provider: 'oidc',
          issuer: 'https://id.example.test',
          subject: 'subject-1',
          groups: ['group-admin'],
          verified: false
        },
        mappings
      )
    ).toBeUndefined();
  });

  it('accepts only the intended verified invitee, while guests remain explicitly restricted', () => {
    const invitation: OrganizationInvitation = {
      id: 'invite-1',
      organizationId: 'org-1',
      email: 'guest@example.test',
      role: 'guest',
      tokenHash: 'a'.repeat(64),
      status: 'pending',
      expiresAt: '2026-07-25T00:00:00Z',
      createdBy: 'owner-1',
      createdAt: '2026-07-24T00:00:00Z'
    };
    expect(
      acceptOrganizationInvitation(
        invitation,
        {
          subjectId: 'guest-1',
          organizationId: 'org-1',
          email: 'GUEST@example.test',
          emailVerified: true
        },
        { organizationId: 'org-1', allowInvitedGuests: true },
        '2026-07-24T12:00:00Z'
      )
    ).toMatchObject({ accepted: true, membership: { role: 'guest' } });
    expect(
      acceptOrganizationInvitation(
        invitation,
        {
          subjectId: 'attacker',
          organizationId: 'org-1',
          email: 'attacker@example.test',
          emailVerified: true
        },
        { organizationId: 'org-1', allowInvitedGuests: true },
        '2026-07-24T12:00:00Z'
      )
    ).toEqual({ accepted: false, reason: 'EMAIL_MISMATCH' });
    expect(
      acceptOrganizationInvitation(
        invitation,
        {
          subjectId: 'guest-1',
          organizationId: 'org-1',
          email: 'guest@example.test',
          emailVerified: true
        },
        { organizationId: 'org-1', allowInvitedGuests: false },
        '2026-07-24T12:00:00Z'
      )
    ).toEqual({ accepted: false, reason: 'GUESTS_DISABLED' });
    expect(mayInviteGuest({ organizationId: 'org-1', allowInvitedGuests: false }, 'guest')).toBe(
      false
    );
    expect(mayInviteGuest({ organizationId: 'org-1', allowInvitedGuests: true }, 'viewer')).toBe(
      false
    );
  });

  it('invalidates active sessions when deprovisioning changes membership access', async () => {
    const session = {
      organizationId: 'org-1',
      subjectId: 'user-1',
      accessVersion: 3,
      expiresAt: '2026-07-25T00:00:00Z'
    };
    expect(
      sessionHasActiveMembership(
        session,
        { organizationId: 'org-1', subjectId: 'user-1', role: 'editor', accessVersion: 3 },
        '2026-07-24T00:00:00Z'
      )
    ).toBe(true);
    expect(
      sessionHasActiveMembership(
        session,
        {
          organizationId: 'org-1',
          subjectId: 'user-1',
          role: 'editor',
          accessVersion: 4,
          revokedAt: '2026-07-24T00:00:01Z'
        },
        '2026-07-24T00:00:02Z'
      )
    ).toBe(false);

    const events: unknown[] = [];
    const calls: string[] = [];
    const repository: IdentityAdministrationRepository = {
      async transaction(operation) {
        return operation(repository);
      },
      async findInvitationByTokenHash() {
        return undefined;
      },
      async readGuestReviewPolicy(organizationId) {
        return { organizationId, allowInvitedGuests: false };
      },
      async acceptInvitation() {
        return true;
      },
      async upsertMembership() {},
      async recordBreakGlassRecovery() {},
      async revokeMemberships() {
        calls.push('membership');
      },
      async revokeSessions() {
        calls.push('session');
      },
      async recordAudit(event) {
        events.push(event);
      }
    };
    const administration = createIdentityAdministrationService(
      repository,
      () => '2026-07-24T00:00:00Z'
    );
    await administration.deprovision('org-1', 'user-1');
    expect(calls).toEqual(['membership', 'session']);
    expect(events).toMatchObject([{ action: 'scim.deprovisioned', subjectId: 'user-1' }]);
  });

  it('uses one transaction-scoped unit and one clock sample for invitation acceptance', async () => {
    const invitation: OrganizationInvitation = {
      id: 'invite-1',
      organizationId: 'org-1',
      email: 'member@example.test',
      role: 'viewer',
      tokenHash: 'b'.repeat(64),
      status: 'pending',
      expiresAt: '2026-07-25T00:00:00Z',
      createdBy: 'owner-1',
      createdAt: '2026-07-24T00:00:00Z'
    };
    const calls: string[] = [];
    const unit: IdentityAdministrationRepository = {
      async transaction(operation) {
        return operation(unit);
      },
      async findInvitationByTokenHash() {
        calls.push('unit.find');
        return invitation;
      },
      async readGuestReviewPolicy(organizationId) {
        calls.push('unit.policy');
        return { organizationId, allowInvitedGuests: false };
      },
      async acceptInvitation() {
        calls.push('unit.accept');
        return true;
      },
      async upsertMembership() {
        calls.push('unit.membership');
      },
      async recordBreakGlassRecovery() {
        calls.push('unit.break-glass');
      },
      async revokeMemberships() {},
      async revokeSessions() {},
      async recordAudit(event) {
        calls.push('unit.audit');
        expect(event).toMatchObject({
          action: 'invitation.accepted',
          attributes: { organizationId: 'org-1', invitationId: invitation.id }
        });
      }
    };
    const root: IdentityAdministrationRepository = {
      ...unit,
      async transaction(operation) {
        calls.push('root.transaction');
        return operation(unit);
      },
      async findInvitationByTokenHash() {
        throw new Error('ambient repository access');
      }
    };
    let clockCalls = 0;
    const service = createIdentityAdministrationService(root, () => {
      clockCalls += 1;
      return '2026-07-24T12:00:00Z';
    });
    await expect(
      service.acceptInvitation(invitation.tokenHash, {
        subjectId: 'user-1',
        organizationId: 'org-1',
        email: invitation.email,
        emailVerified: true
      })
    ).resolves.toMatchObject({ accepted: true });
    expect(clockCalls).toBe(1);
    expect(calls).toEqual([
      'root.transaction',
      'unit.find',
      'unit.policy',
      'unit.membership',
      'unit.accept',
      'unit.audit'
    ]);
  });

  it('aborts invitation acceptance when its conditional persistence transition affects no row', async () => {
    const invitation: OrganizationInvitation = {
      id: 'invite-raced',
      organizationId: 'org-1',
      email: 'member@example.test',
      role: 'viewer',
      tokenHash: 'c'.repeat(64),
      status: 'pending',
      expiresAt: '2026-07-25T00:00:00Z',
      createdBy: 'owner-1',
      createdAt: '2026-07-24T00:00:00Z'
    };
    const repository: IdentityAdministrationRepository = {
      async transaction(operation) {
        return operation(repository);
      },
      async findInvitationByTokenHash() {
        return invitation;
      },
      async readGuestReviewPolicy(organizationId) {
        return { organizationId, allowInvitedGuests: false };
      },
      async acceptInvitation() {
        return false;
      },
      async upsertMembership() {},
      async recordBreakGlassRecovery() {},
      async revokeMemberships() {},
      async revokeSessions() {},
      async recordAudit() {
        throw new Error('audit must not run after a failed transition');
      }
    };
    await expect(
      createIdentityAdministrationService(
        repository,
        () => '2026-07-24T12:00:00Z'
      ).acceptInvitation(invitation.tokenHash, {
        subjectId: 'user-1',
        organizationId: 'org-1',
        email: invitation.email,
        emailVerified: true
      })
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING' });
  });

  it('requires a short-lived, auditable break-glass recovery record', async () => {
    const request = {
      organizationId: 'org-1',
      subjectId: 'recovery-owner',
      caseId: 'INC-123',
      reason: 'All ordinary organization owners are unavailable.',
      expiresAt: '2026-07-24T23:00:00Z'
    };
    expect(() => validateBreakGlassRecovery(request, '2026-07-24T00:00:00Z')).not.toThrow();
    expect(
      createBreakGlassRecoveryAuditEvent(request, 'security-admin', '2026-07-24T00:00:00Z')
    ).toMatchObject({
      action: 'break_glass.recovery_started',
      subjectId: 'recovery-owner',
      attributes: { caseId: 'INC-123', actorId: 'security-admin' }
    });
    expect(() =>
      validateBreakGlassRecovery(
        {
          organizationId: 'org-1',
          subjectId: 'recovery-owner',
          caseId: '',
          reason: 'too short',
          expiresAt: '2026-07-26T00:00:00Z'
        },
        '2026-07-24T00:00:00Z'
      )
    ).toThrow('Break-glass recovery');

    const calls: string[] = [];
    const repository: IdentityAdministrationRepository = {
      async transaction(operation) {
        return operation(repository);
      },
      async findInvitationByTokenHash() {
        return undefined;
      },
      async readGuestReviewPolicy(organizationId) {
        return { organizationId, allowInvitedGuests: false };
      },
      async acceptInvitation() {
        return true;
      },
      async upsertMembership() {
        calls.push('membership');
      },
      async recordBreakGlassRecovery() {
        calls.push('recovery');
      },
      async revokeMemberships() {},
      async revokeSessions() {},
      async recordAudit() {
        calls.push('audit');
      }
    };
    await createIdentityAdministrationService(
      repository,
      () => '2026-07-24T00:00:00Z'
    ).recoverBreakGlass(request, 'security-admin');
    expect(calls).toEqual(['recovery', 'audit']);
  });
});
