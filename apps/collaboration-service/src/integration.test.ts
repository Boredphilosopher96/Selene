import { describe, expect, it } from 'vitest';

import { createMemoryApplication } from './app';
import { readServiceEnvironment } from './env';

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
        headers: session('reviewer-a'),
        body: JSON.stringify({
          id: 'review-thread-hosted',
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
          headers: session('reviewer-b'),
          body: JSON.stringify({
            id: 'review-message-hosted-reply',
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
          headers: session('reviewer-a')
        })
      )
    ).resolves.toMatchObject({ status: 200 });
    const reopened = await application.fetch(
      new Request('https://service.test/v1/review-threads/review-thread-hosted/reopen', {
        method: 'POST',
        headers: session('reviewer-b')
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
