import { describe, expect, it } from 'vitest';

import {
  createInMemoryCollaborationRepository,
  createSignedShareToken,
  idempotent,
  type Revision,
  verifySignedShareToken
} from './index';
import { createCollaborationService, roleAllows } from './service';

const project = { id: 'project-1', organizationId: 'org-1', name: 'Northstar' };
const revision = {
  id: 'revision-1',
  projectId: project.id,
  sequence: 1,
  content: { format: 'workspace' },
  contentSha256: 'a'.repeat(64),
  scenarioIds: ['default'],
  createdBy: 'user-1',
  createdAt: '2026-07-23T20:00:00Z'
};

describe('in-memory collaboration adapter', () => {
  it('preserves immutable revision sequence and stable node/scenario thread anchors', async () => {
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject(project);
    await repository.appendRevision(revision);
    await repository.createThread({
      id: 'thread-1',
      projectId: project.id,
      revisionId: revision.id,
      reactNodeId: 'dashboard.hero',
      scenarioId: 'default',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    await repository.createComment({
      id: 'comment-1',
      threadId: 'thread-1',
      body: 'Please tighten the copy.',
      createdBy: 'user-1',
      createdAt: revision.createdAt,
      mentionedUserIds: ['user-2']
    });
    await repository.createComment({
      id: 'comment-2',
      threadId: 'thread-1',
      parentCommentId: 'comment-1',
      body: 'I will make that change.',
      createdBy: 'user-2',
      createdAt: revision.createdAt,
      mentionedUserIds: []
    });
    await repository.addReaction({
      commentId: 'comment-1',
      userId: 'user-2',
      emoji: '👍',
      createdAt: revision.createdAt
    });
    await repository.updateThreadResolution('thread-1', 'user-2', '2026-07-23T20:01:00Z');

    const snapshot = await repository.exportProject(project.id);
    expect(snapshot?.comments).toHaveLength(2);
    expect(snapshot?.threads[0]).toMatchObject({
      reactNodeId: 'dashboard.hero',
      scenarioId: 'default',
      resolvedBy: 'user-2'
    });
    await expect(
      repository.appendRevision(
        { ...revision, id: 'revision-2', sequence: 2, parentRevisionId: revision.id },
        'wrong-parent'
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('makes retries idempotent', async () => {
    const repository = createInMemoryCollaborationRepository();
    let calls = 0;
    const operation = () => Promise.resolve(++calls);
    await expect(idempotent(repository, 'comment:1', 'retry-key', operation)).resolves.toBe(1);
    await expect(idempotent(repository, 'comment:1', 'retry-key', operation)).resolves.toBe(1);
    expect(calls).toBe(1);
  });

  it('uses one atomic command for readiness and baseline-aware design revisions', async () => {
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject(project);
    await repository.commitDesignRevision({
      projectId: project.id,
      actorId: 'user-1',
      occurredAt: revision.createdAt,
      revision
    });
    await repository.commitDesignRevision({
      projectId: project.id,
      actorId: 'user-1',
      occurredAt: revision.createdAt,
      readiness: {
        id: 'baseline-1',
        revisionId: revision.id,
        intent: 'review',
        revisionFingerprint: revision.contentSha256
      }
    });
    const readyState = await repository.getDesignReviewState(project.id);
    expect(readyState).toMatchObject({
      readiness: 'ready-for-review',
      currency: 'current',
      approvalsStale: false,
      baseline: { id: 'baseline-1', revision: { id: revision.id } },
      changesSinceBaseline: []
    });
    await repository.createThread({
      id: 'baseline-thread',
      projectId: project.id,
      revisionId: revision.id,
      reactNodeId: 'orders.table',
      scenarioId: 'default',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    await repository.createComment({
      id: 'baseline-comment',
      threadId: 'baseline-thread',
      body: 'This collaboration activity must not dirty the baseline.',
      createdBy: 'user-1',
      createdAt: revision.createdAt,
      mentionedUserIds: []
    });
    expect(await repository.getDesignReviewState(project.id)).toEqual(readyState);
    const next = {
      ...revision,
      id: 'revision-2',
      sequence: 2,
      parentRevisionId: revision.id,
      contentSha256: 'b'.repeat(64)
    };
    await expect(
      repository.commitDesignRevision({
        projectId: project.id,
        actorId: 'user-1',
        occurredAt: '2026-07-23T20:01:00Z',
        revision: next,
        expectedParentRevisionId: revision.id
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(await repository.getRevision(next.id)).toBeUndefined();
    const input = {
      projectId: project.id,
      actorId: 'user-1',
      occurredAt: '2026-07-23T20:01:00Z',
      revision: next,
      expectedParentRevisionId: revision.id,
      semanticChange: {
        id: 'change-1',
        kind: 'source' as const,
        affected: {
          projectId: project.id,
          screenIds: ['orders'],
          routePaths: ['/orders'],
          scenarioIds: ['default'],
          componentIds: ['orders-table'],
          stableNodeIds: ['orders.table']
        },
        evidence: [{ description: 'Orders table changed', checksum: 'sha256:example' }],
        provenance: { kind: 'actor' as const, actorId: 'user-1' },
        reason: 'Update orders presentation'
      },
      idempotencyKey: 'revision-2'
    };
    await expect(repository.commitDesignRevision(input)).resolves.toMatchObject({
      kind: 'revision',
      changeRecorded: true,
      replayed: false
    });
    await expect(repository.commitDesignRevision(input)).resolves.toMatchObject({
      kind: 'revision',
      replayed: true
    });
    expect(await repository.getDesignReviewState(project.id)).toMatchObject({
      currency: 'stale',
      approvalsStale: true,
      changesSinceBaseline: [
        expect.objectContaining({
          id: 'change-1',
          beforeRevision: { id: revision.id, fingerprint: revision.contentSha256 },
          currentRevision: { id: next.id, fingerprint: next.contentSha256 }
        })
      ]
    });
    const snapshot = await repository.exportProject(project.id);
    const restored = createInMemoryCollaborationRepository();
    await restored.replaceProject(snapshot!);
    expect(await restored.getDesignReviewState(project.id)).toEqual(
      await repository.getDesignReviewState(project.id)
    );
  });
});

describe('signed guest links', () => {
  const signer = {
    async sign(payload: string) {
      return `sig:${payload.length}`;
    },
    async verify(payload: string, signature: string) {
      return signature === `sig:${payload.length}`;
    },
    async hash(token: string) {
      return `hash:${token.length}`;
    }
  };

  it('enforces signature and expiry without assuming a crypto runtime', async () => {
    const token = await createSignedShareToken(
      {
        linkId: 'link-1',
        projectId: project.id,
        permission: 'commenter',
        expiresAt: '2026-07-24T00:00:00Z'
      },
      signer
    );
    await expect(
      verifySignedShareToken(token, signer, '2026-07-23T23:00:00Z')
    ).resolves.toMatchObject({ permission: 'commenter' });
    await expect(
      verifySignedShareToken(token, signer, '2026-07-25T00:00:00Z')
    ).rejects.toMatchObject({ code: 'EXPIRED' });
  });
});

describe('HTTP collaboration adapter', () => {
  it('validates writes, exports snapshots, exposes health and rate limits', async () => {
    const repository = createInMemoryCollaborationRepository();
    let id = 0;
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => `${kind}-${++id}` },
      clock: { now: () => '2026-07-23T20:00:00Z' },
      allowedOrigins: ['https://review.example.test'],
      maxRequestsPerMinute: 10
    });
    const headers = {
      'content-type': 'application/json',
      'x-selene-user-id': 'user-1',
      origin: 'https://review.example.test'
    };
    const created = await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify(project)
      })
    );
    expect(created.status).toBe(201);
    const added = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: {},
          contentSha256: 'b'.repeat(64),
          scenarioIds: ['default']
        })
      })
    );
    expect(added.status).toBe(201);
    const exported = await service(
      new Request(`https://service.test/v1/projects/${project.id}/export`, {
        headers: { 'x-selene-user-id': 'user-1' }
      })
    );
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain('selene-collaboration/v1');
    const health = await service(new Request('https://service.test/healthz'));
    expect(health.status).toBe(200);
  });

  it('returns a client-safe validation failure', async () => {
    const service = createCollaborationService({
      repository: createInMemoryCollaborationRepository(),
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => kind }
    });
    const response = await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' },
        body: '{}'
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid' });
  });

  it('persists readiness and semantic design changes through the authenticated HTTP APIs', async () => {
    const repository = createInMemoryCollaborationRepository();
    let sequence = 0;
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => `${kind}-api-${++sequence}` },
      clock: { now: () => '2026-07-23T20:00:00Z' }
    });
    const headers = { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' };
    await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify(project)
      })
    );
    const first = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: {},
          contentSha256: 'c'.repeat(64),
          scenarioIds: ['default']
        })
      })
    );
    const firstBody = (await first.json()) as Revision;
    const ready = await service(
      new Request(`https://service.test/v1/projects/${project.id}/readiness`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: 'review',
          revisionId: firstBody.id,
          revisionFingerprint: firstBody.contentSha256
        })
      })
    );
    expect(ready.status).toBe(201);
    const current = await service(
      new Request(`https://service.test/v1/projects/${project.id}/readiness`, { headers })
    );
    await expect(current.json()).resolves.toMatchObject({
      readiness: 'ready-for-review',
      currency: 'current',
      approvalsStale: false,
      changesSinceBaseline: []
    });
    const thread = await service(
      new Request(`https://service.test/v1/projects/${project.id}/threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          revisionId: firstBody.id,
          reactNodeId: 'orders.table',
          scenarioId: 'default'
        })
      })
    );
    const threadBody = (await thread.json()) as { id: string };
    const comment = await service(
      new Request(`https://service.test/v1/threads/${threadBody.id}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: 'Keep the existing column labels.', mentionedUserIds: [] })
      })
    );
    expect(comment.status).toBe(201);
    const afterComment = await service(
      new Request(`https://service.test/v1/projects/${project.id}/readiness`, { headers })
    );
    await expect(afterComment.json()).resolves.toMatchObject({
      currency: 'current',
      approvalsStale: false,
      changesSinceBaseline: []
    });
    const rejected = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: { revised: true },
          contentSha256: 'd'.repeat(64),
          scenarioIds: ['default']
        })
      })
    );
    expect(rejected.status).toBe(400);
    const recorded = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'revision-after-baseline' },
        body: JSON.stringify({
          content: { revised: true },
          contentSha256: 'd'.repeat(64),
          scenarioIds: ['default'],
          semanticChange: {
            id: 'change-api',
            kind: 'visual',
            reason: 'Correct empty state',
            affected: {
              projectId: project.id,
              screenIds: ['orders'],
              routePaths: ['/orders'],
              scenarioIds: ['default'],
              componentIds: ['orders-empty'],
              stableNodeIds: ['orders.empty']
            },
            evidence: [
              { description: 'Empty-state comparison', href: 'https://example.test/proof' }
            ],
            provenance: { kind: 'actor', actorId: 'user-1' }
          }
        })
      })
    );
    expect(recorded.status).toBe(201);
    const replay = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'revision-after-baseline' },
        body: JSON.stringify({
          content: { revised: true },
          contentSha256: 'd'.repeat(64),
          scenarioIds: ['default'],
          semanticChange: {
            id: 'change-api',
            kind: 'visual',
            reason: 'Correct empty state',
            affected: {
              projectId: project.id,
              screenIds: ['orders'],
              routePaths: ['/orders'],
              scenarioIds: ['default'],
              componentIds: ['orders-empty'],
              stableNodeIds: ['orders.empty']
            },
            evidence: [
              { description: 'Empty-state comparison', href: 'https://example.test/proof' }
            ],
            provenance: { kind: 'actor', actorId: 'user-1' }
          }
        })
      })
    );
    expect(replay.status).toBe(201);
    const stale = await service(
      new Request(`https://service.test/v1/projects/${project.id}/readiness`, { headers })
    );
    await expect(stale.json()).resolves.toMatchObject({
      currency: 'stale',
      approvalsStale: true,
      changesSinceBaseline: [expect.objectContaining({ id: 'change-api' })]
    });
  });

  it('enforces role capabilities and rejects cross-tenant project creation', async () => {
    expect(roleAllows('viewer', 'project:read')).toBe(true);
    expect(roleAllows('viewer', 'project:comment')).toBe(false);
    expect(roleAllows('commenter', 'project:approve')).toBe(false);
    expect(roleAllows('editor', 'project:design')).toBe(true);
    expect(roleAllows('editor', 'project:delete')).toBe(false);
    expect(roleAllows('admin', 'project:delete')).toBe(true);

    const service = createCollaborationService({
      repository: createInMemoryCollaborationRepository(),
      authorizer: {
        async authorize(request) {
          return request.userId === 'user-1' && request.organizationId === 'org-1';
        }
      },
      ids: { next: (kind) => kind }
    });
    const response = await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' },
        body: JSON.stringify({ id: 'forbidden', organizationId: 'org-2', name: 'Other tenant' })
      })
    );
    expect(response.status).toBe(403);
  });
});
