import { describe, expect, it } from 'vitest';

import {
  HostedOidcBff,
  createDirectHostedOidcBffEffects,
  createInMemoryHostedBffStore,
  type OidcRuntime
} from '@selene/identity-runtime';
import { createInMemoryCollaborationRepository } from '@selene/collaboration';

import { createCollaborationApplication, createMemoryApplication } from './app';
import { readServiceEnvironment } from './env';
import { createBffIdentityProvider } from './oidc-bff';
import { createHostedReviewHttpProvider } from '../../web/src/hosted-review-http-provider';

const environment = readServiceEnvironment({
  COLLABORATION_STORE: 'memory',
  COLLABORATION_SHARE_SECRET: 'a'.repeat(32),
  COLLABORATION_PROXY_SECRET: 'p'.repeat(32),
  CORS_ORIGINS: 'https://review.example.test'
});
const headers = {
  'content-type': 'application/json',
  'x-selene-user-id': 'user-1',
  'x-selene-proxy-secret': 'p'.repeat(32),
  origin: 'https://review.example.test'
};

describe('Bun collaboration service integration harness', () => {
  it('enforces hosted CAS through two cookie-only BFF sessions and real service routes', async () => {
    const projectId = 'project-hosted-cas';
    const revisionId = 'revision-hosted-cas';
    const binding = {
      tenantId: 'org-1',
      projectId,
      artifactId: 'artifact-hosted-cas',
      revisionId,
      baselineId: 'baseline-hosted-cas',
      version: 1
    } as const;
    const hostedEnvironment = readServiceEnvironment({
      COLLABORATION_STORE: 'memory',
      COLLABORATION_SHARE_SECRET: 'a'.repeat(32),
      COLLABORATION_PROXY_SECRET: 'p'.repeat(32),
      CORS_ORIGINS: 'https://review.example.test',
      HOSTED_REVIEW_PROJECT_ID: binding.projectId,
      HOSTED_REVIEW_ARTIFACT_ID: binding.artifactId,
      HOSTED_REVIEW_REVISION_ID: binding.revisionId,
      HOSTED_REVIEW_BASELINE_ID: binding.baselineId,
      HOSTED_REVIEW_CONTRACT_VERSION: String(binding.version)
    });
    const bffRuntime: OidcRuntime = {
      async begin() {
        throw new Error('not used by cookie-only hosted review evidence');
      },
      async exchange() {
        throw new Error('not used by cookie-only hosted review evidence');
      },
      async revoke() {},
      async endSession() {
        return undefined;
      }
    };
    const bffStore = createInMemoryHostedBffStore();
    const bff = new HostedOidcBff({
      effects: createDirectHostedOidcBffEffects(bffRuntime, bffStore),
      issuer: 'https://idp.example.test',
      allowedIssuerHosts: ['idp.example.test'],
      redirectUri: 'https://service.test/auth/callback'
    });
    const sessionIds = {
      'reviewer-a': 'hosted-review-session-a-12345678901234567890',
      'reviewer-b': 'hosted-review-session-b-12345678901234567890'
    } as const;
    await Promise.all(
      Object.entries(sessionIds).map(([userId, id]) =>
        bffStore.createSession({
          id,
          subject: `https://idp.example.test|${userId}`,
          expiresAt: Date.now() + 60_000,
          tokens: {
            subjectKey: `https://idp.example.test|${userId}`,
            claims: { sub: userId },
            expiresAt: Date.now() + 60_000
          },
          organizationId: binding.tenantId,
          accessVersion: 1
        })
      )
    );
    const identity = createBffIdentityProvider(bff, {
      async resolveExternalSubject(session) {
        const userId = session.subject.split('|').at(-1);
        return userId === 'reviewer-a' || userId === 'reviewer-b'
          ? { userId, organizationId: binding.tenantId, accessVersion: 1 }
          : undefined;
      }
    });
    const repository = createInMemoryCollaborationRepository();
    const application = createCollaborationApplication(
      hostedEnvironment,
      repository,
      {
        async authorize() {
          return true;
        }
      },
      undefined,
      identity
    );
    const sessionFetch =
      (userId: keyof typeof sessionIds): typeof fetch =>
      async (input, init) => {
        const requestHeaders = new Headers(init?.headers);
        requestHeaders.set('cookie', `__Host-selene_session=${sessionIds[userId]}`);
        expect(requestHeaders.has('x-selene-user-id')).toBe(false);
        expect(requestHeaders.has('x-selene-proxy-secret')).toBe(false);
        return application.fetch(
          new Request(String(input), { ...init, headers: requestHeaders, credentials: 'include' })
        );
      };
    const sessionHeaders = (userId: keyof typeof sessionIds) => ({
      'content-type': 'application/json',
      cookie: `__Host-selene_session=${sessionIds[userId]}`
    });
    for (const [path, body] of [
      ['/v1/projects', { id: projectId, organizationId: 'org-1', name: 'Hosted CAS review' }],
      [
        `/v1/projects/${projectId}/revisions`,
        {
          id: revisionId,
          content: { review: 'cas' },
          contentSha256: 'c'.repeat(64),
          scenarioIds: ['default']
        }
      ]
    ] as const) {
      // The revision intentionally follows the project creation in this real-route fixture.
      // eslint-disable-next-line no-await-in-loop
      const response = await application.fetch(
        new Request(`https://service.test${path}`, {
          method: 'POST',
          headers: sessionHeaders('reviewer-a'),
          body: JSON.stringify(body)
        })
      );
      expect(response.status).toBe(201);
    }
    const readiness = await application.fetch(
      new Request(`https://service.test/v1/projects/${projectId}/readiness`, {
        method: 'POST',
        headers: sessionHeaders('reviewer-a'),
        body: JSON.stringify({
          id: binding.baselineId,
          revisionId,
          intent: 'review',
          revisionFingerprint: 'c'.repeat(64)
        })
      })
    );
    expect(readiness.status).toBe(201);
    const options = {
      serviceUrl: 'https://service.test',
      reviewUrl: 'https://review.example.test/review',
      revisionFingerprint: 'c'.repeat(64),
      screenId: 'orders'
    } as const;
    const first = createHostedReviewHttpProvider({ ...options, fetch: sessionFetch('reviewer-a') });
    const second = createHostedReviewHttpProvider({
      ...options,
      fetch: sessionFetch('reviewer-b')
    });
    const created = await first.mutate({
      type: 'create',
      binding,
      operationId: 'hosted-cas-create',
      threadId: 'hosted-cas-thread',
      expectedVersion: 0,
      body: 'Create through the authenticated service.',
      anchor: {
        selector: '[data-review-order="cas"]',
        component: 'OrderStatus',
        point: { x: 0.5, y: 0.5 },
        region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
      }
    });
    if (!created.ok) throw new Error('Expected hosted creation to succeed');
    await expect(
      first.mutate({
        type: 'create',
        binding,
        operationId: 'hosted-cas-create',
        threadId: 'hosted-cas-thread',
        expectedVersion: 0,
        body: 'Create through the authenticated service.',
        anchor: {
          selector: '[data-review-order="cas"]',
          component: 'OrderStatus',
          point: { x: 0.5, y: 0.5 },
          region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
        }
      })
    ).resolves.toMatchObject({ ok: true, thread: { version: 1 } });
    await expect(
      first.mutate({
        type: 'create',
        binding,
        operationId: 'hosted-cas-create',
        threadId: 'hosted-cas-thread',
        expectedVersion: 0,
        body: 'A changed retry must never reuse the original receipt.',
        anchor: {
          selector: '[data-review-order="cas"]',
          component: 'OrderStatus',
          point: { x: 0.5, y: 0.5 },
          region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
        }
      })
    ).resolves.toMatchObject({ ok: false, code: 'conflict', currentVersion: 1 });
    const createRace = await Promise.all([
      first.mutate({
        type: 'create',
        binding,
        operationId: 'hosted-cas-create-race-a',
        threadId: 'hosted-cas-create-race',
        expectedVersion: 0,
        body: 'First competing creation.',
        anchor: {
          selector: '[data-review-order="cas-race"]',
          component: 'OrderStatus',
          point: { x: 0.25, y: 0.25 },
          region: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }
        }
      }),
      second.mutate({
        type: 'create',
        binding,
        operationId: 'hosted-cas-create-race-b',
        threadId: 'hosted-cas-create-race',
        expectedVersion: 0,
        body: 'Second competing creation.',
        anchor: {
          selector: '[data-review-order="cas-race"]',
          component: 'OrderStatus',
          point: { x: 0.25, y: 0.25 },
          region: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }
        }
      })
    ]);
    expect(createRace.filter((result) => result.ok)).toHaveLength(1);
    expect(createRace.filter((result) => !result.ok && result.code === 'conflict')).toHaveLength(1);
    const race = await Promise.all([
      first.mutate({
        type: 'reply',
        binding,
        operationId: 'hosted-cas-reply-a',
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        body: 'First racing reply.'
      }),
      second.mutate({
        type: 'reply',
        binding,
        operationId: 'hosted-cas-reply-b',
        threadId: created.thread.id,
        expectedVersion: created.thread.version,
        body: 'Second racing reply.'
      })
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok && result.code === 'conflict')).toHaveLength(1);
    const afterReload = await second.list(binding);
    expect(afterReload).toHaveLength(2);
    const currentCreated = afterReload.find((thread) => thread.id === created.thread.id);
    expect(currentCreated).toBeDefined();
    const resolved = await second.mutate({
      type: 'resolve',
      binding,
      operationId: 'hosted-cas-resolve',
      threadId: created.thread.id,
      expectedVersion: currentCreated!.version
    });
    if (!resolved.ok) throw new Error('Expected hosted resolve to succeed');
    const reopened = await first.mutate({
      type: 'reopen',
      binding,
      operationId: 'hosted-cas-reopen',
      threadId: created.thread.id,
      expectedVersion: resolved.thread.version
    });
    if (!reopened.ok) throw new Error('Expected hosted reopen to succeed');
    await expect(
      second.mutate({
        type: 'resolve',
        binding,
        operationId: 'hosted-cas-resolve',
        threadId: created.thread.id,
        expectedVersion: resolved.thread.version
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'conflict',
      currentVersion: reopened.thread.version
    });
    const nextReadiness = await application.fetch(
      new Request(`https://service.test/v1/projects/${projectId}/readiness`, {
        method: 'POST',
        headers: sessionHeaders('reviewer-a'),
        body: JSON.stringify({
          id: 'baseline-hosted-cas-next',
          revisionId,
          intent: 'handoff',
          revisionFingerprint: 'c'.repeat(64)
        })
      })
    );
    expect(nextReadiness.status).toBe(201);
    await expect(second.list(binding)).rejects.toThrow('review-binding:404');
  });

  it('keeps two authenticated review sessions synchronized and isolated through reload', async () => {
    const application = createMemoryApplication(environment);
    const session = (userId: string) => ({ ...headers, 'x-selene-user-id': userId });
    const projectId = 'project-hosted-review';
    const revisionId = 'revision-hosted-review';
    await expect(
      application.fetch(
        new Request('https://service.test/v1/projects', {
          method: 'POST',
          headers: session('reviewer-a'),
          body: JSON.stringify({ id: projectId, organizationId: 'org-1', name: 'Hosted review' })
        })
      )
    ).resolves.toMatchObject({ status: 201 });
    await expect(
      application.fetch(
        new Request(`https://service.test/v1/projects/${projectId}/revisions`, {
          method: 'POST',
          headers: session('reviewer-a'),
          body: JSON.stringify({
            id: revisionId,
            content: { review: 'hosted' },
            contentSha256: 'b'.repeat(64),
            scenarioIds: ['default']
          })
        })
      )
    ).resolves.toMatchObject({ status: 201 });
    const create = await application.fetch(
      new Request(`https://service.test/v1/projects/${projectId}/review-threads`, {
        method: 'POST',
        headers: { ...session('reviewer-a'), 'idempotency-key': 'review-create-hosted' },
        body: JSON.stringify({
          id: 'review-thread-hosted',
          operationId: 'review-create-hosted',
          expectedVersion: 0,
          messageId: 'review-message-hosted-create',
          body: 'Created by the first permitted session.',
          mentionedUserIds: [],
          deepLink: 'https://review.example.test/hosted#selene-review=fixture',
          anchor: {
            evidence: {
              artifactId: 'orders-artifact',
              screenId: 'orders',
              revisionId,
              revisionFingerprint: 'b'.repeat(64),
              viewport: { width: 1440, height: 900, zoom: 1 }
            },
            lifecycle: 'current',
            target: { kind: 'point', point: { x: 0.5, y: 0.5 } }
          }
        })
      })
    );
    expect(create.status).toBe(201);
    const reloadedBySecondSession = await application.fetch(
      new Request(
        `https://service.test/v1/projects/${projectId}/review-threads?revisionId=${revisionId}`,
        {
          headers: session('reviewer-b')
        }
      )
    );
    await expect(reloadedBySecondSession.json()).resolves.toMatchObject({
      threads: [expect.objectContaining({ id: 'review-thread-hosted', lifecycle: 'open' })]
    });
    await expect(
      application.fetch(
        new Request('https://service.test/v1/review-threads/review-thread-hosted/messages', {
          method: 'POST',
          headers: { ...session('reviewer-b'), 'idempotency-key': 'review-reply-hosted' },
          body: JSON.stringify({
            id: 'review-message-hosted-reply',
            operationId: 'review-reply-hosted',
            expectedVersion: 1,
            body: 'Reply from the second permitted session.',
            mentionedUserIds: []
          })
        })
      )
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      application.fetch(
        new Request('https://service.test/v1/review-threads/review-thread-hosted/resolve', {
          method: 'POST',
          headers: { ...session('reviewer-a'), 'idempotency-key': 'review-resolve-hosted' },
          body: JSON.stringify({ operationId: 'review-resolve-hosted', expectedVersion: 2 })
        })
      )
    ).resolves.toMatchObject({ status: 200 });
    const reopened = await application.fetch(
      new Request('https://service.test/v1/review-threads/review-thread-hosted/reopen', {
        method: 'POST',
        headers: { ...session('reviewer-b'), 'idempotency-key': 'review-reopen-hosted' },
        body: JSON.stringify({ operationId: 'review-reopen-hosted', expectedVersion: 3 })
      })
    );
    await expect(reopened.json()).resolves.toMatchObject({ lifecycle: 'open' });
    await expect(
      application.fetch(
        new Request('https://service.test/v1/projects', {
          method: 'POST',
          headers: session('reviewer-b'),
          body: JSON.stringify({
            id: 'project-hosted-isolated',
            organizationId: 'org-1',
            name: 'Isolated'
          })
        })
      )
    ).resolves.toMatchObject({ status: 201 });
    const isolated = await application.fetch(
      new Request('https://service.test/v1/projects/project-hosted-isolated/review-threads', {
        headers: session('reviewer-b')
      })
    );
    await expect(isolated.json()).resolves.toMatchObject({ threads: [] });
    const forbidden = await application.fetch(
      new Request(`https://service.test/v1/projects/${projectId}/review-threads`, {
        headers: { origin: 'https://review.example.test' }
      })
    );
    expect(forbidden.status).toBe(403);
  });

  it('runs through authenticated routes, local persistence, export, sync, and signed sharing', async () => {
    const application = createMemoryApplication(environment);
    const project = { id: 'project-1', organizationId: 'org-1', name: 'Northstar' };
    const create = await application.fetch(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify(project)
      })
    );
    expect(create.status).toBe(201);
    expect(create.headers.get('x-request-id')).toBeTruthy();
    const revision = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/revisions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: { workspace: 'local' },
          contentSha256: 'a'.repeat(64),
          scenarioIds: ['default']
        })
      })
    );
    expect(revision.status).toBe(201);
    const revisionBody = (await revision.json()) as { id: string };
    const thread = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/threads', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          revisionId: revisionBody.id,
          reactNodeId: 'orders.header',
          scenarioId: 'default'
        })
      })
    );
    expect(thread.status).toBe(201);
    const threadBody = (await thread.json()) as { id: string };
    const share = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/share-links', {
        method: 'POST',
        headers,
        body: JSON.stringify({ permission: 'commenter', expiresAt: '2030-01-01T00:00:00Z' })
      })
    );
    const shared = await share.json();
    expect((shared as { permission: string }).permission).toBe('commenter');
    expect((shared as { token: unknown }).token).toEqual(expect.any(String));
    const guestComment = await application.fetch(
      new Request(`https://service.test/v1/threads/${threadBody.id}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-selene-share-token': (shared as { token: string }).token
        },
        body: JSON.stringify({ body: 'Guest review note', mentionedUserIds: [] })
      })
    );
    expect(guestComment.status).toBe(201);
    const viewerShare = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/share-links', {
        method: 'POST',
        headers,
        body: JSON.stringify({ permission: 'viewer', expiresAt: '2030-01-01T00:00:00Z' })
      })
    );
    const viewer = (await viewerShare.json()) as { token: string };
    const forbiddenViewerComment = await application.fetch(
      new Request(`https://service.test/v1/threads/${threadBody.id}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-selene-share-token': viewer.token
        },
        body: JSON.stringify({ body: 'Viewer cannot write', mentionedUserIds: [] })
      })
    );
    expect(forbiddenViewerComment.status).toBe(403);
    const guestExport = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/export', {
        headers: { 'x-selene-share-token': (shared as { token: string }).token }
      })
    );
    expect(guestExport.status).toBe(200);
    const events = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/events?after=0', { headers })
    );
    await expect(events.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'project.created', cursor: expect.any(Number) }),
        expect.objectContaining({ type: 'revision.created', cursor: expect.any(Number) })
      ])
    });
    const stream = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/events/stream?after=0', { headers })
    );
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    const firstEvent = await reader?.read();
    expect(new TextDecoder().decode(firstEvent?.value)).toContain('event: change');
    await reader?.cancel();
    const exported = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/export', { headers })
    );
    const snapshot = await exported.text();
    const synced = await application.fetch(
      new Request('https://service.test/v1/sync', {
        method: 'POST',
        headers,
        body: snapshot
      })
    );
    expect(synced.status).toBe(200);
    const revoked = await application.fetch(
      new Request(`https://service.test/v1/share-links/${(shared as { id: string }).id}`, {
        method: 'DELETE',
        headers
      })
    );
    expect(revoked.status).toBe(204);
    const revokedGuest = await application.fetch(
      new Request('https://service.test/v1/projects/project-1/export', {
        headers: { 'x-selene-share-token': (shared as { token: string }).token }
      })
    );
    expect(revokedGuest.status).toBe(403);
    await expect(
      application.fetch(new Request('https://service.test/readyz'))
    ).resolves.toMatchObject({ status: 200 });
  });

  it('rejects a caller-provided identity without the trusted proxy secret', async () => {
    const application = createMemoryApplication(environment);
    const response = await application.fetch(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-selene-user-id': 'spoofed-user'
        },
        body: JSON.stringify({ organizationId: 'org-1', name: 'Spoofed' })
      })
    );

    expect(response.status).toBe(403);
  });

  it('supports explicit no-login local mode without accepting browser identity headers', async () => {
    const local = createMemoryApplication(
      readServiceEnvironment({
        COLLABORATION_STORE: 'memory',
        COLLABORATION_SHARE_SECRET: 'a'.repeat(32),
        COLLABORATION_AUTH_MODE: 'local',
        COLLABORATION_LOCAL_USER_ID: 'desktop-user'
      })
    );
    const response = await local.fetch(
      new Request('https://service.test/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-selene-user-id': 'spoofed-user' },
        body: JSON.stringify({ id: 'local-project', organizationId: 'local', name: 'Offline' })
      })
    );
    expect(response.status).toBe(201);
  });
});
