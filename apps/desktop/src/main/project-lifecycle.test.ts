import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createInMemoryProjectLifecycleStorage,
  FileProjectLifecycleStoragePort,
  LocalProjectLifecycleService,
  ProjectLifecycleError
} from './project-lifecycle';

function workspace(projectId: string, revision = 'r1', summary = 'Initial design') {
  return {
    format: 'selene-react-workspace/v1' as const,
    projectId,
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx' as const,
        content:
          'export default function App(){return <main data-selene-node-id="app.root">Ready</main>}'
      }
    ],
    dependencies: ['react', 'react-dom', 'react-dom/client'],
    nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
    revision: { id: revision, createdAt: '2026-07-24T00:00:00.000Z', summary }
  };
}

function service() {
  const storage = createInMemoryProjectLifecycleStorage();
  let tick = 0;
  return {
    storage,
    lifecycle: new LocalProjectLifecycleService(storage, {
      now: () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}.000Z`
    })
  };
}

describe('local project lifecycle persistence engine', () => {
  it('supports first run, sample/create/open/recent/duplicate/archive/restore without network access', async () => {
    const { lifecycle } = service();
    expect(await lifecycle.firstRun()).toMatchObject({ isFirstRun: true, projects: [] });

    await lifecycle.createSample({
      id: 'starter',
      name: 'Starter sample',
      workspace: workspace('starter')
    });
    await lifecycle.open('starter');
    const duplicate = await lifecycle.duplicate('starter', {
      id: 'starter-copy',
      name: 'Starter copy'
    });
    expect(duplicate.project).toMatchObject({ id: 'starter-copy', origin: 'duplicated' });
    await lifecycle.archive('starter');
    await expect(lifecycle.open('starter')).rejects.toMatchObject({ code: 'ARCHIVED' });
    await lifecycle.restore('starter');
    expect((await lifecycle.open('starter')).project.status).toBe('active');
    expect((await lifecycle.listRecent()).map((project) => project.id)).toEqual([
      'starter',
      'starter-copy'
    ]);
  });

  it('keeps transactional autosave separate from last-known-good source across restart, then recovers explicitly', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'orders',
      name: 'Orders',
      origin: 'created',
      workspace: workspace('orders')
    });
    await lifecycle.autosave('orders', workspace('orders', 'r2', 'Uncommitted adjustment'));
    expect((await lifecycle.open('orders')).current.revision.id).toBe('r1');

    const restarted = new LocalProjectLifecycleService(storage);
    const recovered = await restarted.recoverAutosave('orders');
    expect(recovered.current.revision).toMatchObject({
      parentId: 'r1',
      summary: 'Recovered autosave after interruption'
    });
    expect(recovered.autosave).toBeUndefined();
    expect(recovered.versions).toHaveLength(2);
  });

  it('creates immutable safe-restore versions for version history and explicit undo', async () => {
    const { lifecycle } = service();
    await lifecycle.create({
      id: 'catalog',
      name: 'Catalog',
      origin: 'created',
      workspace: workspace('catalog')
    });
    await lifecycle.autosave('catalog', workspace('catalog', 'r2', 'New catalog layout'));
    await lifecycle.recoverAutosave('catalog');
    const versions = await lifecycle.versions('catalog');
    const restored = await lifecycle.restoreVersion('catalog', versions[0]?.id ?? 'missing');
    expect(restored.current.revision.id).toMatch(/^restore-r1-/);
    expect(restored.versions).toHaveLength(3);
    const undone = await lifecycle.undo('catalog');
    expect(undone.current.revision.id).toMatch(/^restore-recovery-r2-/);
    expect(undone.versions).toHaveLength(4);
  });

  it('migrates v1 only after validation and never overwrites an existing import', async () => {
    const { lifecycle, storage } = service();
    const legacy = {
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'legacy',
        name: 'Legacy',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z'
      },
      workspace: workspace('legacy')
    };
    const imported = await lifecycle.importRecord(legacy);
    expect(imported).toMatchObject({ format: 'selene-local-project/v2', schemaVersion: 2 });
    await expect(lifecycle.importRecord(legacy)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await storage.read('legacy')).toMatchObject({ format: 'selene-local-project/v2' });
  });

  it('rolls back a failed legacy migration and quarantines its untouched source payload', async () => {
    const { lifecycle, storage } = service();
    const invalidLegacy = {
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'legacy-broken',
        name: 'Broken legacy import',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z'
      },
      workspace: { projectId: 'legacy-broken' }
    };
    await storage.commit('legacy-broken', invalidLegacy as never);
    await expect(lifecycle.open('legacy-broken')).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(await storage.read('legacy-broken')).toBeUndefined();
    expect(storage.quarantined[0]).toMatchObject({ raw: invalidLegacy });
  });

  it('quarantines corrupt records with actionable diagnostics instead of overwriting them', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'safe',
      name: 'Safe',
      origin: 'created',
      workspace: workspace('safe')
    });
    await storage.commit('broken', {
      format: 'selene-local-project/v2',
      schemaVersion: 2,
      project: { id: 'broken' }
    } as never);
    await expect(lifecycle.open('broken')).rejects.toMatchObject({ code: 'PROJECT_QUARANTINED' });
    expect(storage.quarantined).toHaveLength(1);
    expect(storage.quarantined[0]).toMatchObject({
      projectId: 'broken',
      reason: expect.stringContaining('current is not a valid portable React workspace')
    });
    expect((await lifecycle.open('safe')).current.revision.id).toBe('r1');
    await expect(lifecycle.open('broken')).rejects.toBeInstanceOf(ProjectLifecycleError);
  });

  it('does not replace the last-known-good project when an autosave transaction fails', async () => {
    const memory = createInMemoryProjectLifecycleStorage();
    let failNextCommit = false;
    const storage = {
      listProjectIds: () => memory.listProjectIds(),
      read: (id: string) => memory.read(id),
      quarantine: (entry: Parameters<typeof memory.quarantine>[0]) => memory.quarantine(entry),
      commit: async (id: string, value: Parameters<typeof memory.commit>[1]) => {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('simulated power loss before atomic rename');
        }
        await memory.commit(id, value);
      }
    };
    const lifecycle = new LocalProjectLifecycleService(storage);
    await lifecycle.create({
      id: 'safe-save',
      name: 'Safe save',
      origin: 'created',
      workspace: workspace('safe-save')
    });
    failNextCommit = true;
    await expect(lifecycle.autosave('safe-save', workspace('safe-save', 'r2'))).rejects.toThrow(
      /power loss/
    );
    const afterFailure = await lifecycle.open('safe-save');
    expect(afterFailure.current.revision.id).toBe('r1');
    expect(afterFailure.autosave).toBeUndefined();
  });

  it('persists across filesystem restart and quarantines malformed snapshot bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-lifecycle-'));
    try {
      const storage = new FileProjectLifecycleStoragePort(directory);
      const first = new LocalProjectLifecycleService(storage);
      await first.create({
        id: 'restart',
        name: 'Restart',
        origin: 'created',
        workspace: workspace('restart')
      });
      await first.autosave('restart', workspace('restart', 'r2', 'Draft before crash'));
      const restarted = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory)
      );
      expect((await restarted.recoverAutosave('restart')).versions).toHaveLength(2);

      const corruptPath = join(directory, 'projects', 'corrupt.json');
      await writeFile(corruptPath, '{not-json', 'utf8');
      await expect(restarted.open('corrupt')).rejects.toMatchObject({
        code: 'PROJECT_QUARANTINED'
      });
      const quarantineFiles = await new FileProjectLifecycleStoragePort(directory).listProjectIds();
      expect(quarantineFiles).not.toContain('corrupt');
      const quarantineDirectory = join(directory, 'quarantine');
      const entries = await readdir(quarantineDirectory);
      expect(entries).toHaveLength(1);
      expect(await readFile(join(quarantineDirectory, entries[0] ?? ''), 'utf8')).toContain(
        '{not-json'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prunes immutable history and quarantine retention deterministically at configured bounds', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    let tick = 0;
    const lifecycle = new LocalProjectLifecycleService(storage, {
      maxVersions: 2,
      maxQuarantineBytes: 64,
      now: () => `2026-07-24T00:01:${String(tick++).padStart(2, '0')}.000Z`
    });
    await lifecycle.create({
      id: 'bounded',
      name: 'Bounded',
      origin: 'created',
      workspace: workspace('bounded')
    });
    await lifecycle.autosave('bounded', workspace('bounded', 'r2'));
    await lifecycle.recoverAutosave('bounded');
    await lifecycle.autosave('bounded', workspace('bounded', 'r3'));
    const recovered = await lifecycle.recoverAutosave('bounded');
    expect(recovered.versions).toHaveLength(2);
    expect(recovered.versions.map((entry) => entry.workspace.revision.id)).toEqual([
      'recovery-r2-2',
      'recovery-r3-3'
    ]);

    await expect(lifecycle.importRecord('x'.repeat(10_000))).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(storage.quarantined[0]?.reason).toContain('payload truncated');
    expect(JSON.stringify(storage.quarantined[0]?.raw).length).toBeLessThanOrEqual(160);
  });

  it('serializes concurrent autosave and recovery so neither update is lost', async () => {
    const { lifecycle } = service();
    await lifecycle.create({
      id: 'race',
      name: 'Race',
      origin: 'created',
      workspace: workspace('race')
    });
    await lifecycle.autosave('race', workspace('race', 'r2'));
    const recovery = lifecycle.recoverAutosave('race');
    const latestDraft = lifecycle.autosave('race', workspace('race', 'r3'));
    await Promise.all([recovery, latestDraft]);
    const afterRace = await lifecycle.open('race');
    expect(afterRace.current.revision.id).toMatch(/^recovery-r2-/);
    expect(afterRace.autosave?.workspace.revision.id).toBe('r3');
    expect((await lifecycle.recoverAutosave('race')).versions).toHaveLength(3);
  });

  it('isolates a corrupt recent record instead of making healthy first-run state unavailable', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'healthy',
      name: 'Healthy',
      origin: 'created',
      workspace: workspace('healthy')
    });
    await storage.commit('bad-recent', { format: 'unknown' } as never);
    expect(await lifecycle.firstRun()).toMatchObject({
      isFirstRun: false,
      projects: [expect.objectContaining({ id: 'healthy' })]
    });
    expect(storage.quarantined).toHaveLength(1);
  });

  it('rejects noncanonical metadata and duplicate/out-of-order history before it can become active', async () => {
    const { lifecycle, storage } = service();
    await expect(
      lifecycle.create({
        id: 'invalid-origin',
        name: 'x',
        origin: 'other' as never,
        workspace: workspace('invalid-origin')
      })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
    await lifecycle.create({
      id: 'validated',
      name: '  Caf\u0065\u0301  ',
      origin: 'created',
      workspace: workspace('validated')
    });
    expect((await lifecycle.open('validated')).project.name).toBe('Café');
    const invalid = (await storage.read('validated')) as {
      versions: { id: string; createdAt: string }[];
    };
    invalid.versions.push({
      ...invalid.versions[0]!,
      id: invalid.versions[0]!.id,
      createdAt: '2026-07-24T00:00:00+00:00'
    });
    await storage.commit('validated', invalid as never);
    await expect(lifecycle.open('validated')).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
  });

  it('fsyncs and cleans temporary files when injected write or rename failures preserve the target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-atomic-'));
    try {
      const stable = new FileProjectLifecycleStoragePort(directory);
      const initial = new LocalProjectLifecycleService(stable);
      await initial.create({
        id: 'atomic',
        name: 'Atomic',
        origin: 'created',
        workspace: workspace('atomic')
      });
      const writeFailure = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory, {
          writeTemporary: async () => {
            throw new Error('injected write failure');
          }
        })
      );
      await expect(writeFailure.autosave('atomic', workspace('atomic', 'r2'))).rejects.toThrow(
        /write failure/
      );
      const renameFailure = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory, {
          rename: async () => {
            throw new Error('injected rename failure');
          }
        })
      );
      await expect(renameFailure.autosave('atomic', workspace('atomic', 'r2'))).rejects.toThrow(
        /rename failure/
      );
      expect((await initial.open('atomic')).current.revision.id).toBe('r1');
      expect(
        (await readdir(join(directory, 'projects'))).filter((file) => file.endsWith('.tmp'))
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prunes filesystem quarantine entries deterministically by timestamp retention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-quarantine-'));
    try {
      const storage = new FileProjectLifecycleStoragePort(directory, { maxQuarantineEntries: 2 });
      await storage.quarantine({
        projectId: 'bad-a',
        detectedAt: '2026-07-24T00:02:00.000Z',
        reason: 'invalid snapshot',
        raw: { id: 'bad-a' }
      });
      await storage.quarantine({
        projectId: 'bad-b',
        detectedAt: '2026-07-24T00:02:01.000Z',
        reason: 'invalid snapshot',
        raw: { id: 'bad-b' }
      });
      await storage.quarantine({
        projectId: 'bad-c',
        detectedAt: '2026-07-24T00:02:02.000Z',
        reason: 'invalid snapshot',
        raw: { id: 'bad-c' }
      });
      const entries = (await readdir(join(directory, 'quarantine'))).sort();
      expect(entries).toHaveLength(2);
      expect(entries.join(' ')).not.toContain('bad-a');
      expect(entries.join(' ')).toContain('bad-b');
      expect(entries.join(' ')).toContain('bad-c');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
