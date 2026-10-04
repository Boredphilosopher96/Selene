import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent, CollaborationSnapshot } from '@selene/collaboration';
import { BunPostgresCollaborationRepository } from './postgres-repository';
import { BunPostgresProjectBackupStore } from './postgres-project-backup';
import { createProjectBackupHttpHandler } from './project-backup-service';
import { canonicalBackupJson, projectSnapshotIdentity } from './project-backup-contract';
import { createHeaderIdentityProvider } from './auth';
import { createHostEffectContextFactory } from './host-effects';
import { createCollaborationApplication } from './app';
import { readServiceEnvironment } from './env';
import { decryptProjectBackup, encryptProjectBackup } from '../../web/src/project-recovery-model';

const databaseUrl = process.env.TEAM_BACKUP_DATABASE_URL;
const postgres = databaseUrl === undefined ? describe.skip : describe;
const id = (type: number, index: number) =>
  `b${type}000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const tenant = id(1, 1),
  owner = id(2, 1),
  editor = id(2, 2),
  projectId = id(3, 1),
  r1 = id(4, 1),
  r2 = id(4, 2),
  threadId = id(5, 1),
  commentId = id(6, 1),
  auditId = id(7, 1),
  readinessAuditId = id(7, 2),
  baselineId = id(8, 1),
  otherTenant = id(1, 2);
const createdAt = '2026-09-30T12:00:00.000Z';
const snapshot: CollaborationSnapshot = {
  format: 'selene-collaboration/v2',
  project: { id: projectId, organizationId: tenant, name: 'Recovery fixture' },
  revisions: [
    {
      id: r1,
      projectId,
      sequence: 1,
      content: { source: 'Before' },
      contentSha256: 'a'.repeat(64),
      scenarioIds: ['scenario-1'],
      createdBy: owner,
      createdAt
    }
  ],
  threads: [
    {
      id: threadId,
      projectId,
      revisionId: r1,
      reactNodeId: 'App',
      scenarioId: 'scenario-1',
      createdBy: owner,
      createdAt
    }
  ],
  comments: [
    {
      id: commentId,
      threadId,
      body: 'Persist this exact review comment.',
      createdBy: owner,
      createdAt,
      mentionedUserIds: [editor]
    }
  ],
  reactions: [],
  approvals: [],
  reviewThreads: [],
  aiChangeRequests: [],
  developerAnnotations: [],
  designReviewState: {
    format: 'selene-design-review-state/v1',
    projectId,
    readiness: 'draft',
    currency: 'none',
    approvalsStale: false,
    changesSinceBaseline: []
  }
};
const initialAudit = {
  id: auditId,
  organizationId: tenant,
  actorId: owner,
  action: 'project.created',
  resourceType: 'project',
  resourceId: projectId,
  metadata: { projectId },
  occurredAt: createdAt
};
const proxySecret = 'readiness-only-proxy-secret-000000';
const headers = {
  'content-type': 'application/json',
  'x-selene-user-id': owner,
  'x-selene-proxy-secret': proxySecret
};

postgres('real PostgreSQL project backup and recovery', () => {
  let sql: Bun.SQL;
  let repository: BunPostgresCollaborationRepository;
  let store: BunPostgresProjectBackupStore;
  let handler: ReturnType<typeof createProjectBackupHttpHandler>;
  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('Disposable database is required');
    sql = new Bun.SQL(databaseUrl);
    repository = new BunPostgresCollaborationRepository(sql);
    store = new BunPostgresProjectBackupStore(sql);
    handler = createProjectBackupHttpHandler({
      store,
      authorizer: repository,
      identityProvider: createHeaderIdentityProvider(proxySecret),
      hostContextFactory: createHostEffectContextFactory(),
      allowedOrigins: []
    });
    await sql`INSERT INTO organizations (id, slug, name) VALUES (${tenant}, 'team-recovery-fixture', 'Recovery fixture') ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO organizations (id, slug, name) VALUES (${otherTenant}, 'team-recovery-other-tenant', 'Other recovery tenant') ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO users (id, organization_id, email, display_name) VALUES (${owner}, ${tenant}, 'owner@fixture.invalid', 'Fixture owner'), (${editor}, ${tenant}, 'editor@fixture.invalid', 'Fixture editor') ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO memberships (organization_id, user_id, role) VALUES (${tenant}, ${owner}, 'owner'), (${tenant}, ${editor}, 'editor') ON CONFLICT (organization_id, user_id) DO NOTHING`;
  });
  beforeEach(async () => {
    await repository.replaceProject(snapshot);
    await sql`DELETE FROM audit_events WHERE organization_id IN (${tenant}, ${otherTenant})`;
    await repository.appendAudit(initialAudit);
  });
  afterAll(async () => {
    await sql?.close({ timeout: 1 });
  });
  const changedRevision = async () => {
    await repository.appendRevision(
      {
        ...snapshot.revisions[0],
        id: r2,
        projectId,
        sequence: 2,
        parentRevisionId: r1,
        content: { source: 'After' },
        contentSha256: 'b'.repeat(64),
        scenarioIds: ['scenario-1'],
        createdBy: owner,
        createdAt: '2026-09-30T12:01:00.000Z'
      },
      r1
    );
  };
  const restore = async (backup: unknown, expectedRevisionId: string, actor = owner) => {
    const response = await handler.fetch(
      new Request(`http://service.test/v1/projects/${projectId}/restore`, {
        method: 'POST',
        headers: { ...headers, 'x-selene-user-id': actor },
        body: JSON.stringify({ backup, expectedRevisionId })
      })
    );
    if (response === undefined) throw new Error('Backup route was not handled');
    return response;
  };
  const markReady = async (
    intent: 'review' | 'handoff' = 'review',
    readyId = baselineId,
    readyAuditId = readinessAuditId
  ) => {
    const environment = readServiceEnvironment({
      COLLABORATION_STORE: 'postgres',
      DATABASE_URL: databaseUrl,
      COLLABORATION_AUTH_MODE: 'proxy',
      COLLABORATION_PROXY_SECRET: proxySecret,
      COLLABORATION_SHARE_SECRET: 'disposable-readiness-share-secret-2026'
    });
    const application = createCollaborationApplication(environment, repository, repository);
    const response = await application.fetch(
      new Request(`http://service.test/v1/projects/${projectId}/readiness`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: readyId,
          intent,
          revisionId: r1,
          revisionFingerprint: snapshot.revisions[0]!.contentSha256
        })
      })
    );
    expect(response.status).toBe(201);
    const event = (await repository.listEvents(projectId, 0, 1000))
      .filter((entry) => entry.type === 'design.ready' && entry.resourceId === readyId)
      .at(-1);
    if (event === undefined) throw new Error('Readiness event was not persisted');
    expect(event).toMatchObject({
      actorId: owner,
      resourceType: 'design_baseline',
      resourceId: readyId,
      payload: { intent, revisionId: r1 }
    });
    // Readiness emits a cursor event; seed a separate immutable audit record
    // to exercise recovery of actual persisted design_baseline audit history.
    const audit: AuditEvent = {
      id: readyAuditId,
      organizationId: tenant,
      actorId: owner,
      action: event.type,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: event.payload,
      occurredAt: event.occurredAt
    };
    await repository.appendAudit(audit);
    const persisted = await sql<
      Record<string, unknown>[]
    >`SELECT * FROM audit_events WHERE id = ${readyAuditId}`;
    const readySnapshot = await repository.exportProject(projectId);
    if (persisted[0] === undefined || readySnapshot === undefined)
      throw new Error('Readiness audit and snapshot were not persisted');
    return { audit, persisted: persisted[0], snapshot: readySnapshot };
  };
  it.each(['review', 'handoff'] as const)(
    'round-trips the complete immutable %s readiness audit through encrypted backup and database restore',
    async (intent) => {
      const historical = await markReady('review', id(8, 2), id(7, 3));
      const ready = await markReady(intent);
      await repository.appendAudit({
        ...ready.audit,
        id: id(7, 4),
        resourceId: id(8, 3)
      });
      const { actorId: _actor, ...actorlessAudit } = ready.audit;
      await repository.appendAudit({
        ...actorlessAudit,
        id: id(7, 5),
        organizationId: otherTenant
      });
      const backup = await store.backup(projectId, owner, 30);
      expect(backup.document.snapshot.designReviewState?.baseline?.id).toBe(baselineId);
      expect(backup.document.audits).toEqual([initialAudit, ready.audit]);
      expect(backup.document.audits).not.toContainEqual(historical.audit);
      const encrypted = await encryptProjectBackup(backup, 'disposable-passphrase-2026');
      expect(encrypted).not.toContain(baselineId);
      expect(encrypted).not.toContain(readinessAuditId);
      const decrypted = await decryptProjectBackup(encrypted, 'disposable-passphrase-2026');
      expect(decrypted.document.audits).toEqual(backup.document.audits);
      await repository.replaceProject(snapshot);
      await changedRevision();
      await sql`DELETE FROM audit_events WHERE id IN (${auditId}, ${readinessAuditId})`;
      const response = await restore(decrypted, r2);
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt.preservedAuditIds).toEqual([auditId, readinessAuditId]);
      const reopenedSql = new Bun.SQL(databaseUrl!);
      try {
        const reopened = new BunPostgresCollaborationRepository(reopenedSql);
        expect(projectSnapshotIdentity((await reopened.exportProject(projectId))!)).toBe(
          projectSnapshotIdentity(ready.snapshot)
        );
        const restored = await reopenedSql<
          Record<string, unknown>[]
        >`SELECT * FROM audit_events WHERE id = ${readinessAuditId}`;
        expect(restored).toEqual([ready.persisted]);
      } finally {
        await reopenedSql.close({ timeout: 1 });
      }
    }
  );
  it('excludes readiness audit resources when the backed-up projection has no baseline', async () => {
    const ready = await markReady();
    await repository.replaceProject(snapshot);
    const backup = await store.backup(projectId, owner, 30);
    expect(backup.document.snapshot.designReviewState?.baseline).toBeUndefined();
    expect(backup.document.audits).toEqual([initialAudit]);
    expect(backup.document.audits).not.toContainEqual(ready.audit);
  });
  it('rejects conflicting readiness audit contents before changing the snapshot', async () => {
    await markReady();
    const backup = await store.backup(projectId, owner, 30);
    await repository.replaceProject(snapshot);
    await changedRevision();
    const before = projectSnapshotIdentity((await repository.exportProject(projectId))!);
    await sql`UPDATE audit_events SET metadata = '{"intent":"changed"}'::jsonb WHERE id = ${readinessAuditId}`;
    expect((await restore(backup, r2)).status).toBe(409);
    expect(projectSnapshotIdentity((await repository.exportProject(projectId))!)).toBe(before);
    expect(await sql`SELECT metadata FROM audit_events WHERE id = ${readinessAuditId}`).toEqual([
      { metadata: { intent: 'changed' } }
    ]);
  });
  it('rolls back a restored baseline and readiness audit when the final audit insert fails', async () => {
    await markReady();
    const backup = await store.backup(projectId, owner, 30);
    await repository.replaceProject(snapshot);
    await changedRevision();
    const before = projectSnapshotIdentity((await repository.exportProject(projectId))!);
    await sql`DELETE FROM audit_events WHERE id = ${readinessAuditId}`;
    await sql.unsafe(
      "CREATE FUNCTION team_readiness_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'project.backup-restored' THEN RAISE EXCEPTION 'PRIVATE FAILURE DETAIL'; END IF; RETURN NEW; END $$; CREATE TRIGGER team_readiness_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION team_readiness_reject_audit();"
    );
    try {
      const response = await restore(backup, r2);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"recovery_unavailable"}');
      expect(projectSnapshotIdentity((await repository.exportProject(projectId))!)).toBe(before);
      expect(await sql`SELECT id FROM audit_events WHERE id = ${readinessAuditId}`).toHaveLength(0);
      expect(await sql`SELECT id FROM design_baselines WHERE id = ${baselineId}`).toHaveLength(0);
    } finally {
      await sql.unsafe(
        'DROP TRIGGER team_readiness_reject_audit ON audit_events; DROP FUNCTION team_readiness_reject_audit();'
      );
    }
  });
  it('round-trips encrypted persisted revision/comment/tenant/audit identities through a new database connection', async () => {
    const backup = await store.backup(projectId, owner, 30);
    const encrypted = await encryptProjectBackup(backup, 'disposable-passphrase-2026');
    expect(encrypted).not.toContain('Persist this exact review comment.');
    const decrypted = await decryptProjectBackup(encrypted, 'disposable-passphrase-2026');
    await expect(decryptProjectBackup(encrypted, 'wrong-passphrase-2026')).rejects.toThrow(
      'could not be decrypted'
    );
    await changedRevision();
    await sql`DELETE FROM audit_events WHERE id = ${auditId}`;
    const response = await restore(decrypted, r2);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      format: 'selene-project-restore-receipt/v1',
      projectId,
      tenantId: tenant,
      previousRevisionId: r2,
      restoredRevisionId: r1,
      preservedAuditIds: [auditId]
    });
    const reopenedSql = new Bun.SQL(databaseUrl!);
    try {
      const reopened = new BunPostgresCollaborationRepository(reopenedSql);
      expect(projectSnapshotIdentity((await reopened.exportProject(projectId))!)).toBe(
        projectSnapshotIdentity(snapshot)
      );
      const audits = await reopenedSql<
        { id: string; actor_id: string; action: string }[]
      >`SELECT id, actor_id, action FROM audit_events WHERE organization_id = ${tenant} ORDER BY occurred_at`;
      expect(audits).toEqual([
        { id: auditId, actor_id: owner, action: 'project.created' },
        { id: receipt.restoreAuditId, actor_id: owner, action: 'project.backup-restored' }
      ]);
    } finally {
      await reopenedSql.close({ timeout: 1 });
    }
  });
  it('denies editors, forged identity and cross-origin admin requests', async () => {
    const backup = await store.backup(projectId, owner, 30);
    expect((await restore(backup, r1, editor)).status).toBe(403);
    const forged = await handler.fetch(
      new Request(`http://service.test/v1/projects/${projectId}/backup`, {
        headers: { 'x-selene-user-id': owner }
      })
    );
    expect(forged?.status).toBe(403);
    const crossOrigin = await handler.fetch(
      new Request(`http://service.test/v1/projects/${projectId}/backup`, {
        headers: { ...headers, origin: 'https://hostile.test' }
      })
    );
    expect(crossOrigin?.status).toBe(403);
    expect((await repository.getLatestRevision(projectId))?.id).toBe(r1);
  });
  it('requires CAS and rejects stale, tampered and cross-tenant backups before mutation', async () => {
    const backup = await store.backup(projectId, owner, 30);
    expect((await restore(backup, '')).status).toBe(400);
    await changedRevision();
    expect((await restore(backup, r1)).status).toBe(409);
    expect((await restore({ ...backup, sha256: '0'.repeat(64) }, r2)).status).toBe(400);
    const document = {
      ...backup.document,
      tenantId: id(1, 2),
      snapshot: {
        ...backup.document.snapshot,
        project: { ...backup.document.snapshot.project, organizationId: id(1, 2) }
      },
      audits: []
    };
    expect(
      (
        await restore(
          {
            document,
            sha256: createHash('sha256').update(canonicalBackupJson(document)).digest('hex')
          },
          r2
        )
      ).status
    ).toBe(403);
    expect((await repository.getLatestRevision(projectId))?.id).toBe(r2);
  });
  it('rejects an existing audit ID with different immutable content', async () => {
    const backup = await store.backup(projectId, owner, 30);
    await changedRevision();
    await sql`UPDATE audit_events SET action = 'different-immutable-action' WHERE id = ${auditId}`;
    expect((await restore(backup, r2)).status).toBe(409);
    expect((await repository.getLatestRevision(projectId))?.id).toBe(r2);
  });
  it('rolls back source and missing audit restoration when the final audit insert fails', async () => {
    const backup = await store.backup(projectId, owner, 30);
    await changedRevision();
    await sql`DELETE FROM audit_events WHERE id = ${auditId}`;
    await sql.unsafe(
      "CREATE FUNCTION team_recovery_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'project.backup-restored' THEN RAISE EXCEPTION 'PRIVATE FAILURE DETAIL'; END IF; RETURN NEW; END $$; CREATE TRIGGER team_recovery_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION team_recovery_reject_audit();"
    );
    try {
      const response = await restore(backup, r2);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"recovery_unavailable"}');
      expect((await repository.getLatestRevision(projectId))?.id).toBe(r2);
      expect(await sql`SELECT id FROM audit_events WHERE id = ${auditId}`).toHaveLength(0);
    } finally {
      await sql.unsafe(
        'DROP TRIGGER team_recovery_reject_audit ON audit_events; DROP FUNCTION team_recovery_reject_audit();'
      );
    }
  });
  it('hardens the existing import route with owner/admin authorization and a mandatory revision fence', async () => {
    const environment = readServiceEnvironment({
      COLLABORATION_STORE: 'postgres',
      DATABASE_URL: databaseUrl,
      COLLABORATION_AUTH_MODE: 'proxy',
      COLLABORATION_PROXY_SECRET: proxySecret,
      COLLABORATION_SHARE_SECRET: 'disposable-readiness-share-secret-2026'
    });
    const application = createCollaborationApplication(environment, repository, repository);
    const request = (actor: string, expectedRevisionId?: string) =>
      application.fetch(
        new Request('http://service.test/v1/import', {
          method: 'POST',
          headers: {
            ...headers,
            'x-selene-user-id': actor,
            ...(expectedRevisionId === undefined
              ? {}
              : { 'x-selene-expected-revision-id': expectedRevisionId })
          },
          body: JSON.stringify(snapshot)
        })
      );
    expect((await request(editor, r1)).status).toBe(403);
    expect((await request(owner)).status).toBe(400);
    await changedRevision();
    expect((await request(owner, r1)).status).toBe(409);
    expect((await request(owner, r2)).status).toBe(201);
    expect((await repository.getLatestRevision(projectId))?.id).toBe(r1);
  });
});
