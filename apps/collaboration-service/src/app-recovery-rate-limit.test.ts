import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryCollaborationRepository } from '@selene/collaboration';
import type { CollaborationAuthorizer } from '@selene/collaboration/service';
import { createCollaborationApplication } from './app';
import { createHeaderIdentityProvider } from './auth';
import { readServiceEnvironment } from './env';
import { projectBackupExclusions, type ProjectBackup } from './project-backup-contract';
import { createProjectBackupHttpHandler, type ProjectBackupStore } from './project-backup-service';

const projectId = 'project:alpha';
const proxySecret = 'p'.repeat(32);
const origin = 'https://review.example.test';

function fixture(maximum: number) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const environment = readServiceEnvironment({
    COLLABORATION_STORE: 'memory',
    COLLABORATION_SHARE_SECRET: 'a'.repeat(32),
    COLLABORATION_PROXY_SECRET: proxySecret,
    CORS_ORIGINS: origin,
    RATE_LIMIT_PER_MINUTE: String(maximum)
  });
  const repository = createInMemoryCollaborationRepository();
  const backup: ProjectBackup = {
    document: {
      format: 'selene-project-backup/v1',
      projectId,
      tenantId: 'tenant:alpha',
      latestRevisionId: 'revision:one',
      exportedAt: '2026-10-04T08:00:00.000Z',
      expiresAt: '2026-11-03T08:00:00.000Z',
      restoreOwnerId: 'owner:alpha',
      snapshot: {
        format: 'selene-collaboration/v2',
        project: { id: projectId, organizationId: 'tenant:alpha', name: 'Recovery limit' },
        revisions: [],
        threads: [],
        comments: [],
        reactions: [],
        approvals: [],
        reviewThreads: [],
        aiChangeRequests: [],
        developerAnnotations: []
      },
      audits: [],
      exclusions: projectBackupExclusions
    },
    sha256: 'a'.repeat(64)
  };
  const store = {
    backup: vi.fn<ProjectBackupStore['backup']>(async () => backup),
    restore: vi.fn<ProjectBackupStore['restore']>(async () => ({
      format: 'selene-project-restore-receipt/v1',
      projectId,
      tenantId: 'tenant:alpha',
      previousRevisionId: 'revision:current',
      restoredRevisionId: 'revision:one',
      snapshotSha256: backup.sha256,
      preservedAuditIds: [],
      restoreAuditId: 'audit:restore',
      restoredAt: '2026-10-04T08:00:00.000Z'
    }))
  };
  const authorizer = { authorize: vi.fn<CollaborationAuthorizer['authorize']>(async () => true) };
  const trustedIdentity = createHeaderIdentityProvider(proxySecret);
  const identityProvider = { authenticate: vi.fn(trustedIdentity.authenticate) };
  const app = createCollaborationApplication(
    environment,
    repository,
    authorizer,
    undefined,
    identityProvider,
    undefined,
    undefined,
    store
  );
  const request = (
    route: 'ordinary' | 'backup' | 'restore',
    userId = 'owner:alpha',
    extraHeaders: HeadersInit = {}
  ) => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-selene-user-id': userId,
      'x-selene-proxy-secret': proxySecret,
      origin
    });
    for (const [key, value] of new Headers(extraHeaders)) headers.set(key, value);
    return new Request(
      `https://service.test/v1/projects/${route === 'ordinary' ? projectId : encodeURIComponent(projectId)}/${route === 'ordinary' ? 'readiness' : route}`,
      {
        method: route === 'restore' ? 'POST' : 'GET',
        headers,
        ...(route === 'restore'
          ? { body: JSON.stringify({ backup, expectedRevisionId: 'revision:current' }) }
          : {})
      }
    );
  };
  return { app, repository, authorizer, identityProvider, store, backup, request };
}

afterEach(() => vi.restoreAllMocks());

describe('configured application recovery request budget', () => {
  it('charges ordinary, backup and restore requests once against the same configured budget', async () => {
    const { app, repository, authorizer, identityProvider, store, request } = fixture(3);
    await repository.createProject({
      id: projectId,
      organizationId: 'tenant:alpha',
      name: 'Recovery limit'
    });
    expect((await app.fetch(request('ordinary'))).status).toBe(200);
    expect((await app.fetch(request('backup'))).status).toBe(200);
    expect((await app.fetch(request('restore'))).status).toBe(200);
    const backupLimited = await app.fetch(request('backup'));
    const restoreLimited = await app.fetch(request('restore'));
    const ordinaryLimited = await app.fetch(request('ordinary'));
    expect([backupLimited.status, restoreLimited.status, ordinaryLimited.status]).toEqual([
      429, 429, 429
    ]);
    expect(await backupLimited.json()).toEqual({ error: 'rate_limited' });
    expect(backupLimited.headers.get('retry-after')).toBe('60');
    expect(backupLimited.headers.get('cache-control')).toBe('no-store');
    expect(backupLimited.headers.get('access-control-allow-origin')).toBe(origin);
    expect(backupLimited.headers.get('x-request-id')).toBeTruthy();
    expect(store.backup).toHaveBeenCalledTimes(1);
    expect(store.restore).toHaveBeenCalledTimes(1);
    expect(authorizer.authorize).toHaveBeenCalledTimes(3);
    expect(identityProvider.authenticate).toHaveBeenCalledTimes(6);
    expect(store.backup.mock.calls[0]?.slice(0, 3)).toEqual([projectId, 'owner:alpha', 30]);
    expect(store.restore.mock.calls[0]?.slice(0, 3)).toEqual([
      expect.objectContaining({ document: expect.objectContaining({ projectId }) }),
      'revision:current',
      'owner:alpha'
    ]);
  });

  it('isolates the shared budgets by authenticated identity', async () => {
    const { app, repository, store, request } = fixture(2);
    await repository.createProject({
      id: projectId,
      organizationId: 'tenant:alpha',
      name: 'Limit'
    });
    expect((await app.fetch(request('backup', 'owner:alpha'))).status).toBe(200);
    expect((await app.fetch(request('restore', 'owner:alpha'))).status).toBe(200);
    expect((await app.fetch(request('ordinary', 'owner:alpha'))).status).toBe(429);
    expect((await app.fetch(request('ordinary', 'owner:beta'))).status).toBe(200);
    expect((await app.fetch(request('backup', 'owner:beta'))).status).toBe(200);
    expect((await app.fetch(request('restore', 'owner:beta'))).status).toBe(429);
    expect(store.backup).toHaveBeenCalledTimes(2);
    expect(store.restore).toHaveBeenCalledTimes(1);
  });

  it('resets at the original anchored minute without extending it on rejected requests', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository, store, request } = fixture(1);
    await repository.createProject({
      id: projectId,
      organizationId: 'tenant:alpha',
      name: 'Limit'
    });
    expect((await app.fetch(request('backup'))).status).toBe(200);
    now.mockReturnValue(1_800_000_059_999);
    expect((await app.fetch(request('restore'))).status).toBe(429);
    now.mockReturnValue(1_800_000_060_000);
    expect((await app.fetch(request('ordinary'))).status).toBe(200);
    expect((await app.fetch(request('restore'))).status).toBe(429);
    expect(store.backup).toHaveBeenCalledTimes(1);
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('rejects forged proxy identities before authorization and shares their anonymous budget', async () => {
    const { app, authorizer, store, request } = fixture(2);
    const forged = { 'x-selene-proxy-secret': 'incorrect' };
    expect((await app.fetch(request('backup', 'forged:first', forged))).status).toBe(403);
    expect((await app.fetch(request('restore', 'forged:second', forged))).status).toBe(403);
    expect((await app.fetch(request('ordinary', 'forged:third', forged))).status).toBe(429);
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(store.backup).not.toHaveBeenCalled();
    expect(store.restore).not.toHaveBeenCalled();
    expect((await app.fetch(request('backup'))).status).toBe(200);
  });

  it('keeps preflight and invalid origins outside recovery authentication and the request budget', async () => {
    const { app, authorizer, identityProvider, store, request } = fixture(1);
    const preflight = new Request(request('backup'), { method: 'OPTIONS' });
    expect((await app.fetch(preflight)).status).toBe(204);
    expect(
      (await app.fetch(request('backup', 'owner:alpha', { origin: 'https://untrusted.test' })))
        .status
    ).toBe(403);
    expect(identityProvider.authenticate).not.toHaveBeenCalled();
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect((await app.fetch(request('backup'))).status).toBe(200);
    expect((await app.fetch(preflight)).status).toBe(204);
    expect((await app.fetch(request('restore'))).status).toBe(429);
    expect(store.backup).toHaveBeenCalledTimes(1);
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('does not read exhausted restore bodies or invoke authorization and storage ports', async () => {
    const { app, authorizer, identityProvider, store, request } = fixture(1);
    expect((await app.fetch(request('backup'))).status).toBe(200);
    const restore = request('restore');
    const readBody = vi.spyOn(restore.body!, 'getReader');
    expect((await app.fetch(restore)).status).toBe(429);
    expect(readBody).not.toHaveBeenCalled();
    expect(restore.bodyUsed).toBe(false);
    expect(identityProvider.authenticate).toHaveBeenCalledTimes(2);
    expect(authorizer.authorize).toHaveBeenCalledTimes(1);
    expect(store.backup).toHaveBeenCalledTimes(1);
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('authenticates before shared admission and rejects before creating a recovery host context', async () => {
    const { store, authorizer, request } = fixture(1);
    const events: string[] = [];
    const authenticate = vi.fn(async () => {
      events.push('authenticate');
      return 'owner:alpha';
    });
    const rateLimit = vi.fn((_request: Request, actorId: string | undefined) => {
      events.push('rateLimit');
      expect(actorId).toBe('owner:alpha');
      return Response.json({ error: 'rate_limited' }, { status: 429 });
    });
    const create = vi.fn(() => {
      throw new Error('Exhausted requests must not create a host context');
    });
    const recovery = createProjectBackupHttpHandler({
      store,
      authorizer,
      identityProvider: { authenticate },
      hostContextFactory: { create },
      allowedOrigins: [origin],
      rateLimit
    });
    const restore = request('restore');
    expect((await recovery.fetch(restore))?.status).toBe(429);
    expect(events).toEqual(['authenticate', 'rateLimit']);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(restore.bodyUsed).toBe(false);
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('uses the verified provider identity even when incoming identity headers change', async () => {
    const { app, identityProvider, authorizer, store, request } = fixture(1);
    identityProvider.authenticate.mockResolvedValue('cookie:owner');
    expect((await app.fetch(request('backup', 'spoofed:first'))).status).toBe(200);
    expect((await app.fetch(request('restore', 'spoofed:second'))).status).toBe(429);
    expect((await app.fetch(request('ordinary', 'spoofed:third'))).status).toBe(429);
    expect(authorizer.authorize).toHaveBeenCalledTimes(1);
    expect(authorizer.authorize.mock.calls[0]?.[0]).toEqual({
      userId: 'cookie:owner',
      action: 'project:restore',
      projectId
    });
    expect(store.backup.mock.calls[0]?.[1]).toBe('cookie:owner');
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('keeps tenant-aware authorization mandatory and charges denied requests to the budget', async () => {
    const { app, authorizer, store, request } = fixture(1);
    authorizer.authorize.mockResolvedValue(false);
    expect((await app.fetch(request('backup'))).status).toBe(403);
    expect((await app.fetch(request('ordinary'))).status).toBe(429);
    expect(authorizer.authorize).toHaveBeenCalledTimes(1);
    expect(store.backup).not.toHaveBeenCalled();
    expect(store.restore).not.toHaveBeenCalled();
  });
});
