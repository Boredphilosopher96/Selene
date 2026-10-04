import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationSnapshot } from '@selene/collaboration';
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
  auditId = id(7, 1);
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
    await sql`INSERT INTO users (id, organization_id, email, display_name) VALUES (${owner}, ${tenant}, 'owner@fixture.invalid', 'Fixture owner'), (${editor}, ${tenant}, 'editor@fixture.invalid', 'Fixture editor') ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO memberships (organization_id, user_id, role) VALUES (${tenant}, ${owner}, 'owner'), (${tenant}, ${editor}, 'editor') ON CONFLICT (organization_id, user_id) DO NOTHING`;
  });
  beforeEach(async () => {
    await repository.replaceProject(snapshot);
    await sql`DELETE FROM audit_events WHERE organization_id = ${tenant}`;
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
    const reopenedSql = new Bun.SQL(databaseUrl);
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
