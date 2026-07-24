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
});
