import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { createCollaborationApplication } from './app.js';
import { readServiceEnvironment } from './env.js';
import { createBffIdentityProvider } from './oidc-bff.js';
import { BunPostgresBffStore } from './postgres-bff-store.js';
import { BunPostgresCollaborationRepository } from './postgres-repository.js';
import {
  HostedOidcBff,
  createDirectHostedOidcBffEffects,
  type OidcRuntime
} from '@selene/identity-runtime';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('PostgreSQL integration requires DATABASE_URL');

const ids = {
  organizationA: '10000000-0000-4000-8000-000000000001',
  organizationB: '10000000-0000-4000-8000-000000000002',
  userA: '20000000-0000-4000-8000-000000000001',
  userB: '20000000-0000-4000-8000-000000000002',
  invitedUser: '20000000-0000-4000-8000-000000000003',
  invitation: '90000000-0000-4000-8000-000000000001',
  duplicateInvitation: '90000000-0000-4000-8000-000000000002',
  crossTenantRecovery: '90000000-0000-4000-8000-000000000003',
  pendingInvitation: '90000000-0000-4000-8000-000000000004',
  projectA: '30000000-0000-4000-8000-000000000001',
  projectB: '30000000-0000-4000-8000-000000000002',
  revisionA1: '40000000-0000-4000-8000-000000000001',
  revisionB1: '40000000-0000-4000-8000-000000000002',
  baseline: '50000000-0000-4000-8000-000000000001',
  thread: '60000000-0000-4000-8000-000000000001',
  reviewThread: '60000000-0000-4000-8000-000000000002',
  hostedReviewThread: '60000000-0000-4000-8000-000000000006',
  aiRequest: '60000000-0000-4000-8000-000000000003',
  annotation: '60000000-0000-4000-8000-000000000004',
  aiRace: '60000000-0000-4000-8000-000000000005',
  comment: '70000000-0000-4000-8000-000000000001',
  change: '80000000-0000-4000-8000-000000000001'
} as const;

const firstFingerprint = 'a'.repeat(64);
const secondFingerprint = 'b'.repeat(64);
const migrationsDirectory = new URL('../../../packages/collaboration/migrations/', import.meta.url);

const environment = readServiceEnvironment({
  ...process.env,
  COLLABORATION_STORE: 'postgres',
  DATABASE_URL: databaseUrl,
  CORS_ORIGINS: 'https://review.example.test',
  COLLABORATION_SHARE_SECRET: process.env.COLLABORATION_SHARE_SECRET ?? 'a'.repeat(32),
  COLLABORATION_PROXY_SECRET: process.env.COLLABORATION_PROXY_SECRET ?? 'p'.repeat(32)
});
const headers = {
  'content-type': 'application/json',
  'x-selene-user-id': ids.userA,
  'x-selene-proxy-secret': environment.proxySecret
};

const sql = new Bun.SQL(databaseUrl);
const repository = new BunPostgresCollaborationRepository(sql);
const application = createCollaborationApplication(environment, repository, repository, repository);
const bffRuntime: OidcRuntime = {
  async begin() {
    throw new Error('not used by PostgreSQL persistence test');
  },
  async exchange() {
    throw new Error('not used by PostgreSQL persistence test');
  },
  async revoke() {},
  async endSession() {
    return undefined;
  }
};

async function clearProject(projectId: string): Promise<void> {
  await sql`DELETE FROM collaboration_events WHERE project_id = ${projectId}`;
  await sql`DELETE FROM developer_annotations WHERE project_id = ${projectId}`;
  await sql`DELETE FROM ai_change_requests WHERE project_id = ${projectId}`;
  await sql`DELETE FROM review_threads WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_baseline_changes WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_review_states WHERE project_id = ${projectId}`;
  await sql`DELETE FROM design_baselines WHERE project_id = ${projectId}`;
  await sql`DELETE FROM comment_reactions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${projectId})`;
  await sql`DELETE FROM comment_mentions WHERE comment_id IN (SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.project_id = ${projectId})`;
  await sql`DELETE FROM comments WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ${projectId})`;
  await sql`DELETE FROM threads WHERE project_id = ${projectId}`;
  await sql`DELETE FROM approvals WHERE revision_id IN (SELECT id FROM revisions WHERE project_id = ${projectId})`;
  await sql`DELETE FROM revisions WHERE project_id = ${projectId}`;
  await sql`DELETE FROM share_links WHERE project_id = ${projectId}`;
  await sql`DELETE FROM idempotency_keys WHERE scope LIKE ${`%${projectId}%`}`;
  await sql`DELETE FROM projects WHERE id = ${projectId}`;
}

async function clearFixture(): Promise<void> {
  await clearProject(ids.projectA);
  await clearProject(ids.projectB);
  await sql`DELETE FROM oidc_bff_sessions WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB}) OR subject IN (SELECT external_subject FROM users WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB}))`;
  await sql`DELETE FROM break_glass_recoveries WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organization_invitations WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organization_guest_review_policies WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM identity_group_role_mappings WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organization_sso_policies WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organization_verified_domains WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM audit_events WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM memberships WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM users WHERE organization_id IN (${ids.organizationA}, ${ids.organizationB})`;
  await sql`DELETE FROM organizations WHERE id IN (${ids.organizationA}, ${ids.organizationB})`;
}

beforeAll(async () => {
  await clearFixture();
  await sql`INSERT INTO organizations (id, slug, name) VALUES (${ids.organizationA}, 'postgres-a', 'Postgres A'), (${ids.organizationB}, 'postgres-b', 'Postgres B')`;
  await sql`INSERT INTO users (id, organization_id, external_subject, email, display_name) VALUES (${ids.userA}, ${ids.organizationA}, 'https://idp.example.test|owner-a', 'owner-a@example.test', 'Owner A'), (${ids.userB}, ${ids.organizationB}, 'https://idp.example.test|owner-b', 'owner-b@example.test', 'Owner B')`;
  await sql`INSERT INTO memberships (organization_id, user_id, role) VALUES (${ids.organizationA}, ${ids.userA}, 'owner'), (${ids.organizationB}, ${ids.userB}, 'owner')`;
  await sql`INSERT INTO projects (id, organization_id, name) VALUES (${ids.projectA}, ${ids.organizationA}, 'Postgres project A'), (${ids.projectB}, ${ids.organizationB}, 'Postgres project B')`;
  await repository.appendRevision({
    id: ids.revisionB1,
    projectId: ids.projectB,
    sequence: 1,
    content: { project: 'B' },
    contentSha256: 'c'.repeat(64),
    scenarioIds: ['default'],
    createdBy: ids.userB,
    createdAt: '2026-07-23T20:00:00Z'
  });
});

afterAll(async () => {
  await clearFixture();
  await repository.close({ timeout: 0 });
});

describe('PostgreSQL collaboration persistence', () => {
  it('upgrades legacy duplicate pending invitations by revoking every superseded token', async () => {
    const schema = 'identity_duplicate_invitation_upgrade_fixture';
    const legacyMigrations = await Promise.all(
      [
        '0001_collaboration.sql',
        '0002_realtime_events.sql',
        '0003_design_baselines.sql',
        '0004_project_ownership_foreign_keys.sql',
        '0005_review_aggregates.sql',
        '0006_public_contract_hardening.sql',
        '0007_ai_undo_result_compatibility.sql',
        '0008_oidc_bff_sessions.sql',
        '0009_organization_identity_administration.sql'
      ].map((fileName) => readFile(new URL(fileName, migrationsDirectory), 'utf8'))
    );
    const hardeningMigration = await readFile(
      new URL('0010_identity_tenant_binding_hardening.sql', migrationsDirectory),
      'utf8'
    );
    await sql.transaction(async (transaction) => {
      await transaction.unsafe(`CREATE SCHEMA ${schema}`);
      await transaction.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      await legacyMigrations.reduce(
        (applied, migration) => applied.then(() => transaction.unsafe(migration)),
        Promise.resolve()
      );
      const organizationId = '91000000-0000-4000-8000-000000000001';
      const userId = '92000000-0000-4000-8000-000000000001';
      const olderInvitation = '93000000-0000-4000-8000-000000000001';
      const newerInvitation = '93000000-0000-4000-8000-000000000002';
      await transaction`INSERT INTO organizations (id, slug, name) VALUES (${organizationId}, 'legacy-duplicates', 'Legacy duplicates')`;
      await transaction`INSERT INTO users (id, organization_id, email, display_name) VALUES (${userId}, ${organizationId}, 'owner@legacy.test', 'Legacy owner')`;
      await transaction`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by, created_at) VALUES (${olderInvitation}, ${organizationId}, 'invitee@legacy.test', 'admin', ${'a'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${userId}, '2026-01-01T00:00:00Z'), (${newerInvitation}, ${organizationId}, 'invitee@legacy.test', 'viewer', ${'b'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${userId}, '2026-01-02T00:00:00Z')`;

      await transaction.unsafe(hardeningMigration);

      const invitations = await transaction<
        { id: string; status: string; tokenHash: string; revokedAt: Date | null }[]
      >`SELECT id, status, token_hash AS "tokenHash", revoked_at AS "revokedAt" FROM organization_invitations WHERE organization_id = ${organizationId} ORDER BY created_at`;
      expect(invitations).toHaveLength(2);
      expect(invitations[0]).toMatchObject({
        id: olderInvitation,
        status: 'revoked',
        tokenHash: 'a'.repeat(64)
      });
      expect(invitations[0]?.revokedAt).not.toBeNull();
      expect(invitations[1]).toMatchObject({
        id: newerInvitation,
        status: 'pending',
        tokenHash: 'b'.repeat(64),
        revokedAt: null
      });
      const pending = await transaction<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM organization_invitations
        WHERE organization_id = ${organizationId}
          AND email = 'invitee@legacy.test'
          AND status = 'pending'`;
      expect(pending[0]?.count).toBe(1);
      await transaction.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    });
  });

  it('upgrades legacy review threads without fabricating reopen attribution', async () => {
    const schema = 'review_reopen_attribution_upgrade_fixture';
    const legacyMigrations = await Promise.all(
      [
        '0001_collaboration.sql',
        '0002_realtime_events.sql',
        '0003_design_baselines.sql',
        '0004_project_ownership_foreign_keys.sql',
        '0005_review_aggregates.sql',
        '0006_public_contract_hardening.sql',
        '0007_ai_undo_result_compatibility.sql',
        '0008_oidc_bff_sessions.sql',
        '0009_organization_identity_administration.sql',
        '0010_identity_tenant_binding_hardening.sql'
      ].map((fileName) => readFile(new URL(fileName, migrationsDirectory), 'utf8'))
    );
    const reopenMigration = await readFile(
      new URL('0011_review_thread_reopen_attribution.sql', migrationsDirectory),
      'utf8'
    );
    await sql.transaction(async (transaction) => {
      await transaction.unsafe(`CREATE SCHEMA ${schema}`);
      await transaction.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      await legacyMigrations.reduce(
        (applied, migration) => applied.then(() => transaction.unsafe(migration)),
        Promise.resolve()
      );
      const organizationId = '94000000-0000-4000-8000-000000000001';
      const projectId = '95000000-0000-4000-8000-000000000001';
      const revisionId = '96000000-0000-4000-8000-000000000001';
      const reviewThreadId = '97000000-0000-4000-8000-000000000001';
      const designerId = '98000000-0000-4000-8000-000000000001';
      const reviewerId = '99000000-0000-4000-8000-000000000001';
      await transaction`INSERT INTO organizations (id, slug, name) VALUES (${organizationId}, 'legacy-reopen', 'Legacy reopen')`;
      await transaction`INSERT INTO users (id, organization_id, email, display_name) VALUES (${designerId}, ${organizationId}, 'designer@legacy-reopen.test', 'Legacy designer'), (${reviewerId}, ${organizationId}, 'reviewer@legacy-reopen.test', 'Legacy reviewer')`;
      await transaction`INSERT INTO projects (id, organization_id, name) VALUES (${projectId}, ${organizationId}, 'Legacy project')`;
      await transaction`INSERT INTO revisions (id, project_id, sequence, content, content_sha256, scenario_ids, created_by, created_at) VALUES (${revisionId}, ${projectId}, 1, '{}'::jsonb, ${'d'.repeat(64)}, '[]'::jsonb, ${designerId}, '2026-01-01T00:00:00Z')`;
      await transaction`INSERT INTO review_threads (id, project_id, revision_id, anchor, messages, deep_link, lifecycle, created_by, created_at, resolved_at, resolved_by) VALUES (${reviewThreadId}, ${projectId}, ${revisionId}, '{}'::jsonb, '[]'::jsonb, '/legacy-review', 'resolved', ${designerId}, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', ${reviewerId})`;

      await transaction.unsafe(reopenMigration);

      const upgraded = await transaction<
        { reopenedAt: Date | null; reopenedBy: string | null }[]
      >`SELECT reopened_at AS "reopenedAt", reopened_by AS "reopenedBy" FROM review_threads WHERE id = ${reviewThreadId}`;
      expect(upgraded).toEqual([{ reopenedAt: null, reopenedBy: null }]);
      await transaction`
        UPDATE review_threads
        SET lifecycle = 'open', resolved_at = NULL, resolved_by = NULL,
            reopened_at = '2026-01-01T00:02:00Z', reopened_by = ${reviewerId}
        WHERE id = ${reviewThreadId} AND project_id = ${projectId}`;
      const reopened = await transaction<
        { lifecycle: string; reopenedAt: Date; reopenedBy: string }[]
      >`SELECT lifecycle, reopened_at AS "reopenedAt", reopened_by AS "reopenedBy" FROM review_threads WHERE id = ${reviewThreadId} AND project_id = ${projectId}`;
      expect(reopened[0]).toMatchObject({
        lifecycle: 'open',
        reopenedBy: reviewerId
      });
      expect(reopened[0]?.reopenedAt.toISOString()).toBe('2026-01-01T00:02:00.000Z');
      await transaction.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    });
  });

  it('binds a new BFF session once, preserves it, and denies it after an access change or revocation', async () => {
    const store = new BunPostgresBffStore(sql);
    const bff = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(bffRuntime, store),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://app.example.test/auth/callback'
    });
    const identity = createBffIdentityProvider(bff, {
      resolveExternalSubject: (session) => repository.resolveBffIdentity(session)
    });
    const sessionId = 'postgres-bff-session-12345678901234567890';
    await store.createSession({
      id: sessionId,
      subject: 'https://idp.example.test|owner-a',
      expiresAt: Date.now() + 60_000,
      tokens: {
        subjectKey: 'https://idp.example.test|owner-a',
        claims: { sub: 'owner-a' },
        expiresAt: Date.now() + 60_000
      }
    });
    const request = new Request('https://service.test/v1/projects', {
      headers: { cookie: `__Host-selene_session=${sessionId}` }
    });
    await expect(identity.authenticate(request)).resolves.toBe(ids.userA);
    await expect(store.readSession(sessionId)).resolves.toMatchObject({
      organizationId: ids.organizationA,
      accessVersion: 1
    });
    await expect(identity.authenticate(request)).resolves.toBe(ids.userA);
    await sql`UPDATE memberships SET access_version = access_version + 1 WHERE organization_id = ${ids.organizationA} AND user_id = ${ids.userA}`;
    await expect(identity.authenticate(request)).resolves.toBeUndefined();
    await expect(store.readSession(sessionId)).resolves.toBeUndefined();

    const sessionIdAfterBump = 'postgres-bff-session-after-bump-123456789012';
    await store.createSession({
      id: sessionIdAfterBump,
      subject: 'https://idp.example.test|owner-a',
      expiresAt: Date.now() + 60_000,
      tokens: {
        subjectKey: 'https://idp.example.test|owner-a',
        claims: { sub: 'owner-a' },
        expiresAt: Date.now() + 60_000
      }
    });
    const afterBumpRequest = new Request('https://service.test/v1/projects', {
      headers: { cookie: `__Host-selene_session=${sessionIdAfterBump}` }
    });
    await expect(identity.authenticate(afterBumpRequest)).resolves.toBe(ids.userA);
    await repository.revokeMemberships(ids.organizationA, ids.userA, '2026-07-24T12:00:00Z');
    await expect(identity.authenticate(afterBumpRequest)).resolves.toBeUndefined();
    await sql`UPDATE memberships SET revoked_at = NULL, access_version = 1 WHERE organization_id = ${ids.organizationA} AND user_id = ${ids.userA}`;
  });

  it('accepts an invitation with membership and redacted audit history in one transaction', async () => {
    await sql`INSERT INTO users (id, organization_id, email, display_name) VALUES (${ids.invitedUser}, ${ids.organizationA}, 'invited@example.test', 'Invited')`;
    await sql`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by) VALUES (${ids.invitation}, ${ids.organizationA}, 'invited@example.test', 'viewer', ${'f'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${ids.userA})`;
    const { createIdentityAdministrationService } = await import('@selene/collaboration/identity');
    const administration = createIdentityAdministrationService(
      repository,
      () => '2026-07-24T12:00:00Z'
    );
    await expect(
      administration.acceptInvitation('f'.repeat(64), {
        subjectId: ids.invitedUser,
        organizationId: ids.organizationA,
        email: 'invited@example.test',
        emailVerified: true
      })
    ).resolves.toMatchObject({ accepted: true, membership: { role: 'viewer' } });
    const rows = await sql<
      {
        status: string;
        role: string;
        action: string;
        metadata: string;
      }[]
    >`
      SELECT i.status, m.role, a.action, a.metadata
      FROM organization_invitations i
      JOIN memberships m ON m.organization_id = i.organization_id AND m.user_id = ${ids.invitedUser}
      JOIN audit_events a ON a.organization_id = i.organization_id AND a.action = 'invitation.accepted'
      WHERE i.id = ${ids.invitation}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'accepted',
      role: 'viewer',
      action: 'invitation.accepted'
    });
    expect(JSON.parse(rows[0]?.metadata ?? '')).toEqual({
      organizationId: ids.organizationA,
      invitationId: ids.invitation
    });
  });

  it('rejects cross-organization membership/recovery grants and duplicate pending invitations', async () => {
    const mustReject = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch {
        return;
      }
      throw new Error('Expected PostgreSQL to reject a cross-organization write');
    };
    await mustReject(
      sql`INSERT INTO memberships (organization_id, user_id, role) VALUES (${ids.organizationA}, ${ids.userB}, 'viewer')`
    );
    await mustReject(
      sql`INSERT INTO break_glass_recoveries (id, organization_id, subject_id, case_id, reason, expires_at) VALUES (${ids.crossTenantRecovery}, ${ids.organizationA}, ${ids.userB}, 'INC-CROSS', 'Cross-tenant recovery must never be permitted.', '2030-01-01T00:00:00Z')`
    );
    await sql`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by) VALUES (${ids.pendingInvitation}, ${ids.organizationA}, 'pending@example.test', 'viewer', ${'d'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${ids.userA})`;
    await mustReject(
      sql`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by) VALUES (${ids.duplicateInvitation}, ${ids.organizationA}, 'pending@example.test', 'viewer', ${'e'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${ids.userA})`
    );
    await mustReject(
      sql`INSERT INTO organization_verified_domains (organization_id, domain, verified_at, verified_by) VALUES (${ids.organizationA}, 'cross-verifier.example.test', now(), ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO organization_sso_policies (organization_id, enforcement, updated_by) VALUES (${ids.organizationA}, 'required', ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO organization_guest_review_policies (organization_id, updated_by) VALUES (${ids.organizationA}, ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO identity_group_role_mappings (id, organization_id, provider, issuer, external_group_id, role, created_by) VALUES ('90000000-0000-4000-8000-000000000010', ${ids.organizationA}, 'oidc', 'https://id.example.test', 'cross-group', 'viewer', ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by) VALUES ('90000000-0000-4000-8000-000000000011', ${ids.organizationA}, 'cross-creator@example.test', 'viewer', ${'1'.repeat(64)}, 'pending', '2030-01-01T00:00:00Z', ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO organization_invitations (id, organization_id, email, role, token_hash, status, expires_at, created_by, accepted_by, accepted_at) VALUES ('90000000-0000-4000-8000-000000000012', ${ids.organizationA}, 'cross-acceptor@example.test', 'viewer', ${'2'.repeat(64)}, 'accepted', '2030-01-01T00:00:00Z', ${ids.userA}, ${ids.userB}, now())`
    );
    await mustReject(
      sql`INSERT INTO break_glass_recoveries (id, organization_id, subject_id, case_id, reason, expires_at, created_by) VALUES ('90000000-0000-4000-8000-000000000013', ${ids.organizationA}, ${ids.userA}, 'INC-CREATOR', 'Cross-tenant recovery creator must never be permitted.', '2030-01-01T00:00:00Z', ${ids.userB})`
    );
    await mustReject(
      sql`INSERT INTO audit_events (id, organization_id, actor_id, action, resource_type, resource_id, metadata) VALUES ('90000000-0000-4000-8000-000000000014', ${ids.organizationA}, ${ids.userB}, 'cross.actor', 'identity', '90000000-0000-4000-8000-000000000015', '{}'::jsonb)`
    );
  });

  it('applies migrations 0001-0013 and persists baseline lifecycle across restart and restore', async () => {
    const migrations = await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations
      WHERE name IN ('0001_collaboration', '0002_realtime_events', '0003_design_baselines', '0004_project_ownership_foreign_keys', '0005_review_aggregates', '0006_public_contract_hardening', '0007_ai_undo_result_compatibility', '0008_oidc_bff_sessions', '0009_organization_identity_administration', '0010_identity_tenant_binding_hardening', '0011_review_thread_reopen_attribution', '0012_review_thread_cas', '0013_hosted_review_binding')
      ORDER BY name`;
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_collaboration',
      '0002_realtime_events',
      '0003_design_baselines',
      '0004_project_ownership_foreign_keys',
      '0005_review_aggregates',
      '0006_public_contract_hardening',
      '0007_ai_undo_result_compatibility',
      '0008_oidc_bff_sessions',
      '0009_organization_identity_administration',
      '0010_identity_tenant_binding_hardening',
      '0011_review_thread_reopen_attribution',
      '0012_review_thread_cas',
      '0013_hosted_review_binding'
    ]);

    const firstRevision = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.revisionA1,
          content: { project: 'A', title: 'Before baseline' },
          contentSha256: firstFingerprint,
          scenarioIds: ['default']
        })
      })
    );
    expect(firstRevision.status).toBe(201);

    const reviewThread = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.reviewThread,
          deepLink: 'https://review.example.test/projects/a',
          body: 'Keep this table aligned with the baseline.',
          mentionedUserIds: [],
          anchor: {
            evidence: {
              artifactId: 'artifact-a',
              screenId: 'orders',
              revisionId: ids.revisionA1,
              revisionFingerprint: firstFingerprint,
              viewport: { width: 1440, height: 900, zoom: 1 },
              scenarioId: 'default'
            },
            lifecycle: 'current',
            target: { kind: 'region', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 } }
          }
        })
      })
    );
    expect(reviewThread.status).toBe(201);
    const persistedReview = (await reviewThread.json()) as {
      id: string;
      messages: readonly { id: string }[];
    };
    const contendReviewMessages = async (operations: readonly (() => Promise<unknown>)[]) => {
      const lock = new Bun.SQL(databaseUrl);
      try {
        let started: Promise<unknown>[] = [];
        await lock.transaction(async (transaction) => {
          await transaction`SELECT id FROM review_threads WHERE id = ${persistedReview.id} FOR UPDATE`;
          started = operations.map((operation) => operation());
          await Bun.sleep(50);
        });
        return Promise.allSettled(started);
      } finally {
        await lock.close({ timeout: 0 });
      }
    };
    const competingRepository = new BunPostgresCollaborationRepository(new Bun.SQL(databaseUrl));
    try {
      const appendRace = await contendReviewMessages([
        () =>
          repository.appendReviewThreadMessage(persistedReview.id, {
            id: 'concurrent-reply-a',
            body: 'Concurrent reply A.',
            createdBy: 'concurrent-a',
            createdAt: '2026-07-23T20:00:01Z',
            mentionedUserIds: [],
            reactions: [],
            readBy: []
          }),
        () =>
          competingRepository.appendReviewThreadMessage(persistedReview.id, {
            id: 'concurrent-reply-b',
            body: 'Concurrent reply B.',
            createdBy: 'concurrent-b',
            createdAt: '2026-07-23T20:00:01Z',
            mentionedUserIds: [],
            reactions: [],
            readBy: []
          })
      ]);
      expect(appendRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(appendRace.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' }
      });
      const afterAppend = await repository.getReviewThread(persistedReview.id);
      if (!afterAppend) throw new Error('Expected persisted review thread');
      expect(afterAppend.messages).toHaveLength(2);
      expect(
        afterAppend.messages.filter(
          (message) => message.id === 'concurrent-reply-a' || message.id === 'concurrent-reply-b'
        )
      ).toHaveLength(1);

      const reactionRace = await contendReviewMessages([
        () =>
          repository.reactToReviewThreadMessage(
            persistedReview.id,
            persistedReview.messages[0]!.id,
            '🔥',
            'reaction-a'
          ),
        () =>
          competingRepository.reactToReviewThreadMessage(
            persistedReview.id,
            persistedReview.messages[0]!.id,
            '🔥',
            'reaction-b'
          )
      ]);
      expect(reactionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(reactionRace.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' }
      });
      const afterReaction = await repository.getReviewThread(persistedReview.id);
      if (!afterReaction) throw new Error('Expected persisted review thread');
      expect(afterReaction.messages[0]?.reactions).toContainEqual(
        expect.objectContaining({ emoji: '🔥', userIds: expect.any(Array) })
      );
      expect(
        afterReaction.messages[0]?.reactions.find((reaction) => reaction.emoji === '🔥')?.userIds
      ).toHaveLength(1);

      const readRace = await contendReviewMessages([
        () =>
          repository.setReviewThreadMessageRead(
            persistedReview.id,
            persistedReview.messages[0]!.id,
            'reader-a',
            true
          ),
        () =>
          competingRepository.setReviewThreadMessageRead(
            persistedReview.id,
            persistedReview.messages[0]!.id,
            'reader-b',
            true
          )
      ]);
      expect(readRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(readRace.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' }
      });
      const afterRead = await repository.getReviewThread(persistedReview.id);
      if (!afterRead) throw new Error('Expected persisted review thread');
      expect(
        afterRead.messages[0]?.readBy.filter(
          (userId) => userId === 'reader-a' || userId === 'reader-b'
        )
      ).toHaveLength(1);
    } finally {
      await competingRepository.close({ timeout: 0 });
    }
    const resolvedReview = await application.fetch(
      new Request(`https://service.test/v1/review-threads/${ids.reviewThread}/resolve`, {
        method: 'POST',
        headers
      })
    );
    await expect(resolvedReview.json()).resolves.toMatchObject({ lifecycle: 'resolved' });
    await expect(
      repository.reopenReviewThread(ids.reviewThread, ids.userA, '2099-07-23T20:01:00Z')
    ).resolves.toMatchObject({
      lifecycle: 'open',
      reopenedAt: '2099-07-23T20:01:00.000Z',
      reopenedBy: ids.userA
    });
    await expect(
      repository.resolveReviewThread(ids.reviewThread, ids.userA, '2099-07-23T20:02:00Z')
    ).resolves.toMatchObject({
      lifecycle: 'resolved',
      resolvedAt: '2099-07-23T20:02:00.000Z',
      resolvedBy: ids.userA,
      reopenedAt: '2099-07-23T20:01:00.000Z',
      reopenedBy: ids.userA
    });
    const currentAnchor = {
      evidence: {
        artifactId: 'artifact-a',
        screenId: 'orders',
        revisionId: ids.revisionA1,
        revisionFingerprint: firstFingerprint,
        viewport: { width: 1440, height: 900, zoom: 1 },
        scenarioId: 'default'
      },
      lifecycle: 'current',
      target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
    };
    const moveLock = new Bun.SQL(databaseUrl);
    const competingMover = new BunPostgresCollaborationRepository(new Bun.SQL(databaseUrl));
    try {
      let moves: Promise<unknown>[] = [];
      await moveLock.transaction(async (transaction) => {
        await transaction`SELECT id FROM review_threads WHERE id = ${persistedReview.id} FOR UPDATE`;
        moves = [
          repository.moveReviewThread(
            persistedReview.id,
            {
              ...currentAnchor,
              lifecycle: 'current',
              target: { kind: 'point', point: { x: 0.2, y: 0.2 } }
            },
            'mover-a',
            '2026-07-23T20:02:00Z'
          ),
          competingMover.moveReviewThread(
            persistedReview.id,
            {
              ...currentAnchor,
              lifecycle: 'current',
              target: { kind: 'point', point: { x: 0.8, y: 0.8 } }
            },
            'mover-b',
            '2026-07-23T20:02:00Z'
          )
        ];
        await Bun.sleep(50);
      });
      const moveRace = await Promise.allSettled(moves);
      expect(moveRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(moveRace.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' }
      });
    } finally {
      await moveLock.close({ timeout: 0 });
      await competingMover.close({ timeout: 0 });
    }
    const aiRequest = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/ai-change-requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.aiRequest,
          anchor: currentAnchor,
          instruction: 'Make the table heading clearer.',
          provider: { providerId: 'postgres-test-provider', capability: 'design-edit' }
        })
      })
    );
    expect(aiRequest.status).toBe(201);
    const started = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'start' })
      })
    );
    expect(started.status).toBe(200);
    const failed = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'fail', failureReason: 'controlled failure' })
      })
    );
    expect(failed.status).toBe(200);
    const foreignResult = await application.fetch(
      new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'apply',
          result: {
            revisionId: ids.revisionB1,
            revisionFingerprint: 'c'.repeat(64),
            diff: 'cross-project patch',
            completedAt: '2026-07-23T20:00:00Z'
          }
        })
      })
    );
    expect(foreignResult.status).toBe(404);
    for (const body of [
      { action: 'retry' },
      { action: 'start' },
      {
        action: 'apply',
        result: {
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint,
          diff: 'applied test patch',
          completedAt: '2026-07-23T20:00:00Z'
        }
      },
      {
        action: 'undo',
        undoResult: {
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint,
          diff: 'compensating test patch',
          completedAt: '2026-07-23T20:01:00Z'
        }
      }
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const transition = await application.fetch(
        new Request(`https://service.test/v1/ai-change-requests/${ids.aiRequest}/transition`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        })
      );
      expect(transition.status).toBe(200);
    }
    const listedAI = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/ai-change-requests`, {
        headers
      })
    );
    await expect(listedAI.json()).resolves.toMatchObject({
      requests: [expect.objectContaining({ id: ids.aiRequest, lifecycle: 'undone' })]
    });
    const raceAnchor = {
      ...currentAnchor,
      lifecycle: 'current' as const,
      target: { kind: 'point' as const, point: { x: 0.4, y: 0.4 } }
    };
    const raceRequest = {
      id: ids.aiRace,
      projectId: ids.projectA,
      anchor: raceAnchor,
      instruction: 'Race apply and failure transitions.',
      provider: { providerId: 'postgres-test-provider', capability: 'design-edit' },
      baseRevision: { id: ids.revisionA1, fingerprint: firstFingerprint },
      lifecycle: 'running' as const,
      createdBy: ids.userA,
      createdAt: '2026-07-23T20:03:00Z',
      updatedAt: '2026-07-23T20:03:00Z'
    };
    await repository.createAIChangeRequest(raceRequest);
    const aiLock = new Bun.SQL(databaseUrl);
    const competingAIRepository = new BunPostgresCollaborationRepository(new Bun.SQL(databaseUrl));
    try {
      let transitions: Promise<unknown>[] = [];
      await aiLock.transaction(async (transaction) => {
        await transaction`SELECT id FROM ai_change_requests WHERE id = ${ids.aiRace} FOR UPDATE`;
        transitions = [
          repository.updateAIChangeRequest({
            ...raceRequest,
            lifecycle: 'applied',
            updatedAt: '2026-07-23T20:04:00Z',
            result: {
              revisionId: ids.revisionA1,
              revisionFingerprint: firstFingerprint,
              diff: 'Race applied patch',
              completedAt: '2026-07-23T20:04:00Z'
            }
          }),
          competingAIRepository.updateAIChangeRequest({
            ...raceRequest,
            lifecycle: 'failed',
            updatedAt: '2026-07-23T20:04:00Z',
            failureReason: 'Race failure'
          })
        ];
        await Bun.sleep(50);
      });
      const transitionRace = await Promise.allSettled(transitions);
      expect(transitionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(transitionRace.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'CONFLICT' }
      });
      await expect(repository.getAIChangeRequest(ids.aiRace)).resolves.toMatchObject({
        lifecycle: expect.stringMatching(/^(applied|failed)$/)
      });
    } finally {
      await aiLock.close({ timeout: 0 });
      await competingAIRepository.close({ timeout: 0 });
    }
    const annotation = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/developer-annotations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.annotation,
          anchor: currentAnchor,
          category: 'content',
          body: 'Keep the heading semantic.'
        })
      })
    );
    expect(annotation.status).toBe(201);

    const ready = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/readiness`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.baseline,
          intent: 'review',
          revisionId: ids.revisionA1,
          revisionFingerprint: firstFingerprint
        })
      })
    );
    expect(ready.status).toBe(201);

    const hostedBinding = {
      tenantId: ids.organizationA,
      projectId: ids.projectA,
      artifactId: 'artifact-a',
      revisionId: ids.revisionA1,
      baselineId: ids.baseline,
      version: 1
    } as const;
    await expect(
      repository.mutateReviewThread({
        kind: 'create',
        operationId: 'postgres-hosted-create',
        expectedVersion: 0,
        thread: {
          id: ids.hostedReviewThread,
          projectId: ids.projectA,
          hostedBinding,
          version: 1,
          anchor: currentAnchor,
          messages: [
            {
              id: 'postgres-hosted-message',
              body: 'Persist this exact published review binding.',
              createdBy: ids.userA,
              createdAt: '2026-07-23T20:10:00Z',
              mentionedUserIds: [],
              reactions: [],
              readBy: [ids.userA]
            }
          ],
          deepLink: 'https://review.example.test/projects/a#hosted',
          lifecycle: 'open',
          createdBy: ids.userA,
          createdAt: '2026-07-23T20:10:00Z'
        }
      })
    ).resolves.toMatchObject({
      kind: 'applied',
      thread: { hostedBinding, version: 1 }
    });
    await expect(
      repository.mutateReviewThread({
        kind: 'reply',
        operationId: 'postgres-hosted-reply',
        expectedVersion: 1,
        threadId: ids.hostedReviewThread,
        message: {
          id: 'postgres-hosted-reply',
          body: 'The second session sees the same binding.',
          createdBy: ids.userA,
          createdAt: '2026-07-23T20:11:00Z',
          mentionedUserIds: [],
          reactions: [],
          readBy: [ids.userA]
        }
      })
    ).resolves.toMatchObject({
      kind: 'applied',
      thread: { hostedBinding, version: 2 }
    });

    const thread = await application.fetch(
      new Request(`https://service.test/v1/projects/${ids.projectA}/threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.thread,
          revisionId: ids.revisionA1,
          reactNodeId: 'orders.table',
          scenarioId: 'default'
        })
      })
    );
    expect(thread.status).toBe(201);
    const comment = await application.fetch(
      new Request(`https://service.test/v1/threads/${ids.thread}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: ids.comment,
          body: 'Comment activity is not design drift.',
          mentionedUserIds: []
        })
      })
    );
    expect(comment.status).toBe(201);
    expect(await repository.getDesignReviewState(ids.projectA)).toMatchObject({
      currency: 'current',
      approvalsStale: false,
      changesSinceBaseline: []
    });

    const designMutation = {
      content: { project: 'A', title: 'After baseline' },
      contentSha256: secondFingerprint,
      scenarioIds: ['default'],
      semanticChange: {
        id: ids.change,
        kind: 'visual',
        reason: 'Updated table heading',
        affected: {
          projectId: ids.projectA,
          screenIds: ['orders'],
          routePaths: ['/orders'],
          scenarioIds: ['default'],
          componentIds: ['orders-table'],
          stableNodeIds: ['orders.table']
        },
        evidence: [{ description: 'Before/after screenshot', checksum: 'sha256:example' }],
        provenance: { kind: 'actor', actorId: ids.userA }
      }
    };
    const revisionUrl = `https://service.test/v1/projects/${ids.projectA}/revisions`;
    const changed = await application.fetch(
      new Request(revisionUrl, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'after-baseline' },
        body: JSON.stringify(designMutation)
      })
    );
    expect(changed.status).toBe(201);
    const changedBody = (await changed.json()) as { id: string };
    const replay = await application.fetch(
      new Request(revisionUrl, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'after-baseline' },
        body: JSON.stringify(designMutation)
      })
    );
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({ id: changedBody.id });

    const stale = await repository.getDesignReviewState(ids.projectA);
    expect(stale).toMatchObject({
      readiness: 'ready-for-review',
      currency: 'stale',
      approvalsStale: true,
      baseline: {
        id: ids.baseline,
        revision: { id: ids.revisionA1, fingerprint: firstFingerprint }
      },
      changesSinceBaseline: [
        expect.objectContaining({
          id: ids.change,
          beforeRevision: { id: ids.revisionA1, fingerprint: firstFingerprint },
          currentRevision: { id: changedBody.id, fingerprint: secondFingerprint }
        })
      ]
    });
    const revisionEvents = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM collaboration_events
      WHERE project_id = ${ids.projectA} AND type = 'revision.created'`;
    expect(revisionEvents[0]?.count).toBe(2);

    const restarted = new BunPostgresCollaborationRepository(new Bun.SQL(databaseUrl));
    expect(await restarted.getDesignReviewState(ids.projectA)).toEqual(stale);
    await expect(restarted.getReviewThread(ids.reviewThread)).resolves.toMatchObject({
      lifecycle: 'resolved',
      anchor: { evidence: { artifactId: 'artifact-a' } },
      reopenedAt: '2099-07-23T20:01:00.000Z',
      reopenedBy: ids.userA
    });
    await expect(restarted.getReviewThread(ids.hostedReviewThread)).resolves.toMatchObject({
      hostedBinding,
      version: 2
    });
    await expect(restarted.getAIChangeRequest(ids.aiRequest)).resolves.toMatchObject({
      lifecycle: 'undone',
      result: { diff: 'applied test patch' },
      undoResult: { diff: 'compensating test patch' }
    });
    await expect(restarted.listDeveloperAnnotations(ids.projectA)).resolves.toEqual([
      expect.objectContaining({ id: ids.annotation })
    ]);
    await restarted.close({ timeout: 0 });

    const snapshot = await repository.exportProject(ids.projectA);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) throw new Error('Expected project export before restore');
    await clearProject(ids.projectA);
    await repository.replaceProject(snapshot);
    expect(await repository.getDesignReviewState(ids.projectA)).toEqual(stale);
    await expect(repository.getReviewThread(ids.reviewThread)).resolves.toEqual(
      expect.objectContaining({
        lifecycle: 'resolved',
        reopenedAt: '2099-07-23T20:01:00.000Z',
        reopenedBy: ids.userA,
        messages: expect.arrayContaining([
          expect.objectContaining({ body: 'Keep this table aligned with the baseline.' })
        ])
      })
    );
    await expect(repository.getReviewThread(ids.hostedReviewThread)).resolves.toMatchObject({
      hostedBinding,
      version: 2,
      messages: expect.arrayContaining([expect.objectContaining({ id: 'postgres-hosted-reply' })])
    });
    await expect(repository.getAIChangeRequest(ids.aiRequest)).resolves.toMatchObject({
      lifecycle: 'undone',
      result: { diff: 'applied test patch' },
      undoResult: { diff: 'compensating test patch' }
    });
    await expect(repository.listDeveloperAnnotations(ids.projectA)).resolves.toEqual([
      expect.objectContaining({ id: ids.annotation })
    ]);

    await expect(
      (async () => {
        await sql`
          INSERT INTO threads (id, project_id, revision_id, react_node_id, scenario_id, created_by, created_at)
          VALUES ('90000000-0000-4000-8000-000000000001', ${ids.projectA}, ${ids.revisionB1}, 'cross.project', 'default', ${ids.userA}, now())`;
      })()
    ).rejects.toThrow('threads_project_revision_project_fkey');
  });
});
