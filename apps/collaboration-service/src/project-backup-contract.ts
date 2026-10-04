import {
  ownCollaborationValue,
  parseSnapshot,
  serializeSnapshot,
  type AuditEvent,
  type CollaborationSnapshot
} from '@selene/collaboration';

export const PROJECT_BACKUP_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  audits: 1000,
  retentionDays: 365
});
export interface ProjectBackupDocument {
  readonly format: 'selene-project-backup/v1';
  readonly projectId: string;
  readonly tenantId: string;
  readonly latestRevisionId: string;
  readonly exportedAt: string;
  readonly expiresAt: string;
  readonly restoreOwnerId: string;
  readonly snapshot: CollaborationSnapshot;
  /** Only audit events for resources present in this project snapshot are included. */
  readonly audits: readonly AuditEvent[];
  readonly exclusions: readonly string[];
}
export interface ProjectBackup {
  readonly document: ProjectBackupDocument;
  readonly sha256: string;
}
export interface ProjectRestoreReceipt {
  readonly format: 'selene-project-restore-receipt/v1';
  readonly projectId: string;
  readonly tenantId: string;
  readonly previousRevisionId: string;
  readonly restoredRevisionId: string;
  readonly snapshotSha256: string;
  readonly preservedAuditIds: readonly string[];
  readonly restoreAuditId: string;
  readonly restoredAt: string;
}
export const projectBackupExclusions = Object.freeze([
  'Organization identity policy, memberships, invitations and sessions',
  'Guest bearer grants and connector credentials',
  'Global event cursors and audit events for resources outside this snapshot',
  'External objects, npm packages and generated build artifacts'
]);
export function canonicalBackupJson(value: unknown): string {
  const owned = ownCollaborationValue(value);
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)])
      );
    return entry;
  };
  return JSON.stringify(canonical(owned));
}
export function projectBackupResourceIds(snapshot: CollaborationSnapshot): readonly string[] {
  return [
    ...new Set([
      snapshot.project.id,
      ...snapshot.revisions.map((item) => item.id),
      ...snapshot.threads.map((item) => item.id),
      ...snapshot.comments.map((item) => item.id),
      ...snapshot.approvals.map((item) => item.id),
      ...snapshot.reviewThreads.flatMap((item) => [
        item.id,
        ...item.messages.map((message) => message.id)
      ]),
      ...snapshot.aiChangeRequests.map((item) => item.id),
      ...snapshot.developerAnnotations.map((item) => item.id),
      ...(snapshot.designReviewState?.baseline ? [snapshot.designReviewState.baseline.id] : [])
    ])
  ];
}
export function projectSnapshotIdentity(snapshot: CollaborationSnapshot): string {
  const sort = <T extends { readonly id: string }>(items: readonly T[]) =>
    [...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return canonicalBackupJson({
    ...snapshot,
    revisions: sort(snapshot.revisions),
    threads: sort(snapshot.threads),
    comments: sort(snapshot.comments),
    approvals: sort(snapshot.approvals),
    reviewThreads: sort(snapshot.reviewThreads),
    aiChangeRequests: sort(snapshot.aiChangeRequests),
    developerAnnotations: sort(snapshot.developerAnnotations),
    reactions: [...snapshot.reactions].sort((left, right) =>
      canonicalBackupJson(left).localeCompare(canonicalBackupJson(right), 'en')
    )
  });
}
export function parseProjectBackup(value: unknown): ProjectBackup {
  const input = ownCollaborationValue(value);
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Backup is invalid');
  const outer = input as Record<string, unknown>;
  if (
    Object.keys(outer).length !== 2 ||
    typeof outer.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(outer.sha256)
  )
    throw new Error('Backup is invalid');
  if (
    outer.document === null ||
    typeof outer.document !== 'object' ||
    Array.isArray(outer.document)
  )
    throw new Error('Backup is invalid');
  const document = outer.document as Record<string, unknown>;
  const fields = [
    'format',
    'projectId',
    'tenantId',
    'latestRevisionId',
    'exportedAt',
    'expiresAt',
    'restoreOwnerId',
    'snapshot',
    'audits',
    'exclusions'
  ];
  if (
    Object.keys(document).length !== fields.length ||
    Object.keys(document).some((key) => !fields.includes(key)) ||
    document.format !== 'selene-project-backup/v1'
  )
    throw new Error('Backup is invalid');
  const snapshot = parseSnapshot(JSON.stringify(document.snapshot));
  const identifier = (name: string): string => {
    const result = document[name];
    if (typeof result !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result))
      throw new Error('Backup identity is invalid');
    return result;
  };
  const timestamp = (name: string): string => {
    const result = document[name];
    if (
      typeof result !== 'string' ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result
    )
      throw new Error('Backup timestamp is invalid');
    return result;
  };
  const projectId = identifier('projectId');
  const tenantId = identifier('tenantId');
  const latestRevisionId = identifier('latestRevisionId');
  const exportedAt = timestamp('exportedAt');
  const expiresAt = timestamp('expiresAt');
  const latest = [...snapshot.revisions].sort((left, right) => right.sequence - left.sequence)[0];
  if (
    projectId !== snapshot.project.id ||
    tenantId !== snapshot.project.organizationId ||
    latestRevisionId !== latest?.id ||
    Date.parse(expiresAt) <= Date.parse(exportedAt) ||
    Date.parse(expiresAt) - Date.parse(exportedAt) >
      PROJECT_BACKUP_LIMITS.retentionDays * 86_400_000
  )
    throw new Error('Backup identity is invalid');
  const resources = new Set(projectBackupResourceIds(snapshot));
  if (!Array.isArray(document.audits) || document.audits.length > PROJECT_BACKUP_LIMITS.audits)
    throw new Error('Backup audit scope is invalid');
  const audits: AuditEvent[] = document.audits.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Backup audit is invalid');
    const audit = entry as Record<string, unknown>;
    if (
      ![
        'id',
        'organizationId',
        'actorId',
        'action',
        'resourceType',
        'resourceId',
        'metadata',
        'occurredAt'
      ].every((key) => key === 'actorId' || Object.hasOwn(audit, key)) ||
      Object.keys(audit).some(
        (key) =>
          ![
            'id',
            'organizationId',
            'actorId',
            'action',
            'resourceType',
            'resourceId',
            'metadata',
            'occurredAt'
          ].includes(key)
      ) ||
      audit.organizationId !== tenantId ||
      typeof audit.resourceId !== 'string' ||
      !resources.has(audit.resourceId)
    )
      throw new Error('Backup audit scope is invalid');
    for (const key of ['id', 'action', 'resourceType', 'resourceId', 'occurredAt'])
      if (typeof audit[key] !== 'string' || audit[key].length === 0 || audit[key].length > 128)
        throw new Error('Backup audit is invalid');
    if (
      audit.actorId !== undefined &&
      (typeof audit.actorId !== 'string' || audit.actorId.length > 128)
    )
      throw new Error('Backup audit is invalid');
    if (
      audit.metadata === null ||
      typeof audit.metadata !== 'object' ||
      Array.isArray(audit.metadata) ||
      canonicalBackupJson(audit.metadata).length > 8192 ||
      !Number.isFinite(Date.parse(String(audit.occurredAt)))
    )
      throw new Error('Backup audit is invalid');
    return {
      id: String(audit.id),
      organizationId: tenantId,
      ...(audit.actorId === undefined ? {} : { actorId: String(audit.actorId) }),
      action: String(audit.action),
      resourceType: String(audit.resourceType),
      resourceId: audit.resourceId,
      metadata: audit.metadata as Readonly<Record<string, unknown>>,
      occurredAt: String(audit.occurredAt)
    };
  });
  if (
    new Set(audits.map((event) => event.id)).size !== audits.length ||
    canonicalBackupJson(document.exclusions) !== canonicalBackupJson(projectBackupExclusions)
  )
    throw new Error('Backup audit scope is invalid');
  const result = {
    document: {
      format: 'selene-project-backup/v1' as const,
      projectId,
      tenantId,
      latestRevisionId,
      exportedAt,
      expiresAt,
      restoreOwnerId: identifier('restoreOwnerId'),
      snapshot,
      audits,
      exclusions: projectBackupExclusions
    },
    sha256: outer.sha256
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PROJECT_BACKUP_LIMITS.bytes)
    throw new Error('Backup exceeds the supported size');
  serializeSnapshot(snapshot);
  return result;
}
