import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
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

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: resolve! };
}

describe('local project lifecycle persistence engine', () => {
  it('round-trips inert workspaces with compiler-governed package dependencies', async () => {
    const { lifecycle, storage } = service();
    const base = workspace('governed-package-project');
    const governed = {
      ...base,
      dependencies: [...base.dependencies, '@acme/design-system'],
      files: base.files.map((file) =>
        file.path === base.entrypoint
          ? {
              ...file,
              content: `import { Button } from '@acme/design-system';\n${file.content}`
            }
          : file
      )
    };

    await lifecycle.create({
      id: governed.projectId,
      name: 'Governed package',
      origin: 'created',
      workspace: governed
    });
    const reopened = await new LocalProjectLifecycleService(storage).open(governed.projectId);

    expect(reopened.current.dependencies).toContain('@acme/design-system');
    expect(reopened.current.files[0]?.content).toContain(
      "import { Button } from '@acme/design-system';"
    );
  });

  it('durably stores, resolves, and removes digest-verified design guidance', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'guidance-project',
      name: 'Guidance',
      origin: 'created',
      workspace: workspace('guidance-project')
    });
    const markdown = '# Guidance\n\nUse semantic tokens.';
    const digest = (await import('node:crypto'))
      .createHash('sha256')
      .update(markdown)
      .digest('hex');
    await lifecycle.storeDesignLanguageGuidance('guidance-project', digest, markdown);
    const restarted = new LocalProjectLifecycleService(storage);
    expect(await restarted.resolveDesignLanguageGuidance('guidance-project', digest)).toBe(
      markdown
    );
    await restarted.removeDesignLanguageGuidance('guidance-project', digest);
    expect(
      await lifecycle.resolveDesignLanguageGuidance('guidance-project', digest)
    ).toBeUndefined();
    await expect(
      lifecycle.storeDesignLanguageGuidance('guidance-project', digest, '# wrong')
    ).rejects.toBeInstanceOf(ProjectLifecycleError);
  });

  it('commits guidance batches atomically with restart-safe host-only source locators', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'guidance-batch',
      name: 'Guidance batch',
      origin: 'created',
      workspace: workspace('guidance-batch')
    });
    const first = '# First\n\nOne.';
    const second = '# Second\n\nTwo.';
    const firstDigest = (await import('node:crypto'))
      .createHash('sha256')
      .update(first)
      .digest('hex');
    const secondDigest = (await import('node:crypto'))
      .createHash('sha256')
      .update(second)
      .digest('hex');
    const firstLocator = join(tmpdir(), 'selene-guidance-first.md');
    const secondLocator = join(tmpdir(), 'selene-guidance-second.mdx');

    await expect(
      lifecycle.storeDesignLanguageGuidanceBatch('guidance-batch', [
        { digest: firstDigest, markdown: first, sourceLocator: firstLocator },
        { digest: secondDigest, markdown: '# changed', sourceLocator: secondLocator }
      ])
    ).rejects.toBeInstanceOf(ProjectLifecycleError);
    await expect(
      lifecycle.resolveDesignLanguageGuidance('guidance-batch', firstDigest)
    ).resolves.toBeUndefined();

    await lifecycle.storeDesignLanguageGuidanceBatch('guidance-batch', [
      { digest: firstDigest, markdown: first, sourceLocator: firstLocator },
      { digest: secondDigest, markdown: second, sourceLocator: secondLocator }
    ]);
    const restarted = new LocalProjectLifecycleService(storage);
    await expect(
      restarted.designLanguageGuidanceLocator('guidance-batch', firstDigest)
    ).resolves.toBe(firstLocator);
    await expect(
      restarted.designLanguageGuidanceLocator('guidance-batch', secondDigest)
    ).resolves.toBe(secondLocator);

    await restarted.removeDesignLanguageGuidanceBatch('guidance-batch', [
      firstDigest,
      secondDigest
    ]);
    await expect(
      lifecycle.resolveDesignLanguageGuidance('guidance-batch', firstDigest)
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.resolveDesignLanguageGuidance('guidance-batch', secondDigest)
    ).resolves.toBeUndefined();
  });

  it('rejects hostile persisted guidance with a digest/content mismatch', async () => {
    const { lifecycle, storage } = service();
    await lifecycle.create({
      id: 'hostile-guidance',
      name: 'Hostile',
      origin: 'created',
      workspace: workspace('hostile-guidance')
    });
    const record = (await storage.read('hostile-guidance')) as Record<string, unknown>;
    await storage.commit('hostile-guidance', {
      ...record,
      designLanguageGuidance: [{ digest: '0'.repeat(64), markdown: '# mismatched' }]
    } as never);
    await expect(lifecycle.open('hostile-guidance')).rejects.toBeInstanceOf(ProjectLifecycleError);
  });

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
    expect(await lifecycle.productMap('starter')).toEqual({
      format: 'selene-desktop-product-map/v1',
      currentProjectId: 'starter',
      scope: { kind: 'standalone' },
      projects: [
        {
          projectId: 'starter',
          name: 'Starter sample',
          role: 'standalone',
          lifecycle: 'active',
          readiness: 'draft',
          currency: 'none',
          changesSinceBaseline: 0
        },
        {
          projectId: 'starter-copy',
          name: 'Starter copy',
          role: 'standalone',
          lifecycle: 'active',
          readiness: 'draft',
          currency: 'none',
          changesSinceBaseline: 0
        }
      ]
    });
    expect(await lifecycle.configureProductShell('starter', ['starter-copy'])).toMatchObject({
      currentProjectId: 'starter',
      scope: { kind: 'federation', shellProjectId: 'starter' },
      projects: [
        { projectId: 'starter', role: 'shell', shellProjectId: 'starter' },
        { projectId: 'starter-copy', role: 'child', shellProjectId: 'starter' }
      ]
    });
    expect(await lifecycle.productMap('starter-copy')).toMatchObject({
      currentProjectId: 'starter-copy',
      scope: { kind: 'federation', shellProjectId: 'starter' }
    });
    expect(await lifecycle.configureProductShell('starter', [])).toMatchObject({
      scope: { kind: 'standalone' }
    });
  });

  it('persists one authoritative shell claim and rejects cross-shell child ownership', async () => {
    const { lifecycle, storage } = service();
    await Promise.all(
      ['commerce-shell', 'support-shell', 'orders'].map((id) =>
        lifecycle.create({
          id,
          name: id,
          origin: 'created',
          workspace: workspace(id)
        })
      )
    );

    await lifecycle.configureProductShell('commerce-shell', ['orders']);
    await expect(
      lifecycle.configureProductShell('support-shell', ['orders'])
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT' });

    const restarted = new LocalProjectLifecycleService(storage);
    expect(await restarted.productMap('orders')).toMatchObject({
      scope: { kind: 'federation', shellProjectId: 'commerce-shell' },
      projects: expect.arrayContaining([
        {
          projectId: 'orders',
          role: 'child',
          shellProjectId: 'commerce-shell',
          name: 'orders',
          lifecycle: 'active',
          readiness: 'draft',
          currency: 'none',
          changesSinceBaseline: 0
        }
      ])
    });
    expect(
      (await restarted.productHandoffProjects('commerce-shell')).map((project) => ({
        projectId: project.projectId,
        workspaceProjectId: project.workspace.projectId
      }))
    ).toEqual([
      { projectId: 'commerce-shell', workspaceProjectId: 'commerce-shell' },
      { projectId: 'orders', workspaceProjectId: 'orders' }
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
    const saved = await lifecycle.autosave(
      'orders',
      workspace('orders', 'r2', 'Uncommitted adjustment')
    );
    expect(saved.autosave?.savedAt).toBe(saved.project.updatedAt);
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

  it('appends a valid legacy current workspace before advancing the migration sequence', async () => {
    const { lifecycle } = service();
    const historical = workspace('legacy-append', 'r1');
    const current = workspace('legacy-append', 'r2');
    const imported = await lifecycle.importRecord({
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'legacy-append',
        name: 'Legacy append',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:01.000Z'
      },
      workspace: current,
      versions: [
        {
          id: 'legacy-r1',
          createdAt: historical.revision.createdAt,
          summary: historical.revision.summary,
          workspace: historical
        }
      ]
    });
    expect(imported.versionSequence).toBe(2);
    expect(imported.versions.map((entry) => entry.workspace.revision.id)).toEqual(['r1', 'r2']);
    await lifecycle.autosave('legacy-append', workspace('legacy-append', 'r3'));
    expect((await lifecycle.recoverAutosave('legacy-append')).current.revision.id).toMatch(
      /^recovery-r3-3$/
    );
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
      withProjectLock: <T>(id: string, operation: () => Promise<T>) =>
        memory.withProjectLock(id, operation),
      withProductMapLock: <T>(operation: () => Promise<T>) => memory.withProductMapLock(operation),
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
      const evidence = entries.find((entry) => entry.endsWith('.json'));
      const rawEvidence = entries.find((entry) => entry.endsWith('.raw'));
      expect(evidence).toBeDefined();
      expect(rawEvidence).toBeDefined();
      expect(await readFile(join(quarantineDirectory, rawEvidence ?? ''), 'utf8')).toBe(
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

  it('survives each quarantine durability phase failure across a fresh storage/service restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-quarantine-failure-'));
    const corrupt = async (id: string, contents = '{broken') => {
      await mkdir(join(directory, 'projects'), { recursive: true });
      await writeFile(join(directory, 'projects', `${id}.json`), contents, 'utf8');
    };
    const survivesRestart = async (id: string) => {
      const restarted = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory)
      );
      expect(restarted).toBeInstanceOf(LocalProjectLifecycleService);
      const active = await readFile(join(directory, 'projects', `${id}.json`), 'utf8')
        .then(() => true)
        .catch(() => false);
      const entries = await readdir(join(directory, 'quarantine')).catch(() => [] as string[]);
      const metadata = entries.filter((entry) => entry.endsWith('.json'));
      expect(active || metadata.length > 0).toBe(true);
      if (!active) expect(metadata.length).toBeGreaterThan(0);
      return { active, entries };
    };
    const rejectsOpen = async (
      id: string,
      options: NonNullable<ConstructorParameters<typeof FileProjectLifecycleStoragePort>[1]>
    ) =>
      expect(
        new LocalProjectLifecycleService(
          new FileProjectLifecycleStoragePort(directory, options)
        ).open(id)
      ).rejects.toThrow();
    try {
      await corrupt('write-failure');
      await rejectsOpen('write-failure', {
        writeTemporary: async () => {
          throw new Error('write');
        }
      });
      expect((await survivesRestart('write-failure')).active).toBe(true);

      await corrupt('sync-failure');
      await rejectsOpen('sync-failure', {
        syncTemporary: async () => {
          throw new Error('fsync');
        }
      });
      expect((await survivesRestart('sync-failure')).active).toBe(true);

      await corrupt('publish-failure');
      await rejectsOpen('publish-failure', {
        rename: async () => {
          throw new Error('publish');
        }
      });
      expect((await survivesRestart('publish-failure')).active).toBe(true);

      await corrupt('quarantine-sync-failure');
      await rejectsOpen('quarantine-sync-failure', {
        syncDirectory: async (path) => {
          if (path.endsWith('/quarantine')) throw new Error('quarantine directory fsync');
        }
      });
      expect((await survivesRestart('quarantine-sync-failure')).active).toBe(true);

      await corrupt('raw-move-failure');
      let renameCalls = 0;
      await rejectsOpen('raw-move-failure', {
        rename: async (from, to) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error('raw move');
          await rename(from, to);
        }
      });
      expect((await survivesRestart('raw-move-failure')).active).toBe(true);

      await corrupt('remove-failure', `{${'x'.repeat(80_000)}`);
      await rejectsOpen('remove-failure', {
        remove: async () => {
          throw new Error('remove');
        }
      });
      expect((await survivesRestart('remove-failure')).active).toBe(true);

      await corrupt('projects-sync-failure');
      let directorySyncs = 0;
      await rejectsOpen('projects-sync-failure', {
        syncDirectory: async () => {
          directorySyncs += 1;
          if (directorySyncs === 2) throw new Error('projects directory fsync');
        }
      });
      expect((await survivesRestart('projects-sync-failure')).active).toBe(false);

      const pruningDirectory = await mkdtemp(join(tmpdir(), 'selene-project-prune-failure-'));
      const pruning = new FileProjectLifecycleStoragePort(pruningDirectory, {
        maxQuarantineEntries: 1,
        remove: async (path) => {
          if (path.includes('/quarantine/')) throw new Error('prune removal');
        }
      });
      await pruning.quarantine({
        projectId: 'prune-a',
        detectedAt: '2026-07-24T00:10:00.000Z',
        reason: 'bad',
        raw: { bad: true }
      });
      await expect(
        pruning.quarantine({
          projectId: 'prune-b',
          detectedAt: '2026-07-24T00:10:01.000Z',
          reason: 'bad',
          raw: { bad: true }
        })
      ).rejects.toThrow(/prune removal/);
      const restartedPrune = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(pruningDirectory)
      );
      expect(restartedPrune).toBeInstanceOf(LocalProjectLifecycleService);
      expect(
        (await readdir(join(pruningDirectory, 'quarantine'))).some((entry) =>
          entry.endsWith('.json')
        )
      ).toBe(true);
      await rm(pruningDirectory, { recursive: true, force: true });

      const pruneSyncDirectory = await mkdtemp(join(tmpdir(), 'selene-project-prune-sync-'));
      let pruneSyncs = 0;
      const pruneSync = new FileProjectLifecycleStoragePort(pruneSyncDirectory, {
        maxQuarantineEntries: 1,
        syncDirectory: async () => {
          pruneSyncs += 1;
          if (pruneSyncs === 5) throw new Error('prune directory fsync');
        }
      });
      await pruneSync.quarantine({
        projectId: 'sync-a',
        detectedAt: '2026-07-24T00:11:00.000Z',
        reason: 'bad',
        raw: { bad: true }
      });
      await expect(
        pruneSync.quarantine({
          projectId: 'sync-b',
          detectedAt: '2026-07-24T00:11:01.000Z',
          reason: 'bad',
          raw: { bad: true }
        })
      ).rejects.toThrow(/prune directory fsync/);
      const restartedSync = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(pruneSyncDirectory)
      );
      expect(restartedSync).toBeInstanceOf(LocalProjectLifecycleService);
      expect(
        (await readdir(join(pruneSyncDirectory, 'quarantine'))).some((entry) =>
          entry.endsWith('.json')
        )
      ).toBe(true);
      await rm(pruneSyncDirectory, { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('normalizes imported v1 and v2 retention without reusing their monotonic sequence', async () => {
    const { lifecycle } = (() => {
      const storage = createInMemoryProjectLifecycleStorage();
      return {
        lifecycle: new LocalProjectLifecycleService(storage, {
          maxVersions: 2,
          now: () => '2026-07-24T00:00:04.000Z'
        })
      };
    })();
    const versions = ['r1', 'r2', 'r3'].map((revision, index) => {
      const item = workspace('import-v2', revision);
      item.revision.createdAt = `2026-07-24T00:00:0${index}.000Z`;
      return {
        id: `version-${revision}`,
        createdAt: `2026-07-24T00:00:0${index + 1}.000Z`,
        summary: item.revision.summary,
        workspace: item
      };
    });
    const imported = await lifecycle.importRecord({
      format: 'selene-local-project/v2',
      schemaVersion: 2,
      versionSequence: 3,
      project: {
        id: 'import-v2',
        name: 'Imported v2',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:04.000Z'
      },
      current: structuredClone(versions[2]!.workspace),
      versions
    });
    expect(imported.versionSequence).toBe(3);
    expect(imported.versions.map((entry) => entry.workspace.revision.id)).toEqual(['r2', 'r3']);
    await lifecycle.autosave('import-v2', workspace('import-v2', 'r4'));
    expect((await lifecycle.recoverAutosave('import-v2')).versionSequence).toBe(4);

    const legacyVersions = ['r1', 'r2', 'r3'].map((revision, index) => {
      const item = workspace('import-v1', revision);
      item.revision.createdAt = `2026-07-24T00:00:0${index}.000Z`;
      return {
        id: `legacy-${revision}`,
        createdAt: `2026-07-24T00:00:0${index + 1}.000Z`,
        summary: item.revision.summary,
        workspace: item
      };
    });
    const legacy = await lifecycle.importRecord({
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'import-v1',
        name: 'Imported v1',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:04.000Z'
      },
      workspace: structuredClone(legacyVersions[2]!.workspace),
      versions: legacyVersions
    });
    expect(legacy.versionSequence).toBe(3);
    expect(legacy.versions.map((entry) => entry.workspace.revision.id)).toEqual(['r2', 'r3']);
  });

  it('quarantines v1 and v2 records whose version, current, or autosave time escapes the project lifecycle', async () => {
    const { lifecycle } = service();
    const invalidV2 = {
      format: 'selene-local-project/v2',
      schemaVersion: 2,
      versionSequence: 1,
      project: {
        id: 'invalid-times-v2',
        name: 'Invalid times',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:01.000Z',
        updatedAt: '2026-07-24T00:00:03.000Z'
      },
      current: workspace('invalid-times-v2', 'r1'),
      versions: [
        {
          id: 'version-r1',
          createdAt: '2026-07-24T00:00:02.000Z',
          summary: 'Initial design',
          workspace: workspace('invalid-times-v2', 'r1')
        }
      ]
    };
    await expect(lifecycle.importRecord(invalidV2)).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    const invalidV1 = {
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'invalid-times-v1',
        name: 'Invalid times',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:01.000Z'
      },
      workspace: workspace('invalid-times-v1', 'r1'),
      autosave: {
        savedAt: '2026-07-24T00:00:02.000Z',
        workspace: workspace('invalid-times-v1', 'r2')
      }
    };
    await expect(lifecycle.importRecord(invalidV1)).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
  });

  it('uses a shared storage lock across service instances for every conflicting lifecycle mutation', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const first = new LocalProjectLifecycleService(storage);
    const second = new LocalProjectLifecycleService(storage);
    await first.create({
      id: 'shared',
      name: 'Shared',
      origin: 'created',
      workspace: workspace('shared')
    });
    await first.autosave('shared', workspace('shared', 'r2'));
    await Promise.all([first.open('shared'), second.autosave('shared', workspace('shared', 'r3'))]);
    const afterOpen = await first.open('shared');
    expect(afterOpen.project.lastOpenedAt).toBeDefined();
    expect(afterOpen.autosave?.workspace.revision.id).toBe('r3');

    const discard = first.discardAutosave('shared');
    const recovery = second.recoverAutosave('shared');
    const outcomes = await Promise.allSettled([discard, recovery]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect((await first.open('shared')).autosave).toBeUndefined();

    const archiveOutcomes = await Promise.allSettled([
      first.archive('shared'),
      second.autosave('shared', workspace('shared', 'r4'))
    ]);
    expect(archiveOutcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    const archived = (await storage.read('shared')) as {
      project: { status: string };
      autosave?: { workspace: { revision: { id: string } } };
    };
    expect(archived.project.status).toBe('archived');
    expect(archived.autosave).toBeUndefined();
    await expect(second.autosave('shared', workspace('shared', 'r4'))).rejects.toMatchObject({
      code: 'ARCHIVED'
    });
    await expect(second.recoverAutosave('shared')).rejects.toMatchObject({ code: 'ARCHIVED' });
    await expect(second.restoreVersion('shared', 'version-r1')).rejects.toMatchObject({
      code: 'ARCHIVED'
    });
  });

  it('never reuses version IDs after retention pruning, including repeated restores', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    let tick = 0;
    const lifecycle = new LocalProjectLifecycleService(storage, {
      maxVersions: 2,
      now: () => `2026-07-24T00:03:${String(tick++).padStart(2, '0')}.000Z`
    });
    await lifecycle.create({
      id: 'sequence',
      name: 'Sequence',
      origin: 'created',
      workspace: workspace('sequence')
    });
    await lifecycle.autosave('sequence', workspace('sequence', 'r2'));
    await lifecycle.recoverAutosave('sequence');
    const restoreRepeatedly = async (remaining: number): Promise<void> => {
      if (remaining === 0) return;
      const restoreTarget = (await lifecycle.versions('sequence'))[0]?.id;
      if (restoreTarget === undefined) throw new Error('missing retained restore target');
      await lifecycle.restoreVersion('sequence', restoreTarget);
      await restoreRepeatedly(remaining - 1);
    };
    await restoreRepeatedly(6);
    const record = await lifecycle.open('sequence');
    expect(record.versionSequence).toBe(8);
    expect(record.versions).toHaveLength(2);
    expect(new Set(record.versions.map((version) => version.id)).size).toBe(2);
    expect(record.current.revision.id).toMatch(/-8$/);
  });

  it('rolls back hostile legacy migration and bounds disk/cyclic quarantine capture exactly', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const lifecycle = new LocalProjectLifecycleService(storage, { maxQuarantineBytes: 64 });
    const duplicate = workspace('legacy-hostile');
    await storage.commit('legacy-hostile', {
      format: 'selene-local-project/v1',
      schemaVersion: 1,
      project: {
        id: 'legacy-hostile',
        name: 'Legacy',
        origin: 'created',
        status: 'active',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z'
      },
      workspace: duplicate,
      versions: [
        {
          id: 'duplicate',
          createdAt: '2026-07-24T00:00:00.000Z',
          summary: 'one',
          workspace: duplicate
        },
        {
          id: 'duplicate',
          createdAt: '2026-07-24T00:00:00.000Z',
          summary: 'two',
          workspace: duplicate
        }
      ]
    } as never);
    await expect(lifecycle.open('legacy-hostile')).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    const cyclic: { children: unknown[]; self?: unknown } = {
      children: Array.from({ length: 1000 }, () => 'small')
    };
    cyclic.self = cyclic;
    await expect(lifecycle.importRecord(cyclic)).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(
      Buffer.byteLength(JSON.stringify(storage.quarantined.at(-1)?.raw), 'utf8')
    ).toBeLessThanOrEqual(64);

    const directory = await mkdtemp(join(tmpdir(), 'selene-project-read-bound-'));
    try {
      await mkdir(join(directory, 'projects'));
      await writeFile(join(directory, 'projects', 'oversized.json'), 'x'.repeat(256), 'utf8');
      const bounded = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory, { maxProjectBytes: 32 })
      );
      await expect(bounded.open('oversized')).rejects.toMatchObject({
        code: 'PROJECT_QUARANTINED'
      });
      const evidence = (await readdir(join(directory, 'quarantine'))).find((entry) =>
        entry.endsWith('.raw')
      );
      expect(await readFile(join(directory, 'quarantine', evidence ?? ''), 'utf8')).toBe(
        'x'.repeat(256)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces truthful quarantine bounds, including the two-byte empty JSON string boundary', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const tooSmall = new LocalProjectLifecycleService(storage, { maxQuarantineBytes: 1 });
    await expect(tooSmall.importRecord('invalid')).rejects.toThrow(/at least 2/);

    const bounded = new LocalProjectLifecycleService(storage, { maxQuarantineBytes: 2 });
    await expect(bounded.importRecord('invalid')).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(Buffer.byteLength(JSON.stringify(storage.quarantined.at(-1)?.raw), 'utf8')).toBe(2);
  });

  it('keeps the last-good filesystem record when a serialized commit exceeds its byte limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-commit-bound-'));
    try {
      const storage = new FileProjectLifecycleStoragePort(directory, { maxProjectBytes: 4_096 });
      const lifecycle = new LocalProjectLifecycleService(storage);
      await lifecycle.create({
        id: 'commit-bound',
        name: 'Commit bound',
        origin: 'created',
        workspace: workspace('commit-bound')
      });
      const oversizedDraft = workspace('commit-bound', 'r2');
      oversizedDraft.files[0]!.content = 'x'.repeat(8_192);
      await expect(lifecycle.autosave('commit-bound', oversizedDraft)).rejects.toThrow(
        /exceeds 4096 bytes/
      );
      const afterFailure = await new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory, { maxProjectBytes: 4_096 })
      ).open('commit-bound');
      expect(afterFailure.current.revision.id).toBe('r1');
      expect(afterFailure.autosave).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an in-flight filesystem record growth after reading from one descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-descriptor-bound-'));
    try {
      const path = join(directory, 'projects', 'growing.json');
      await mkdir(join(directory, 'projects'));
      await writeFile(path, '{"safe":true}', 'utf8');
      const storage = new FileProjectLifecycleStoragePort(directory, {
        maxProjectBytes: 32,
        afterBoundedRead: () => writeFile(path, 'x'.repeat(64), 'utf8')
      });
      const lifecycle = new LocalProjectLifecycleService(storage);
      await expect(lifecycle.open('growing')).rejects.toMatchObject({
        code: 'PROJECT_QUARANTINED'
      });
      expect(await storage.read('growing')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses a canonical durable filesystem lock across independent storage adapters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-durable-lock-'));
    try {
      const first = new FileProjectLifecycleStoragePort(directory);
      const second = new FileProjectLifecycleStoragePort(`${directory}/.`);
      const entered = deferred<void>();
      const release = deferred<void>();
      const held = first.withProjectLock('locked', async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let secondEntered = false;
      const waiting = second.withProjectLock('locked', async () => {
        secondEntered = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondEntered).toBe(false);
      release.resolve();
      await Promise.all([held, waiting]);
      expect(secondEntered).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never inspects or steals legacy on-disk locks outside its single-process contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-single-process-'));
    try {
      const lockDirectory = join(directory, 'locks');
      const lockPath = join(lockDirectory, 'legacy.lock');
      await mkdir(lockDirectory);
      await writeFile(lockPath, 'legacy lock contents', 'utf8');
      const storage = new FileProjectLifecycleStoragePort(directory);
      let ran = false;
      await storage.withProjectLock('legacy', async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(await readFile(lockPath, 'utf8')).toBe('legacy lock contents');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects proxy diagnostics without invoking hostile traps', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const lifecycle = new LocalProjectLifecycleService(storage);
    let getterCalls = 0;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          getterCalls += 1;
          return [];
        },
        get(_target, property) {
          getterCalls += 1;
          if (property === 'format') throw new Error(`bad ${'x'.repeat(4_096)}`);
          return undefined;
        }
      }
    );
    await expect(lifecycle.importRecord(hostile)).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(getterCalls).toBe(0);
    expect(storage.quarantined[0]?.reason).toContain('payload truncated');
  });

  it('keeps bounded metadata truthful when an oversized source cannot be retained as raw evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-unretained-source-'));
    try {
      await mkdir(join(directory, 'projects'));
      await writeFile(
        join(directory, 'projects', 'too-large.json'),
        `{${'x'.repeat(80_000)}`,
        'utf8'
      );
      const lifecycle = new LocalProjectLifecycleService(
        new FileProjectLifecycleStoragePort(directory)
      );
      await expect(lifecycle.open('too-large')).rejects.toMatchObject({
        code: 'PROJECT_QUARANTINED'
      });
      const entries = await readdir(join(directory, 'quarantine'));
      expect(entries.some((entry) => entry.endsWith('.raw'))).toBe(false);
      const metadata = entries.find((entry) => entry.endsWith('.json'));
      const contents = await readFile(join(directory, 'quarantine', metadata ?? ''), 'utf8');
      expect(contents).toContain('source bytes not materialized');
      expect(contents).not.toContain('exact source retained');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps derived IDs valid at the safe maximum source length', async () => {
    const { lifecycle } = service();
    const maximumRevision = `r${'x'.repeat(255)}`;
    await lifecycle.create({
      id: 'maximum-id',
      name: 'Maximum ID',
      origin: 'created',
      workspace: workspace('maximum-id', maximumRevision)
    });
    await lifecycle.autosave('maximum-id', workspace('maximum-id', maximumRevision, 'Draft'));
    const recovered = await lifecycle.recoverAutosave('maximum-id');
    expect(recovered.current.revision.id).toHaveLength(256);
    expect(recovered.versions.every((entry) => entry.id.length <= 256)).toBe(true);
  });

  it('does not collide generated IDs for adversarial long revisions with matching visible truncation', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const lifecycle = new LocalProjectLifecycleService(storage, { maxVersions: 8 });
    const base = `r${'x'.repeat(252)}`;
    await lifecycle.create({
      id: 'long-collision',
      name: 'Long collision',
      origin: 'created',
      workspace: workspace('long-collision', base)
    });
    for (const middle of ['a', 'b', 'c']) {
      const revision = `r${'x'.repeat(120)}${middle}${'y'.repeat(133)}`;
      // oxlint-disable-next-line no-await-in-loop -- each recovery advances the same sequence.
      await lifecycle.autosave('long-collision', workspace('long-collision', revision));
      // oxlint-disable-next-line no-await-in-loop -- each recovery advances the same sequence.
      await lifecycle.recoverAutosave('long-collision');
    }
    const record = await lifecycle.open('long-collision');
    const revisionIds = record.versions.map((entry) => entry.workspace.revision.id);
    expect(new Set(revisionIds).size).toBe(revisionIds.length);
    expect(new Set(record.versions.map((entry) => entry.id)).size).toBe(record.versions.length);
    expect(
      [...revisionIds, ...record.versions.map((entry) => entry.id)].every((id) => id.length <= 256)
    ).toBe(true);
  });

  it('captures huge arrays and accessor-heavy records without enumeration or getter execution', async () => {
    const storage = createInMemoryProjectLifecycleStorage();
    const lifecycle = new LocalProjectLifecycleService(storage, {
      maxImportBytes: 256,
      maxQuarantineBytes: 256
    });
    let getterCalls = 0;
    const hostile = Array.from({ length: 10_000 }, () => undefined);
    Object.defineProperty(hostile, '0', {
      get() {
        getterCalls += 1;
        return 'unexpected';
      }
    });
    await expect(lifecycle.importRecord(hostile)).rejects.toMatchObject({
      code: 'PROJECT_QUARANTINED'
    });
    expect(getterCalls).toBe(0);
    expect(
      Buffer.byteLength(JSON.stringify(storage.quarantined.at(-1)?.raw), 'utf8')
    ).toBeLessThanOrEqual(256);
  });

  it('does not enumerate or read project symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selene-project-no-follow-'));
    try {
      const projects = join(directory, 'projects');
      const outside = join(directory, 'outside.json');
      await mkdir(projects);
      await writeFile(outside, '{"outside":true}', 'utf8');
      await symlink(outside, join(projects, 'linked.json'));
      const storage = new FileProjectLifecycleStoragePort(directory);
      expect(await storage.listProjectIds()).not.toContain('linked');
      expect(await storage.read('linked')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
