import { describe, expect, it } from 'vitest';
import type { AuthorizationRequest } from '@selene/collaboration/service';
import { projectBackupExclusions, type ProjectBackup } from './project-backup-contract';
import { createProjectBackupHttpHandler, type ProjectBackupStore } from './project-backup-service';
import { createHostEffectContextFactory } from './host-effects';

describe('project backup route identity', () => {
  function handler() {
    const authorized: AuthorizationRequest[] = [];
    const requests: { projectId: string; actorId: string; retentionDays: number }[] = [];
    const store: ProjectBackupStore = {
      async backup(projectId, actorId, retentionDays) {
        requests.push({ projectId, actorId, retentionDays });
        const value: ProjectBackup = {
          document: {
            format: 'selene-project-backup/v1',
            projectId,
            tenantId: 'tenant:alpha',
            latestRevisionId: 'revision:one',
            exportedAt: '2026-09-30T12:00:00.000Z',
            expiresAt: '2026-10-30T12:00:00.000Z',
            restoreOwnerId: actorId,
            snapshot: {
              format: 'selene-collaboration/v2',
              project: { id: projectId, organizationId: 'tenant:alpha', name: 'URL fixture' },
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
        return value;
      },
      async restore() {
        throw new Error('Unexpected restore');
      }
    };
    return {
      authorized,
      requests,
      route: createProjectBackupHttpHandler({
        store,
        authorizer: {
          async authorize(request) {
            authorized.push(request);
            return true;
          }
        },
        identityProvider: {
          async authenticate() {
            return 'owner:alpha';
          }
        },
        hostContextFactory: createHostEffectContextFactory(),
        allowedOrigins: []
      })
    };
  }
  it('decodes browser-encoded colon IDs before authorization and persistence', async () => {
    const { route, requests, authorized } = handler();
    const response = await route.fetch(
      new Request('http://service.test/v1/projects/project%3Aalpha/backup?retentionDays=7')
    );
    expect(response?.status).toBe(200);
    expect(authorized).toEqual([
      { userId: 'owner:alpha', action: 'project:restore', projectId: 'project:alpha' }
    ]);
    expect(requests).toEqual([
      { projectId: 'project:alpha', actorId: 'owner:alpha', retentionDays: 7 }
    ]);
  });
  it.each(['project%ZZalpha', 'project%2Falpha', '%E0%A4%A'])(
    'rejects invalid encoded identity %s before port calls',
    async (identity) => {
      const { route, requests, authorized } = handler();
      const response = await route.fetch(
        new Request(`http://service.test/v1/projects/${identity}/backup`)
      );
      expect(response?.status).toBe(400);
      expect(requests).toEqual([]);
      expect(authorized).toEqual([]);
    }
  );
  it('leaves unrelated service paths to the collaboration router', async () => {
    const { route, requests } = handler();
    expect(
      await route.fetch(new Request('http://service.test/v1/export/project:alpha'))
    ).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
