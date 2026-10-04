import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prototypeGraphFixture } from '@selene/core/prototype';
import { describe, expect, it } from 'vitest';

import {
  JsonPrototypeGraphPersistencePort,
  type PersistedPrototypeGraph
} from './designer-host-ports';

describe('JSON prototype graph recovery boundary', () => {
  it('keeps new readers and saves fenced while canonical recovery is pending or failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-pending-flow-'));
    try {
      const graph = prototypeGraphFixture;
      const projectId = graph.project.projectId;
      const encodedId = encodeURIComponent(projectId);
      const activePath = join(directory, `${encodedId}.json`);
      const corrupt = 'corrupt flow bytes';
      await writeFile(activePath, corrupt);
      const persistence = new JsonPrototypeGraphPersistencePort(directory);
      let startCommit!: () => void;
      const started = new Promise<void>((resolve) => {
        startCommit = resolve;
      });
      let failCommit!: (error: Error) => void;
      const committed = new Promise<PersistedPrototypeGraph>((_resolve, reject) => {
        failCommit = reject;
      });
      const recovery = persistence.recoverFromFixture(projectId, graph, undefined, () => {
        startCommit();
        return committed;
      });
      const failed = expect(recovery).rejects.toThrow('canonical commit failed');
      await started;
      const restarted = new JsonPrototypeGraphPersistencePort(directory);
      await expect(restarted.read(projectId)).rejects.toMatchObject({
        code: 'GRAPH_PERSISTENCE_CORRUPT'
      });
      await expect(readFile(activePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const marker = JSON.parse(
        await readFile(join(directory, 'recovery', `${encodedId}.pending.json`), 'utf8')
      ) as { recoveryId: string };
      failCommit(new Error('canonical commit failed'));
      await failed;
      await expect(restarted.read(projectId)).rejects.toMatchObject({
        code: 'GRAPH_PERSISTENCE_CORRUPT',
        recoveryId: marker.recoveryId
      });
      await expect(restarted.compareAndSwap(projectId, 0, graph)).rejects.toMatchObject({
        code: 'GRAPH_PERSISTENCE_CORRUPT'
      });
      const canonical = { revision: 5, graph };
      const retried = await restarted.recoverFromFixture(
        projectId,
        graph,
        undefined,
        async () => canonical
      );
      expect(retried.saved).toEqual(canonical);
      expect(retried.receipt.recoveryId).toBe(marker.recoveryId);
      expect(
        await readFile(
          join(directory, 'recovery', `${encodedId}-${marker.recoveryId}.json`),
          'utf8'
        )
      ).toBe(corrupt);
      // The canonical owner holds the recovered graph; legacy storage cannot
      // supply a competing fixture if canonical state later becomes unreadable.
      await expect(restarted.read(projectId)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists standalone fixture recovery when there is no canonical owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-standalone-flow-'));
    try {
      const graph = prototypeGraphFixture;
      const projectId = graph.project.projectId;
      await writeFile(join(directory, `${encodeURIComponent(projectId)}.json`), 'corrupt');
      const persistence = new JsonPrototypeGraphPersistencePort(directory);
      const recovered = await persistence.recoverFromFixture(projectId, graph);
      expect(recovered.saved).toEqual({ revision: 1, graph });
      await expect(
        new JsonPrototypeGraphPersistencePort(directory).read(projectId)
      ).resolves.toEqual(recovered.saved);
      await expect(persistence.compareAndSwap(projectId, 1, graph)).resolves.toEqual({
        revision: 2,
        graph
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns committed canonical recovery even if pending-marker cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-recovery-cleanup-'));
    try {
      const graph = prototypeGraphFixture;
      const projectId = graph.project.projectId;
      const encodedId = encodeURIComponent(projectId);
      await writeFile(join(directory, `${encodedId}.json`), 'corrupt');
      const persistence = new JsonPrototypeGraphPersistencePort(directory);
      const canonical = { revision: 3, graph };
      const result = await persistence.recoverFromFixture(projectId, graph, undefined, async () => {
        const markerPath = join(directory, 'recovery', `${encodedId}.pending.json`);
        await rm(markerPath);
        await mkdir(markerPath);
        return canonical;
      });
      expect(result.saved).toEqual(canonical);
      await expect(
        new JsonPrototypeGraphPersistencePort(directory).read(projectId)
      ).rejects.toMatchObject({
        code: 'GRAPH_PERSISTENCE_CORRUPT'
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
