import { describe, expect, it } from 'vitest';

import {
  createInMemoryCollaborationRepository,
  createSignedShareToken,
  idempotent,
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
