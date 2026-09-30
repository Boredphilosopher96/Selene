import { describe, expect, it } from 'vitest';
import {
  createInMemoryCollaborationRepository,
  type CollaborationEvent,
  type CollaborationHostContext,
  type CollaborationRepository
} from './index';
import { createCollaborationService } from './service';

const project = { id: 'stream-project', organizationId: 'stream-org', name: 'Stream test' };
const headers = { 'content-type': 'application/json', 'x-selene-user-id': 'stream-user' };

function serviceFor(repository: CollaborationRepository) {
  let sequence = 0;
  return createCollaborationService({
    repository,
    ids: { next: (kind) => `${kind}-${++sequence}` },
    authorizer: { authorize: async () => true },
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
}

async function seed(repository: CollaborationRepository, count: number) {
  await repository.createProject(project);
  for (let index = 1; index <= count; index++) {
    // oxlint-disable-next-line no-await-in-loop -- cursor allocation is ordered durable history.
    await repository.appendEvent({
      id: `seed-${index}`,
      projectId: project.id,
      actorId: 'stream-user',
      type: 'review_thread.created',
      resourceType: 'review_thread',
      resourceId: `thread-${index}`,
      payload: {},
      occurredAt: '2026-09-29T00:00:00.000Z'
    });
  }
}

function revisionRequest(id: string) {
  return new Request(`https://service.test/v1/projects/${project.id}/revisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id,
      content: { id },
      contentSha256: 'a'.repeat(64),
      scenarioIds: ['default']
    })
  });
}

describe('durable event stream', () => {
  it('orders the complete backlog and concurrent commits across the page boundary, then stays live', async () => {
    const repository = createInMemoryCollaborationRepository();
    await seed(repository, 501);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const firstQuery = new Promise<void>((resolve) => {
      started = resolve;
    });
    const queries: number[] = [];
    const service = serviceFor({
      ...repository,
      async listEvents(projectId, after, limit, context) {
        queries.push(after);
        const page = await repository.listEvents(projectId, after, limit, context);
        if (after === 0) {
          started();
          await gate;
        }
        return page;
      }
    });
    const response = await service(
      new Request(`https://service.test/v1/projects/${project.id}/events/stream?after=0`, {
        headers
      })
    );
    const reader = response.body!.getReader();
    try {
      await firstQuery;
      expect((await service(revisionRequest('revision-during-replay'))).status).toBe(201);
      release();
      const events: CollaborationEvent[] = [];
      while (events.length < 502) {
        // oxlint-disable-next-line no-await-in-loop -- consume the real stream in delivered order.
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        const data = new TextDecoder()
          .decode(chunk.value)
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (!data) throw new Error('Stream event has no data.');
        events.push(JSON.parse(data.slice(6)));
      }
      expect(events.map((event) => event.cursor)).toEqual(
        Array.from({ length: 502 }, (_, index) => index + 1)
      );
      expect(queries).toEqual([0, 500]);
      expect((await service(revisionRequest('revision-after-replay'))).status).toBe(201);
      const live = await reader.read();
      expect(new TextDecoder().decode(live.value)).toContain('id: 503\n');
      expect(new TextDecoder().decode(live.value)).toContain('revision-after-replay');
    } finally {
      release();
      await reader.cancel();
    }
    const resumed = await service(
      new Request(`https://service.test/v1/projects/${project.id}/events/stream`, {
        headers: { ...headers, 'last-event-id': '502' }
      })
    );
    const resumedReader = resumed.body!.getReader();
    try {
      const replay = await resumedReader.read();
      expect(new TextDecoder().decode(replay.value)).toContain('id: 503\n');
    } finally {
      await resumedReader.cancel();
    }
  });

  it('recovers durable order when concurrent live callbacks arrive in reverse cursor order', async () => {
    const repository = createInMemoryCollaborationRepository();
    await seed(repository, 0);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let committed = () => {};
    const firstCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let replayed = () => {};
    const initialReplay = new Promise<void>((resolve) => {
      replayed = resolve;
    });
    const service = serviceFor({
      ...repository,
      async listEvents(projectId, after, limit, context) {
        const page = await repository.listEvents(projectId, after, limit, context);
        replayed();
        return page;
      },
      async appendEvent(input, context) {
        const event = await repository.appendEvent(input, context);
        if (input.resourceId === 'first-live-revision') {
          committed();
          await gate;
        }
        return event;
      }
    });
    const response = await service(
      new Request(`https://service.test/v1/projects/${project.id}/events/stream`, { headers })
    );
    const reader = response.body!.getReader();
    await initialReplay;
    const first = service(revisionRequest('first-live-revision'));
    try {
      await firstCommitted;
      expect((await service(revisionRequest('second-live-revision'))).status).toBe(201);
      release();
      expect((await first).status).toBe(201);
      const lower = await reader.read();
      expect(new TextDecoder().decode(lower.value)).toContain('id: 1\n');
      expect(new TextDecoder().decode(lower.value)).toContain('first-live-revision');
      const higher = await reader.read();
      expect(new TextDecoder().decode(higher.value)).toContain('id: 2\n');
      expect(new TextDecoder().decode(higher.value)).toContain('second-live-revision');
    } finally {
      release();
      await first;
      await reader.cancel();
    }
  });

  it('rejects a non-advancing repository cursor instead of looping or silently skipping history', async () => {
    const repository = createInMemoryCollaborationRepository();
    await seed(repository, 1);
    const original = await repository.listEvents(project.id, 0, 500);
    const service = serviceFor({
      ...repository,
      listEvents: async () => original.map((event) => ({ ...event, cursor: 0 }))
    });
    const response = await service(
      new Request(`https://service.test/v1/projects/${project.id}/events/stream`, { headers })
    );
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toThrow('Event replay did not advance');
  });
  it('disconnects when a committed live event is missing from durable history', async () => {
    const repository = createInMemoryCollaborationRepository();
    await seed(repository, 0);
    const service = serviceFor({ ...repository, listEvents: async () => [] });
    const response = await service(
      new Request(`https://service.test/v1/projects/${project.id}/events/stream`, { headers })
    );
    const reader = response.body!.getReader();
    const read = reader.read().catch((error: unknown) => error);
    expect((await service(revisionRequest('missing-durable-event'))).status).toBe(201);
    expect(await read).toMatchObject({ message: 'Committed event history is unavailable' });
  });
});
