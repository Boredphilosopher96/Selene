import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requiredDesktopWorkspaceBuilds,
  startDesktopDevelopment
} from './start-desktop-development.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cleanWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'selene-clean-desktop-dev-'));
  roots.push(root);
  await mkdir(join(root, 'apps', 'desktop'), { recursive: true });
  const packageNames = new Set(
    requiredDesktopWorkspaceBuilds.flatMap((build) => [
      build.packageName,
      ...(build.prerequisites ?? []).map((prerequisite) => prerequisite.packageName)
    ])
  );
  await Promise.all(
    [...packageNames].map((packageName) =>
      mkdir(join(root, 'packages', packageName), { recursive: true })
    )
  );
  return root;
}

async function emitBuildArtifacts(root, build, events) {
  for (const prerequisite of build.prerequisites ?? [])
    // oxlint-disable-next-line no-await-in-loop -- The test models the owning package's declared prerequisite order.
    await emitBuildArtifacts(root, prerequisite, events);
  events.push(`build:${build.packageName}`);
  await Promise.all(
    build.artifacts.map(async (artifact) => {
      const path = join(root, 'packages', build.packageName, artifact);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, `built ${build.packageName}\n`, { mode: 0o600 });
    })
  );
}

describe('clean desktop development bootstrap', () => {
  it('delegates the project schema build exactly once to its owning core package', async () => {
    const corePackage = JSON.parse(
      await readFile(new URL('../packages/core/package.json', import.meta.url), 'utf8')
    );
    const [coreBuild] = requiredDesktopWorkspaceBuilds;

    expect(coreBuild).toMatchObject({
      packageName: 'core',
      prerequisites: [{ packageName: 'project-schema', artifacts: ['dist/index.js'] }]
    });
    expect(corePackage.scripts.build).toBe(
      'bun run --cwd ../project-schema build && tsc -p tsconfig.json'
    );
  });

  it('builds each declared prerequisite exactly once before its owner, then starts Electron', async () => {
    const root = await cleanWorkspace();
    const events = [];
    const directBuildTargets = [];
    const prepareRuntime = vi.fn(async () => {
      events.push('runtime');
    });
    const run = vi.fn(async (executable, argumentsList) => {
      expect(executable).toBe(process.execPath);
      const cwdIndex = argumentsList.indexOf('--cwd');
      const target = argumentsList[cwdIndex + 1];
      const command = argumentsList.at(-1);
      if (command === 'build') {
        const packageName = basename(target);
        directBuildTargets.push(packageName);
        const build = requiredDesktopWorkspaceBuilds.find(
          (candidate) => candidate.packageName === packageName
        );
        if (build === undefined) throw new Error('Unexpected desktop workspace build.');
        await emitBuildArtifacts(root, build, events);
      } else {
        events.push('desktop');
      }
    });

    await startDesktopDevelopment({ repositoryRoot: root, prepareRuntime, run });

    expect(events).toEqual([
      'runtime',
      'build:project-schema',
      'build:core',
      'build:agent-sdk',
      'build:collaboration',
      'build:design-inputs',
      'build:host-runtime',
      'build:identity-runtime',
      'desktop'
    ]);
    expect(directBuildTargets).toEqual(
      requiredDesktopWorkspaceBuilds.map((build) => build.packageName)
    );
    expect(directBuildTargets).not.toContain('project-schema');
    expect(directBuildTargets.filter((packageName) => packageName === 'core')).toHaveLength(1);
    expect(events.filter((event) => event === 'build:project-schema')).toHaveLength(1);
    expect(prepareRuntime).toHaveBeenCalledOnce();
  });

  it('does not start Electron when a clean workspace build omits its declared artifact', async () => {
    const root = await cleanWorkspace();
    const events = [];
    const run = vi.fn(async (_executable, argumentsList) => {
      events.push(argumentsList.at(-1));
    });
    await expect(
      startDesktopDevelopment({
        repositoryRoot: root,
        prepareRuntime: async () => undefined,
        run
      })
    ).rejects.toThrow(/artifact|emit|ENOENT/);
    expect(events).toEqual(['build']);
  });
});
