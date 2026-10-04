import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalBackupJson,
  projectBackupExclusions,
  projectSnapshotIdentity,
  type ProjectBackup,
  type ProjectRestoreReceipt
} from '../../collaboration-service/src/project-backup-contract';
import {
  createProjectRecoveryBrowserClient,
  decryptProjectBackup,
  encryptProjectBackup,
  verifyProjectBackup
} from './project-recovery-model';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function backup(): ProjectBackup {
  const document: ProjectBackup['document'] = {
    format: 'selene-project-backup/v1',
    projectId: 'project:alpha',
    tenantId: 'tenant:alpha',
    latestRevisionId: 'revision:one',
    exportedAt: '2026-09-30T12:00:00.000Z',
    expiresAt: '2026-10-30T12:00:00.000Z',
    restoreOwnerId: 'owner:alpha',
    snapshot: {
      format: 'selene-collaboration/v2',
      project: {
        id: 'project:alpha',
        organizationId: 'tenant:alpha',
        name: 'Literal recovery fixture'
      },
      revisions: [
        {
          id: 'revision:one',
          projectId: 'project:alpha',
          sequence: 1,
          content: { text: 'Retain this literal content.' },
          contentSha256: 'a'.repeat(64),
          scenarioIds: [],
          createdBy: 'owner:alpha',
          createdAt: '2026-09-30T12:00:00.000Z'
        }
      ],
      threads: [],
      comments: [],
      reactions: [],
      approvals: [],
      reviewThreads: [],
      aiChangeRequests: [],
      developerAnnotations: []
    },
    audits: [
      {
        id: 'audit:one',
        organizationId: 'tenant:alpha',
        actorId: 'owner:alpha',
        action: 'project.created',
        resourceType: 'project',
        resourceId: 'project:alpha',
        metadata: { projectId: 'project:alpha' },
        occurredAt: '2026-09-30T12:00:00.000Z'
      }
    ],
    exclusions: projectBackupExclusions
  };
  return { document, sha256: digest(canonicalBackupJson(document)) };
}
function receipt(value: ProjectBackup): ProjectRestoreReceipt {
  return {
    format: 'selene-project-restore-receipt/v1',
    projectId: 'project:alpha',
    tenantId: 'tenant:alpha',
    previousRevisionId: 'revision:current',
    restoredRevisionId: 'revision:one',
    snapshotSha256: digest(projectSnapshotIdentity(value.document.snapshot)),
    preservedAuditIds: ['audit:one'],
    restoreAuditId: 'audit:restored',
    restoredAt: '2026-09-30T13:00:00.000Z'
  };
}

describe('encrypted browser project recovery', () => {
  it('encrypts actual content and identities, then verifies the literal decrypted backup', async () => {
    const value = backup();
    const encrypted = await encryptProjectBackup(value, 'fixture-passphrase-2026');
    expect(encrypted).not.toContain('Retain this literal content.');
    expect(encrypted).not.toContain('tenant:alpha');
    expect(await decryptProjectBackup(encrypted, 'fixture-passphrase-2026')).toEqual(value);
    await expect(decryptProjectBackup(encrypted, 'wrong-passphrase-2026')).rejects.toThrow(
      'could not be decrypted or verified'
    );
    await expect(verifyProjectBackup({ ...value, sha256: '0'.repeat(64) })).rejects.toThrow(
      'checksum'
    );
  });
  it('encodes stable IDs and preserves exact CAS and credential requirements', async () => {
    const value = backup();
    const calls: { url: string; options?: RequestInit }[] = [];
    const expected = receipt(value);
    const transport: typeof fetch = async (input, options) => {
      calls.push({ url: String(input), ...(options === undefined ? {} : { options }) });
      return Response.json(calls.length === 1 ? value : expected);
    };
    const client = createProjectRecoveryBrowserClient('https://service.test', transport);
    expect(await client.backup('project:alpha', 7)).toEqual(value);
    expect(await client.restore(value, 'revision:current')).toEqual(expected);
    expect(calls.map((call) => call.url)).toEqual([
      'https://service.test/v1/projects/project%3Aalpha/backup?retentionDays=7',
      'https://service.test/v1/projects/project%3Aalpha/restore'
    ]);
    expect(calls[1]?.options).toMatchObject({
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      body: JSON.stringify({ backup: value, expectedRevisionId: 'revision:current' })
    });
  });
  it.each([
    { snapshotSha256: 'b'.repeat(64) },
    { preservedAuditIds: [] },
    { preservedAuditIds: ['audit:one', 'audit:one'] },
    { previousRevisionId: 'revision:stale' },
    { tenantId: 'tenant:other' },
    { restoreAuditId: 'bad/identity' },
    { restoredAt: 'invalid timestamp' }
  ])('rejects forged restore receipt field %j', async (change) => {
    const value = backup();
    const client = createProjectRecoveryBrowserClient('https://service.test', async () =>
      Response.json({ ...receipt(value), ...change })
    );
    await expect(client.restore(value, 'revision:current')).rejects.toThrow('Restore receipt');
  });
  it('reports stale revisions without reflecting server failure details', async () => {
    const client = createProjectRecoveryBrowserClient('https://service.test', async () =>
      Response.json({ secret: 'PRIVATE SERVER DETAIL' }, { status: 409 })
    );
    await expect(client.restore(backup(), 'revision:current')).rejects.toThrow(
      'Refresh its revision'
    );
  });
});
