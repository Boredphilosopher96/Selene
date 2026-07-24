import { describe, expect, it } from 'vitest';

import {
  clusterReviewThreads,
  createInMemoryCollaborationRepository,
  createSignedShareToken,
  idempotent,
  parseDesignReviewState,
  parseSnapshot,
  type Revision,
  validateAIChangeRequestTransition,
  validateDeveloperAnnotation,
  validateReviewDeepLink,
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

  it('clusters normalized review anchors deterministically', () => {
    const thread = (id: string, x: number, y: number) => ({
      id,
      projectId: project.id,
      anchor: {
        evidence: {
          artifactId: 'artifact',
          screenId: 'screen',
          revisionId: revision.id,
          revisionFingerprint: revision.contentSha256,
          viewport: { width: 100, height: 100, zoom: 1 }
        },
        lifecycle: 'current' as const,
        target: { kind: 'point' as const, point: { x, y } }
      },
      messages: [
        {
          id: `${id}-message`,
          body: 'Note',
          createdBy: 'user-1',
          createdAt: revision.createdAt,
          mentionedUserIds: [],
          reactions: [],
          readBy: []
        }
      ],
      deepLink: `/projects/${project.id}`,
      lifecycle: 'open' as const,
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    expect(clusterReviewThreads([thread('b', 0.12, 0.12), thread('a', 0.11, 0.11)], 0.1)).toEqual([
      {
        key: '1:1',
        threadIds: ['a', 'b'],
        centroid: { x: 0.11499999999999999, y: 0.11499999999999999 }
      }
    ]);
  });

  it('enforces structural AI transitions, review resolution, and same-thread parents', async () => {
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject(project);
    await repository.appendRevision(revision);
    const otherProject = { id: 'project-2', organizationId: 'org-1', name: 'Elsewhere' };
    const otherRevision = { ...revision, id: 'revision-2', projectId: otherProject.id };
    await repository.createProject(otherProject);
    await repository.appendRevision(otherRevision);
    const anchor = {
      evidence: {
        artifactId: 'artifact-1',
        screenId: 'screen-1',
        revisionId: revision.id,
        revisionFingerprint: revision.contentSha256,
        viewport: { width: 1440, height: 900, zoom: 1 },
        scenarioId: 'default'
      },
      target: { kind: 'region' as const, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } },
      lifecycle: 'mapped' as const,
      mappedFrom: {
        artifactId: 'artifact-0',
        screenId: 'screen-0',
        revisionId: 'revision-0',
        revisionFingerprint: '0'.repeat(64),
        viewport: { width: 1280, height: 800, zoom: 1 }
      }
    };
    await repository.createReviewThread({
      id: 'review-thread-1',
      projectId: project.id,
      anchor,
      deepLink: 'https://review.example.test/project-1',
      lifecycle: 'open',
      createdBy: 'user-1',
      createdAt: revision.createdAt,
      messages: [
        {
          id: 'review-message-1',
          body: 'Keep this visual hierarchy.',
          createdBy: 'user-1',
          createdAt: revision.createdAt,
          mentionedUserIds: [],
          reactions: [],
          readBy: ['user-1']
        },
        {
          id: 'review-message-2',
          parentMessageId: 'review-message-1',
          body: 'Acknowledged.',
          createdBy: 'user-2',
          createdAt: revision.createdAt,
          mentionedUserIds: [],
          reactions: [],
          readBy: []
        }
      ]
    });
    const leakedThread = await repository.getReviewThread('review-thread-1');
    if (!leakedThread) throw new Error('Expected review thread');
    Reflect.set(leakedThread.messages[0]!, 'body', 'Mutated caller copy');
    await expect(repository.getReviewThread('review-thread-1')).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ body: 'Keep this visual hierarchy.' })
      ])
    });
    await expect(
      repository.resolveReviewThread('review-thread-1', 'user-2', '2026-07-23T20:01:00Z')
    ).resolves.toMatchObject({ lifecycle: 'resolved', resolvedBy: 'user-2' });
    await expect(
      repository.createReviewThread({
        ...leakedThread,
        id: 'review-thread-missing-move-time',
        movedBy: 'user-1'
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    await expect(repository.resolveReviewThread('review-thread-1', 'user-2')).rejects.toMatchObject(
      {
        code: 'CONFLICT'
      }
    );
    const queued = {
      id: 'ai-change-1',
      projectId: project.id,
      anchor,
      instruction: 'Make the primary action more prominent.',
      provider: { providerId: 'provider-1', capability: 'design-edit', model: 'v1' },
      baseRevision: { id: revision.id, fingerprint: revision.contentSha256 },
      lifecycle: 'queued' as const,
      createdBy: 'user-1',
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt
    };
    const callerOwnedQueued = structuredClone(queued);
    await repository.createAIChangeRequest(callerOwnedQueued);
    Reflect.set(callerOwnedQueued.provider, 'model', 'caller-mutated');
    const fetchedQueued = await repository.getAIChangeRequest(queued.id);
    if (!fetchedQueued) throw new Error('Expected AI change request');
    Reflect.set(fetchedQueued.provider, 'model', 'reader-mutated');
    await expect(repository.getAIChangeRequest(queued.id)).resolves.toMatchObject({
      provider: { model: 'v1' }
    });
    await expect(
      repository.updateAIChangeRequest({
        ...queued,
        anchor: structuredClone(anchor),
        provider: structuredClone(queued.provider),
        baseRevision: { ...queued.baseRevision },
        lifecycle: 'running',
        updatedAt: '2026-07-23T20:01:00Z'
      })
    ).resolves.toMatchObject({ lifecycle: 'running' });
    await expect(
      repository.updateAIChangeRequest({
        ...queued,
        lifecycle: 'running',
        anchor: { ...anchor, target: { kind: 'point', point: { x: 0.2, y: 0.2 } } },
        updatedAt: '2026-07-23T20:01:00Z'
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    const running = await repository.getAIChangeRequest(queued.id);
    if (!running) throw new Error('Expected running AI change request');
    const appliedResult = {
      revisionId: revision.id,
      revisionFingerprint: revision.contentSha256,
      diff: 'Applied patch.',
      completedAt: '2026-07-23T20:02:00Z'
    };
    await expect(
      repository.updateAIChangeRequest({
        ...running,
        lifecycle: 'applied',
        updatedAt: '2026-07-23T20:02:00Z',
        result: {
          ...appliedResult,
          revisionId: otherRevision.id,
          revisionFingerprint: otherRevision.contentSha256
        }
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const applied = await repository.updateAIChangeRequest({
      ...running,
      lifecycle: 'applied',
      updatedAt: '2026-07-23T20:02:00Z',
      result: appliedResult
    });
    await expect(
      repository.updateAIChangeRequest({
        ...applied,
        lifecycle: 'undone',
        updatedAt: '2026-07-23T20:03:00Z',
        undoResult: { ...appliedResult, revisionFingerprint: 'b'.repeat(64) }
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(() =>
      validateAIChangeRequestTransition(running, { ...running, createdBy: 'user-2' })
    ).toThrow(/identity and audit ownership/);
    expect(() =>
      validateAIChangeRequestTransition(running, {
        ...running,
        updatedAt: '2026-07-23T19:59:59Z'
      })
    ).toThrow(/updatedAt/);
    const annotation = {
      id: 'annotation-1',
      projectId: project.id,
      anchor,
      category: 'development' as const,
      body: 'Keep this handoff clear.',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    };
    await repository.createDeveloperAnnotation(annotation);
    Reflect.set(annotation, 'body', 'Mutated caller annotation');
    const listedAnnotations = await repository.listDeveloperAnnotations(project.id);
    Reflect.set(listedAnnotations[0]!, 'body', 'Mutated returned annotation');
    await expect(repository.listDeveloperAnnotations(project.id)).resolves.toEqual([
      expect.objectContaining({ body: 'Keep this handoff clear.' })
    ]);
    const missingTimestamp = { ...annotation, id: 'annotation-2' };
    Reflect.deleteProperty(missingTimestamp, 'createdAt');
    expect(() => validateDeveloperAnnotation(missingTimestamp, revision)).toThrow(/createdAt/);
    const invalidCategory = { ...annotation, id: 'annotation-3' };
    Reflect.set(invalidCategory, 'category', 'invalid');
    expect(() => validateDeveloperAnnotation(invalidCategory, revision)).toThrow(/category/);
    await repository.createThread({
      id: 'thread-1',
      projectId: project.id,
      revisionId: revision.id,
      reactNodeId: 'hero',
      scenarioId: 'default',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    await repository.createThread({
      id: 'thread-2',
      projectId: project.id,
      revisionId: revision.id,
      reactNodeId: 'footer',
      scenarioId: 'default',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    await repository.createComment({
      id: 'comment-1',
      threadId: 'thread-1',
      body: 'Parent',
      createdBy: 'user-1',
      createdAt: revision.createdAt,
      mentionedUserIds: []
    });
    await expect(
      repository.createComment({
        id: 'comment-2',
        threadId: 'thread-2',
        parentCommentId: 'comment-1',
        body: 'Cross-thread',
        createdBy: 'user-1',
        createdAt: revision.createdAt,
        mentionedUserIds: []
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    const snapshot = await repository.exportProject(project.id);
    const malformed = structuredClone(snapshot!);
    malformed.reviewThreads[0]!.anchor.target = {
      kind: 'region',
      region: { x: 0.8, y: 0.1, width: 0.3, height: 0.2 }
    };
    expect(() => parseSnapshot(JSON.stringify(malformed))).toThrow(/valid snapshot/);
  });

  it('uses one atomic command for readiness and baseline-aware design revisions', async () => {
    const repository = createInMemoryCollaborationRepository();
    await repository.createProject(project);
    await repository.commitDesignRevision({
      kind: 'append-revision',
      projectId: project.id,
      actorId: 'user-1',
      occurredAt: revision.createdAt,
      revision
    });
    await repository.commitDesignRevision({
      kind: 'mark-ready',
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
        kind: 'append-revision',
        projectId: project.id,
        actorId: 'user-1',
        occurredAt: '2026-07-23T20:01:00Z',
        revision: next,
        expectedParentRevisionId: revision.id
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(await repository.getRevision(next.id)).toBeUndefined();
    const input = {
      kind: 'append-revision' as const,
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

  it('keeps the baseline command contract and read model fail-closed', async () => {
    const repository = createInMemoryCollaborationRepository();
    expect(await repository.getDesignReviewState('missing-project')).toBeUndefined();
    await repository.createProject(project);
    await expect(
      repository.replaceProject({
        format: 'selene-collaboration/v1',
        project,
        revisions: [],
        threads: [],
        comments: [],
        reactions: [],
        approvals: [],
        designReviewState: {
          format: 'selene-design-review-state/v1',
          projectId: project.id,
          readiness: 'draft',
          currency: 'current',
          approvalsStale: false,
          changesSinceBaseline: []
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID' });
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

describe('collaboration snapshot wire format', () => {
  const validStaleReviewState = () => ({
    format: 'selene-design-review-state/v1',
    projectId: project.id,
    readiness: 'ready-for-review',
    currency: 'stale',
    approvalsStale: true,
    baseline: {
      id: 'baseline-1',
      projectId: project.id,
      revision: { id: revision.id, fingerprint: revision.contentSha256 },
      intent: 'review',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    },
    changesSinceBaseline: [
      {
        id: 'change-1',
        kind: 'visual',
        beforeRevision: { id: revision.id, fingerprint: revision.contentSha256 },
        currentRevision: { id: 'revision-2', fingerprint: 'b'.repeat(64) },
        affected: {
          projectId: project.id,
          screenIds: ['orders'],
          routePaths: ['/orders'],
          scenarioIds: ['default'],
          componentIds: ['orders-table'],
          stableNodeIds: ['orders.table']
        },
        evidence: [{ description: 'Reviewed screenshot', checksum: 'sha256:example' }],
        provenance: { kind: 'agent', agentId: 'selene-agent', promptDigest: 'sha256:prompt' },
        reason: 'Align the table with the approved visual design.',
        occurredAt: '2026-07-23T20:01:00Z'
      }
    ]
  });

  it('parses only a versioned, nested-valid review read model', () => {
    expect(parseDesignReviewState(validStaleReviewState())).toMatchObject({
      format: 'selene-design-review-state/v1',
      baseline: { projectId: project.id, intent: 'review' },
      changesSinceBaseline: [{ provenance: { kind: 'agent' } }]
    });
  });

  it('rejects mismatched readiness intent and malformed nested scope, evidence, and provenance', () => {
    const invalidValues = [
      {
        ...validStaleReviewState(),
        readiness: 'ready-for-handoff'
      },
      {
        ...validStaleReviewState(),
        changesSinceBaseline: [
          {
            ...validStaleReviewState().changesSinceBaseline[0],
            affected: {
              ...validStaleReviewState().changesSinceBaseline[0].affected,
              projectId: 'other'
            }
          }
        ]
      },
      {
        ...validStaleReviewState(),
        changesSinceBaseline: [
          {
            ...validStaleReviewState().changesSinceBaseline[0],
            evidence: [{ description: '' }]
          }
        ]
      },
      {
        ...validStaleReviewState(),
        changesSinceBaseline: [
          {
            ...validStaleReviewState().changesSinceBaseline[0],
            provenance: { kind: 'agent', agentId: 'selene-agent', promptDigest: '' }
          }
        ]
      }
    ];
    for (const value of invalidValues)
      expect(() => parseDesignReviewState(value)).toThrow(/design|Design|prompt digest/i);
  });

  it('rejects malformed baseline projections instead of exposing an invalid public read model', () => {
    expect(() =>
      parseSnapshot(
        JSON.stringify({
          format: 'selene-collaboration/v1',
          project,
          revisions: [],
          threads: [],
          comments: [],
          reactions: [],
          approvals: [],
          designReviewState: {
            projectId: project.id,
            readiness: 'ready-for-review',
            currency: 'stale',
            approvalsStale: false,
            changesSinceBaseline: []
          }
        })
      )
    ).toThrow(/valid snapshot/);
  });

  it('normalizes pre-undoResult snapshots and rejects oversized aggregate lists', () => {
    const appliedResult = {
      revisionId: revision.id,
      revisionFingerprint: revision.contentSha256,
      diff: 'legacy compensating patch',
      completedAt: revision.createdAt
    };
    const baseSnapshot = {
      format: 'selene-collaboration/v2',
      project,
      revisions: [revision],
      threads: [],
      comments: [],
      reactions: [],
      approvals: [],
      reviewThreads: [],
      aiChangeRequests: [
        {
          id: 'legacy-undone-request',
          projectId: project.id,
          anchor: {
            evidence: {
              artifactId: 'artifact',
              screenId: 'screen',
              revisionId: revision.id,
              revisionFingerprint: revision.contentSha256,
              viewport: { width: 100, height: 100, zoom: 1 }
            },
            lifecycle: 'current',
            target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
          },
          instruction: 'Restore the previous design.',
          provider: { providerId: 'legacy-provider', capability: 'design-edit' },
          baseRevision: { id: revision.id, fingerprint: revision.contentSha256 },
          lifecycle: 'undone',
          createdBy: 'user-1',
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
          result: appliedResult
        }
      ],
      developerAnnotations: []
    };
    expect(parseSnapshot(JSON.stringify(baseSnapshot))).toMatchObject({
      aiChangeRequests: [{ result: appliedResult, undoResult: appliedResult }]
    });
    expect(() =>
      parseSnapshot(
        JSON.stringify({
          ...baseSnapshot,
          reviewThreads: Array.from({ length: 10_001 }, () => ({}))
        })
      )
    ).toThrow(/valid snapshot/);
  });

  it('rejects duplicate collaboration aggregate identities and reaction tuples', () => {
    const anchor = {
      evidence: {
        artifactId: 'artifact',
        screenId: 'screen',
        revisionId: revision.id,
        revisionFingerprint: revision.contentSha256,
        viewport: { width: 100, height: 100, zoom: 1 }
      },
      lifecycle: 'current',
      target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
    };
    const baseline = {
      format: 'selene-collaboration/v2',
      project,
      revisions: [revision],
      threads: [
        {
          id: 'thread',
          projectId: project.id,
          revisionId: revision.id,
          reactNodeId: 'node',
          scenarioId: 'default',
          createdBy: 'user-1',
          createdAt: revision.createdAt
        }
      ],
      comments: [
        {
          id: 'comment',
          threadId: 'thread',
          body: 'Comment',
          createdBy: 'user-1',
          createdAt: revision.createdAt,
          mentionedUserIds: []
        }
      ],
      reactions: [],
      approvals: [],
      reviewThreads: [
        {
          id: 'review',
          projectId: project.id,
          anchor,
          messages: [
            {
              id: 'review-message',
              body: 'Review',
              createdBy: 'user-1',
              createdAt: revision.createdAt,
              mentionedUserIds: [],
              reactions: [],
              readBy: []
            }
          ],
          deepLink: '/projects/project-1',
          lifecycle: 'open',
          createdBy: 'user-1',
          createdAt: revision.createdAt
        }
      ],
      aiChangeRequests: [],
      developerAnnotations: [
        {
          id: 'annotation',
          projectId: project.id,
          anchor,
          category: 'content',
          body: 'Annotation',
          createdBy: 'user-1',
          createdAt: revision.createdAt
        }
      ]
    };
    const duplicateSnapshots = [
      { ...baseline, reviewThreads: [...baseline.reviewThreads, baseline.reviewThreads[0]] },
      {
        ...baseline,
        aiChangeRequests: [
          {
            id: 'request',
            projectId: project.id,
            anchor,
            instruction: 'Change it.',
            provider: { providerId: 'provider', capability: 'design-edit' },
            baseRevision: { id: revision.id, fingerprint: revision.contentSha256 },
            lifecycle: 'queued',
            createdBy: 'user-1',
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt
          },
          {
            id: 'request',
            projectId: project.id,
            anchor,
            instruction: 'Change it.',
            provider: { providerId: 'provider', capability: 'design-edit' },
            baseRevision: { id: revision.id, fingerprint: revision.contentSha256 },
            lifecycle: 'queued',
            createdBy: 'user-1',
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt
          }
        ]
      },
      {
        ...baseline,
        developerAnnotations: [...baseline.developerAnnotations, baseline.developerAnnotations[0]]
      },
      {
        ...baseline,
        reactions: [
          { commentId: 'comment', userId: 'user-1', emoji: '👍', createdAt: revision.createdAt },
          { commentId: 'comment', userId: 'user-1', emoji: '👍', createdAt: revision.createdAt }
        ]
      }
    ];
    for (const snapshot of duplicateSnapshots)
      expect(() => parseSnapshot(JSON.stringify(snapshot))).toThrow(/valid snapshot/);
  });

  it('rejects raw backslashes and control characters in portable relative deep links', () => {
    expect(() => validateReviewDeepLink('/\\evil.example')).toThrow(/unsafe path characters/);
    expect(() => validateReviewDeepLink('/safe\nroute')).toThrow(/unsafe path characters/);
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
    expect(await exported.text()).toContain('selene-collaboration/v2');
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

  it('bounds JSON request bodies before parsing aggregate input', async () => {
    const service = createCollaborationService({
      repository: createInMemoryCollaborationRepository(),
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => kind },
      maxRequestBodyBytes: 16
    });
    const response = await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' },
        body: JSON.stringify({ id: 'project-1', organizationId: 'org-1', name: 'Too large' })
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid' });
  });

  it('permits guest review comments, keeps guest audit actors anonymous, and rate-limits abuse', async () => {
    const repository = createInMemoryCollaborationRepository();
    const signer = {
      async sign() {
        return 'signature';
      },
      async verify(_payload: string, signature: string) {
        return signature === 'signature';
      },
      async hash(token: string) {
        return `hash:${token}`;
      }
    };
    const token = await createSignedShareToken(
      {
        linkId: 'share-1',
        projectId: project.id,
        permission: 'commenter',
        expiresAt: '2026-07-24T00:00:00Z'
      },
      signer
    );
    await repository.createProject(project);
    await repository.appendRevision(revision);
    await repository.createShareLink({
      id: 'share-1',
      projectId: project.id,
      tokenHash: await signer.hash(token),
      permission: 'commenter',
      expiresAt: '2026-07-24T00:00:00Z',
      createdBy: 'user-1',
      createdAt: revision.createdAt
    });
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return false;
        }
      },
      ids: { next: (kind) => `${kind}-guest` },
      clock: { now: () => revision.createdAt },
      shareSigner: signer,
      maxRequestsPerMinute: 2
    });
    const guestHeaders = { 'content-type': 'application/json', 'x-selene-share-token': token };
    const anchor = {
      evidence: {
        artifactId: 'artifact-guest',
        screenId: 'screen-guest',
        revisionId: revision.id,
        revisionFingerprint: revision.contentSha256,
        viewport: { width: 1200, height: 800, zoom: 1 },
        scenarioId: 'default'
      },
      lifecycle: 'current',
      target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
    };
    const created = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({
          anchor,
          deepLink: '/guest-review',
          body: 'Guest feedback.',
          mentionedUserIds: []
        })
      })
    );
    expect(created.status).toBe(201);
    expect((await repository.listEvents(project.id, 0, 10))[0]?.actorId).toBeUndefined();
    const restricted = await service(
      new Request(`https://service.test/v1/projects/${project.id}/developer-annotations`, {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ anchor, category: 'development', body: 'Not allowed.' })
      })
    );
    expect(restricted.status).toBe(403);
    const limited = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        headers: guestHeaders
      })
    );
    expect(limited.status).toBe(429);
  });

  it('parses complete mapped anchors and enforces normalized review-thread regions', async () => {
    const repository = createInMemoryCollaborationRepository();
    const service = createCollaborationService({
      repository,
      authorizer: {
        async authorize() {
          return true;
        }
      },
      ids: { next: (kind) => `${kind}-route` },
      clock: { now: () => revision.createdAt },
      allowedOrigins: ['https://review.example.test']
    });
    const headers = { 'content-type': 'application/json', 'x-selene-user-id': 'user-1' };
    await service(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify(project)
      })
    );
    const added = await service(
      new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: revision.id,
          content: revision.content,
          contentSha256: revision.contentSha256,
          scenarioIds: ['default']
        })
      })
    );
    expect(added.status).toBe(201);
    const anchor = {
      evidence: {
        artifactId: 'artifact-1',
        screenId: 'screen-1',
        revisionId: revision.id,
        revisionFingerprint: revision.contentSha256,
        viewport: { width: 1440, height: 900, zoom: 1 },
        scenarioId: 'default'
      },
      lifecycle: 'mapped',
      mappedFrom: {
        artifactId: 'artifact-0',
        screenId: 'screen-0',
        revisionId: 'revision-0',
        revisionFingerprint: '0'.repeat(64),
        viewport: { width: 1280, height: 800, zoom: 1 }
      },
      target: { kind: 'region', region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } }
    };
    const created = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor,
          deepLink: 'https://review.example.test/project-1',
          body: 'Please keep this placement.',
          mentionedUserIds: []
        })
      })
    );
    expect(created.status).toBe(201);
    const externalLink = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor,
          deepLink: 'https://outside.example.test/project-1',
          body: 'External deep link.',
          mentionedUserIds: []
        })
      })
    );
    expect(externalLink.status).toBe(400);
    const unsafeLink = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor,
          deepLink: 'javascript:alert(1)',
          body: 'Unsafe deep link.',
          mentionedUserIds: []
        })
      })
    );
    expect(unsafeLink.status).toBe(400);
    const escapedRelativeLink = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor,
          deepLink: '/\\evil.example',
          body: 'Unsafe normalized route.',
          mentionedUserIds: []
        })
      })
    );
    expect(escapedRelativeLink.status).toBe(400);
    const createdBody = (await created.json()) as { id: string; anchor: typeof anchor };
    expect(createdBody.anchor.mappedFrom.artifactId).toBe('artifact-0');
    const resolved = await service(
      new Request(`https://service.test/v1/review-threads/${createdBody.id}/resolve`, {
        method: 'POST',
        headers
      })
    );
    await expect(resolved.json()).resolves.toMatchObject({
      lifecycle: 'resolved',
      resolvedBy: 'user-1'
    });
    const reply = await service(
      new Request(`https://service.test/v1/review-threads/${createdBody.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'review-message-reply',
          body: 'Reply in the same thread.',
          mentionedUserIds: ['user-2']
        })
      })
    );
    expect(reply.status).toBe(200);
    const reacted = await service(
      new Request(
        `https://service.test/v1/review-threads/${createdBody.id}/messages/review-message-route/reactions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ emoji: '👍' })
        }
      )
    );
    expect(reacted.status).toBe(200);
    const unread = await service(
      new Request(
        `https://service.test/v1/review-threads/${createdBody.id}/messages/review-message-route/read`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ read: false })
        }
      )
    );
    await expect(unread.json()).resolves.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ readBy: [] })])
    });
    await service(
      new Request(
        `https://service.test/v1/review-threads/${createdBody.id}/messages/review-message-reply/read`,
        { method: 'POST', headers, body: JSON.stringify({ read: false }) }
      )
    );
    const reopened = await service(
      new Request(`https://service.test/v1/review-threads/${createdBody.id}/reopen`, {
        method: 'POST',
        headers
      })
    );
    expect(reopened.status).toBe(200);
    const moved = await service(
      new Request(`https://service.test/v1/review-threads/${createdBody.id}/move`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ anchor: { ...anchor, lifecycle: 'current', mappedFrom: undefined } })
      })
    );
    await expect(moved.json()).resolves.toMatchObject({ movedBy: 'user-1' });
    const listed = await service(
      new Request(
        `https://service.test/v1/projects/${project.id}/review-threads?lifecycle=open&screenId=screen-1&author=user-1&unread=true&clusterCellSize=0.1`,
        {
          headers
        }
      )
    );
    await expect(listed.json()).resolves.toMatchObject({
      threads: [expect.objectContaining({ deepLink: 'https://review.example.test/project-1' })],
      clusters: [expect.objectContaining({ threadIds: [createdBody.id] })]
    });
    const aiCreated = await service(
      new Request(`https://service.test/v1/projects/${project.id}/ai-change-requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor: { ...anchor, lifecycle: 'current', mappedFrom: undefined },
          instruction: 'Emphasize the action.',
          provider: { providerId: 'provider-1', capability: 'design-edit', model: 'v1' }
        })
      })
    );
    const ai = (await aiCreated.json()) as { id: string };
    expect(aiCreated.status).toBe(201);
    for (const body of [
      { action: 'start' },
      { action: 'fail', failureReason: 'provider unavailable' },
      { action: 'retry' },
      { action: 'start' },
      {
        action: 'apply',
        result: {
          revisionId: revision.id,
          revisionFingerprint: revision.contentSha256,
          diff: 'no-op',
          completedAt: revision.createdAt
        }
      }
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const transitioned = await service(
        new Request(`https://service.test/v1/ai-change-requests/${ai.id}/transition`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        })
      );
      expect(transitioned.status).toBe(200);
    }
    const undone = await service(
      new Request(`https://service.test/v1/ai-change-requests/${ai.id}/transition`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'undo',
          undoResult: {
            revisionId: revision.id,
            revisionFingerprint: revision.contentSha256,
            diff: 'compensating no-op',
            completedAt: revision.createdAt
          }
        })
      })
    );
    await expect(undone.json()).resolves.toMatchObject({
      lifecycle: 'undone',
      result: { diff: 'no-op' },
      undoResult: { diff: 'compensating no-op' }
    });
    const requests = await service(
      new Request(`https://service.test/v1/projects/${project.id}/ai-change-requests`, { headers })
    );
    await expect(requests.json()).resolves.toMatchObject({
      requests: [expect.objectContaining({ id: ai.id, lifecycle: 'undone' })]
    });
    const annotation = await service(
      new Request(`https://service.test/v1/projects/${project.id}/developer-annotations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor: { ...anchor, lifecycle: 'current', mappedFrom: undefined },
          category: 'accessibility',
          body: 'Preserve the visual contract.'
        })
      })
    );
    expect(annotation.status).toBe(201);
    const annotations = await service(
      new Request(`https://service.test/v1/projects/${project.id}/developer-annotations`, {
        headers
      })
    );
    await expect(annotations.json()).resolves.toMatchObject({
      annotations: [expect.objectContaining({ body: 'Preserve the visual contract.' })]
    });
    const outside = await service(
      new Request(`https://service.test/v1/projects/${project.id}/review-threads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          anchor: {
            ...anchor,
            target: { kind: 'region', region: { x: 0.9, y: 0, width: 0.2, height: 0.1 } }
          },
          deepLink: 'https://review.example.test/project-1',
          body: 'Outside bounds.',
          mentionedUserIds: []
        })
      })
    );
    expect(outside.status).toBe(400);
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
