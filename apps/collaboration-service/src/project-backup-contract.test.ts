import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditEvent, CollaborationSnapshot, DesignReviewState } from '@selene/collaboration';
import {
  canonicalBackupJson,
  parseProjectBackup,
  projectBackupExclusions,
  projectBackupResourceIds,
  type ProjectBackup
} from './project-backup-contract';
import { decryptProjectBackup, encryptProjectBackup } from '../../web/src/project-recovery-model';

const projectId = 'project:alpha';
const tenantId = 'tenant:alpha';
const baselineId = 'baseline:ready';
const createdAt = '2026-09-30T12:00:00.000Z';
const readyState: DesignReviewState = {
  format: 'selene-design-review-state/v1',
  projectId,
  readiness: 'ready-for-review',
  baseline: {
    id: baselineId,
    projectId,
    revision: { id: 'revision:one', fingerprint: 'a'.repeat(64) },
    intent: 'review',
    createdBy: 'owner:alpha',
    createdAt
  },
  currency: 'current',
  approvalsStale: false,
  changesSinceBaseline: []
};
const snapshot: CollaborationSnapshot = {
  format: 'selene-collaboration/v2',
  project: { id: projectId, organizationId: tenantId, name: 'Readiness backup' },
  revisions: [
    {
      id: 'revision:one',
      projectId,
      sequence: 1,
      content: { source: 'Ready design' },
      contentSha256: 'a'.repeat(64),
      scenarioIds: [],
      createdBy: 'owner:alpha',
      createdAt
    }
  ],
  threads: [],
  comments: [],
  reactions: [],
  approvals: [],
  reviewThreads: [],
  aiChangeRequests: [],
  developerAnnotations: [],
  designReviewState: readyState
};
const readinessAudit: AuditEvent = {
  id: 'audit:ready',
  organizationId: tenantId,
  actorId: 'owner:alpha',
  action: 'design.ready',
  resourceType: 'design_baseline',
  resourceId: baselineId,
  metadata: { intent: 'review', revisionId: 'revision:one' },
  occurredAt: createdAt
};
function backup(
  projectSnapshot: CollaborationSnapshot = snapshot,
  audits: readonly AuditEvent[] = [readinessAudit]
): ProjectBackup {
  const document: ProjectBackup['document'] = {
    format: 'selene-project-backup/v1',
    projectId,
    tenantId,
    latestRevisionId: projectSnapshot.revisions.at(-1)!.id,
    exportedAt: createdAt,
    expiresAt: '2026-10-30T12:00:00.000Z',
    restoreOwnerId: 'owner:alpha',
    snapshot: projectSnapshot,
    audits,
    exclusions: projectBackupExclusions
  };
  return {
    document,
    sha256: createHash('sha256').update(canonicalBackupJson(document)).digest('hex')
  };
}

describe('project backup readiness audit scope', () => {
  it('includes the active baseline and preserves its complete immutable readiness audit', () => {
    expect(projectBackupResourceIds(snapshot)).toEqual([projectId, 'revision:one', baselineId]);
    expect(parseProjectBackup(backup()).document.audits).toEqual([readinessAudit]);
  });
  it('preserves every readiness audit field through encrypted backup verification', async () => {
    const value = backup();
    const encrypted = await encryptProjectBackup(value, 'readiness-passphrase-2026');
    expect(encrypted).not.toContain(baselineId);
    expect(encrypted).not.toContain(readinessAudit.id);
    expect(await decryptProjectBackup(encrypted, 'readiness-passphrase-2026')).toEqual(value);
  });
  it('keeps the active baseline audit when later design changes make review stale', () => {
    const changed: CollaborationSnapshot = {
      ...snapshot,
      revisions: [
        ...snapshot.revisions,
        {
          ...snapshot.revisions[0]!,
          id: 'revision:two',
          sequence: 2,
          parentRevisionId: 'revision:one',
          content: { source: 'Changed design' },
          contentSha256: 'b'.repeat(64)
        }
      ],
      designReviewState: {
        ...readyState,
        currency: 'stale',
        approvalsStale: true,
        changesSinceBaseline: [
          {
            id: 'change:one',
            kind: 'source',
            beforeRevision: readyState.baseline!.revision,
            currentRevision: { id: 'revision:two', fingerprint: 'b'.repeat(64) },
            affected: {
              projectId,
              screenIds: [],
              routePaths: [],
              scenarioIds: [],
              componentIds: [],
              stableNodeIds: []
            },
            evidence: [{ description: 'Reviewed source change.' }],
            provenance: { kind: 'actor', actorId: 'owner:alpha' },
            reason: 'Update the design source.',
            occurredAt: createdAt
          }
        ]
      }
    };
    expect(parseProjectBackup(backup(changed)).document.audits).toEqual([readinessAudit]);
  });
  it('adds no baseline resource when the projection is absent or draft', () => {
    const { designReviewState: _state, ...withoutState } = snapshot;
    const draft: CollaborationSnapshot = {
      ...withoutState,
      designReviewState: {
        format: 'selene-design-review-state/v1',
        projectId,
        readiness: 'draft',
        currency: 'none',
        approvalsStale: false,
        changesSinceBaseline: []
      }
    };
    for (const value of [withoutState, draft]) {
      expect(projectBackupResourceIds(value)).toEqual([projectId, 'revision:one']);
      expect(parseProjectBackup(backup(value, [])).document.audits).toEqual([]);
      expect(() => parseProjectBackup(backup(value))).toThrow('Backup audit scope is invalid');
    }
  });
  it.each([{ resourceId: 'baseline:unrelated' }, { organizationId: 'tenant:other' }])(
    'rejects a readiness audit outside the snapshot or tenant: %j',
    (change) => {
      expect(() =>
        parseProjectBackup(backup(snapshot, [{ ...readinessAudit, ...change }]))
      ).toThrow('Backup audit scope is invalid');
    }
  );
  it.each([
    { ...readyState, projectId: 'project:other' },
    { ...readyState, baseline: { ...readyState.baseline!, projectId: 'project:other' } },
    { ...readyState, readiness: 'ready-for-handoff' as const }
  ])(
    'rejects invalid or foreign readiness projections before accepting their audit: %j',
    (state) => {
      expect(() => parseProjectBackup(backup({ ...snapshot, designReviewState: state }))).toThrow();
    }
  );
});
