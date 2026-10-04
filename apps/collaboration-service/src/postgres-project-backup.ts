import { createHash, randomUUID } from 'node:crypto';
import {
  CollaborationError,
  type AuditEvent,
  type CollaborationHostContext
} from '@selene/collaboration';
import { BunPostgresCollaborationRepository } from './postgres-repository.js';
import {
  canonicalBackupJson,
  parseProjectBackup,
  projectBackupExclusions,
  projectBackupResourceIds,
  projectSnapshotIdentity,
  PROJECT_BACKUP_LIMITS,
  type ProjectBackup,
  type ProjectRestoreReceipt
} from './project-backup-contract.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
function auditEvent(row: Row): AuditEvent {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    ...(row.actor_id === null ? {} : { actorId: String(row.actor_id) }),
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    occurredAt: new Date(String(row.occurred_at)).toISOString()
  };
}

/** Project recovery only; identity policy, bearer grants and global event cursors are excluded. */
export class BunPostgresProjectBackupStore {
  public constructor(private readonly sql: Bun.SQL) {}
  public async backup(
    projectId: string,
    restoreOwnerId: string,
    retentionDays: number,
    context?: CollaborationHostContext
  ): Promise<ProjectBackup> {
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > PROJECT_BACKUP_LIMITS.retentionDays
    )
      throw new CollaborationError('INVALID', 'Choose a retention period from 1 to 365 days');
    return this.sql.transaction(async (sql) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      const repository = new BunPostgresCollaborationRepository(sql);
      const snapshot = await repository.exportProject(projectId);
      if (snapshot === undefined) throw new CollaborationError('NOT_FOUND', 'Project not found');
      const latest = [...snapshot.revisions].sort(
        (left, right) => right.sequence - left.sequence
      )[0];
      if (latest === undefined)
        throw new CollaborationError('INVALID', 'A backup requires an immutable project revision');
      const ids = projectBackupResourceIds(snapshot);
      const rows = await sql<
        Row[]
      >`SELECT * FROM audit_events WHERE organization_id = ${snapshot.project.organizationId} AND resource_id = ANY(${sql.array([...ids], 'UUID')}) ORDER BY occurred_at, id LIMIT ${PROJECT_BACKUP_LIMITS.audits + 1}`;
      if (rows.length > PROJECT_BACKUP_LIMITS.audits)
        throw new CollaborationError(
          'INVALID',
          'Project audit history exceeds the supported backup size'
        );
      const exportedAt = new Date().toISOString();
      const document = {
        format: 'selene-project-backup/v1' as const,
        projectId,
        tenantId: snapshot.project.organizationId,
        latestRevisionId: latest.id,
        exportedAt,
        expiresAt: new Date(Date.parse(exportedAt) + retentionDays * 86_400_000).toISOString(),
        restoreOwnerId,
        snapshot,
        audits: rows.map(auditEvent),
        exclusions: projectBackupExclusions
      };
      if (context?.signal.aborted) throw new CollaborationError('CONFLICT', 'Backup was cancelled');
      return parseProjectBackup({ document, sha256: sha256(canonicalBackupJson(document)) });
    });
  }
  public async restore(
    value: unknown,
    expectedRevisionId: string,
    actorId: string,
    context?: CollaborationHostContext
  ): Promise<ProjectRestoreReceipt> {
    let backup: ProjectBackup;
    try {
      backup = parseProjectBackup(value);
    } catch {
      throw new CollaborationError('INVALID', 'Backup is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expectedRevisionId))
      throw new CollaborationError('INVALID', 'Restore requires the current project revision');
    if (backup.sha256 !== sha256(canonicalBackupJson(backup.document)))
      throw new CollaborationError('INVALID', 'Backup checksum does not match');
    if (Date.parse(backup.document.expiresAt) <= Date.now())
      throw new CollaborationError('EXPIRED', 'Backup retention has expired');
    return this.sql.transaction(async (sql) => {
      const repository = new BunPostgresCollaborationRepository(sql);
      const rows = await sql<
        Row[]
      >`SELECT * FROM projects WHERE id = ${backup.document.projectId} AND deleted_at IS NULL FOR UPDATE`;
      if (rows[0]?.organization_id !== backup.document.tenantId)
        throw new CollaborationError(
          'FORBIDDEN',
          'Restore must preserve the active project tenant'
        );
      if (
        !(await repository.authorize({
          userId: actorId,
          projectId: backup.document.projectId,
          action: 'project:restore'
        }))
      )
        throw new CollaborationError(
          'FORBIDDEN',
          'Project recovery requires an active owner or admin'
        );
      const latest = await repository.getLatestRevision(backup.document.projectId);
      if (latest?.id !== expectedRevisionId)
        throw new CollaborationError('CONFLICT', 'Project revision is no longer current');
      // Validate all existing immutable audit identities before any project mutation.
      for (const audit of backup.document.audits) {
        // oxlint-disable-next-line no-await-in-loop -- Ordered preflight is bounded to 1000 audit identities.
        const existing = await sql<Row[]>`SELECT * FROM audit_events WHERE id = ${audit.id}`;
        if (
          existing[0] !== undefined &&
          canonicalBackupJson(auditEvent(existing[0])) !== canonicalBackupJson(audit)
        )
          throw new CollaborationError(
            'CONFLICT',
            'An immutable audit identity conflicts with this backup'
          );
      }
      await repository.restoreProjectInTransaction(backup.document.snapshot, {
        expectedLatestRevisionId: expectedRevisionId
      });
      for (const audit of backup.document.audits) {
        // oxlint-disable-next-line no-await-in-loop -- Audit preservation shares the exact project restoration transaction.
        await sql`INSERT INTO audit_events (id, organization_id, actor_id, action, resource_type, resource_id, metadata, occurred_at) VALUES (${audit.id}, ${audit.organizationId}, ${audit.actorId ?? null}, ${audit.action}, ${audit.resourceType}, ${audit.resourceId}, ${JSON.stringify(audit.metadata)}::jsonb, ${audit.occurredAt}) ON CONFLICT (id) DO NOTHING`;
        // oxlint-disable-next-line no-await-in-loop -- Detect a conflicting identity inserted after the preflight query.
        const persisted = await sql<Row[]>`SELECT * FROM audit_events WHERE id = ${audit.id}`;
        if (
          persisted[0] === undefined ||
          canonicalBackupJson(auditEvent(persisted[0])) !== canonicalBackupJson(audit)
        )
          throw new CollaborationError(
            'CONFLICT',
            'An immutable audit identity conflicts with this backup'
          );
      }
      const restored = await repository.exportProject(backup.document.projectId);
      const snapshotSha256 = sha256(projectSnapshotIdentity(backup.document.snapshot));
      if (restored === undefined || sha256(projectSnapshotIdentity(restored)) !== snapshotSha256)
        throw new CollaborationError('CONFLICT', 'Restored project identity could not be verified');
      const restoreAuditId = randomUUID();
      const restoredAt = new Date().toISOString();
      await repository.appendAudit({
        id: restoreAuditId,
        organizationId: backup.document.tenantId,
        actorId,
        action: 'project.backup-restored',
        resourceType: 'project',
        resourceId: backup.document.projectId,
        metadata: {
          backupSha256: backup.sha256,
          previousRevisionId: expectedRevisionId,
          restoredRevisionId: backup.document.latestRevisionId,
          preservedAuditCount: backup.document.audits.length
        },
        occurredAt: restoredAt
      });
      if (context?.signal.aborted)
        throw new CollaborationError('CONFLICT', 'Restore was cancelled');
      return {
        format: 'selene-project-restore-receipt/v1',
        projectId: backup.document.projectId,
        tenantId: backup.document.tenantId,
        previousRevisionId: expectedRevisionId,
        restoredRevisionId: backup.document.latestRevisionId,
        snapshotSha256,
        preservedAuditIds: backup.document.audits.map((audit) => audit.id),
        restoreAuditId,
        restoredAt
      };
    });
  }
}
