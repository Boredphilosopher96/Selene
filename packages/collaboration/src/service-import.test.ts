import { describe, expect, it } from 'vitest';
import {
  createInMemoryCollaborationRepository,
  CollaborationError,
  type CollaborationHostContext,
  type CollaborationRepository,
  type CollaborationSnapshot,
  roleAllows
} from './index';
import { createCollaborationService } from './service';

const project = { id: 'import-project', organizationId: 'import-tenant', name: 'Import fixture' };
const revision = {
  id: 'before',
  projectId: project.id,
  sequence: 1,
  content: { value: 'before' },
  contentSha256: 'a'.repeat(64),
  scenarioIds: ['default'],
  createdBy: 'owner',
  createdAt: '2026-10-04T00:00:00Z'
};

async function fixture(
  wrap: (repository: CollaborationRepository) => CollaborationRepository = (repository) =>
    repository
) {
  const repository = createInMemoryCollaborationRepository();
  await repository.createProject(project);
  await repository.appendRevision(revision);
  const snapshot = (await repository.exportProject(project.id))!;
  await repository.appendRevision(
    {
      ...revision,
      id: 'current',
      sequence: 2,
      parentRevisionId: revision.id,
      content: { value: 'current' }
    },
    revision.id
  );
  let sequence = 0;
  const service = createCollaborationService({
    repository: wrap(repository),
    ids: { next: (kind) => `${kind}-${++sequence}` },
    authorizer: {
      async authorize({ userId, action, projectId }) {
        return (
          projectId === project.id &&
          ['owner', 'admin', 'editor'].includes(userId) &&
          roleAllows(userId as 'owner' | 'admin' | 'editor', action)
        );
      }
    },
    hostContextFactory: {
      create({ signal }) {
        const context: CollaborationHostContext = {
          signal: signal ?? new AbortController().signal,
          run: async (operation) => operation(context),
          runPort: async (_port, _method, operation) => operation(context),
          dispose: () => undefined
        };
        return context;
      }
    }
  });
  const request = (actor: string, fence?: string, value: CollaborationSnapshot = snapshot) =>
    service(
      new Request('https://service.test/v1/import', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-selene-user-id': actor,
          'idempotency-key': 'restore-once',
          ...(fence === undefined ? {} : { 'x-selene-expected-revision-id': fence })
        },
        body: JSON.stringify(value)
      })
    );
  return { repository, snapshot, request };
}

describe('fenced legacy project import', () => {
  it.each(['owner', 'admin'])(
    'restores once for %s and replays the saved receipt',
    async (actor) => {
      const { repository, request } = await fixture();
      const first = await request(actor, 'current');
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ projectId: project.id, imported: true });
      expect((await repository.getLatestRevision(project.id))?.id).toBe('before');
      expect((await request(actor, 'current')).status).toBe(201);
      expect(await repository.listEvents(project.id, 0, 10)).toHaveLength(1);
    }
  );

  it('denies editors without changing the saved project', async () => {
    const { repository, request } = await fixture();
    expect((await request('editor', 'current')).status).toBe(403);
    expect((await repository.getLatestRevision(project.id))?.id).toBe('current');
  });

  it('requires the current revision and rejects stale fences without mutation', async () => {
    const { repository, request } = await fixture();
    expect((await request('owner')).status).toBe(400);
    expect((await request('owner', 'before')).status).toBe(409);
    expect((await repository.getLatestRevision(project.id))?.id).toBe('current');
  });

  it('rejects a snapshot that tries to move the project into another tenant', async () => {
    const { repository, snapshot, request } = await fixture();
    expect(
      (
        await request('owner', 'current', {
          ...snapshot,
          project: { ...snapshot.project, organizationId: 'another-tenant' }
        })
      ).status
    ).toBe(403);
    expect(await repository.getProject(project.id)).toEqual(project);
    expect((await repository.getLatestRevision(project.id))?.id).toBe('current');
  });

  it('reports a concurrent CAS loss from the persisted revision without replacing it', async () => {
    const { repository, request } = await fixture((stored) => ({
      ...stored,
      async replaceProject(snapshot, options) {
        await stored.appendRevision(
          {
            ...revision,
            id: 'concurrent',
            sequence: 3,
            parentRevisionId: 'current',
            content: { value: 'concurrent' }
          },
          'current'
        );
        await stored.replaceProject(snapshot, options);
      }
    }));
    expect((await request('owner', 'current')).status).toBe(409);
    expect((await repository.getLatestRevision(project.id))?.id).toBe('concurrent');
  });

  it.each(['ordinary', 'public-conflict', 'hostile-getter'])(
    'keeps %s adapter failures generic when the revision is unchanged',
    async (kind) => {
      let inspected = 0;
      const failure =
        kind === 'public-conflict'
          ? new CollaborationError('CONFLICT', 'PRIVATE DRIVER DETAIL')
          : new Error('PRIVATE DRIVER DETAIL');
      if (kind === 'hostile-getter')
        Object.defineProperty(failure, 'code', {
          get() {
            inspected += 1;
            throw new Error('PRIVATE GETTER DETAIL');
          }
        });
      const { repository, request } = await fixture((stored) => ({
        ...stored,
        async replaceProject() {
          throw failure;
        }
      }));
      const response = await request('owner', 'current');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('PRIVATE');
      expect(inspected).toBe(0);
      expect((await repository.getLatestRevision(project.id))?.id).toBe('current');
    }
  );
});
