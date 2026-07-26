import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DesktopBunRuntimeResourceLocator } from './bun-runtime-location';
import {
  FixedMacUnzipProcessRunner,
  PackagedMacBunRuntimeProvider,
  type BunUnzipChild,
  type BunRuntimeSystemPort,
  type BunUnzipSpawnOptions
} from './verified-bun-runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const arm64ArchiveName = 'bun-darwin-aarch64.zip';

interface RuntimeFixture {
  readonly repositoryRoot: string;
  readonly resourceRoot: string;
  readonly bunRoot: string;
  readonly archRoot: string;
  readonly userDataRoot: string;
  readonly locator: DesktopBunRuntimeResourceLocator;
  readonly provider: PackagedMacBunRuntimeProvider;
}

async function provenance(): Promise<Buffer> {
  return readFile(new URL('../../bun-runtime-provenance.json', import.meta.url));
}

function forbiddenSystem(): BunRuntimeSystemPort {
  return Object.freeze({
    platform: 'darwin',
    arch: 'arm64',
    fixedUnzip: async () => {
      throw new Error('unzip must not be reached');
    },
    spawnUnzip: () => {
      throw new Error('spawn must not be reached');
    }
  });
}

async function runtimeFixture(
  system: BunRuntimeSystemPort = forbiddenSystem()
): Promise<RuntimeFixture> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'selene-runtime-provider-'));
  roots.push(repositoryRoot);
  const appPath = join(repositoryRoot, 'apps', 'desktop');
  const resourceRoot = join(repositoryRoot, 'artifacts', 'desktop-runtime');
  const bunRoot = join(resourceRoot, 'bun');
  const archRoot = join(bunRoot, 'arm64');
  const userDataRoot = join(repositoryRoot, 'user-data');
  await mkdir(appPath, { recursive: true });
  await mkdir(archRoot, { recursive: true });
  await mkdir(userDataRoot, { recursive: true });
  const locator = new DesktopBunRuntimeResourceLocator({
    isPackaged: false,
    appPath,
    resourcesPath: join(repositoryRoot, 'unused-electron-resources')
  });
  return {
    repositoryRoot,
    resourceRoot,
    bunRoot,
    archRoot,
    userDataRoot,
    locator,
    provider: new PackagedMacBunRuntimeProvider(locator, userDataRoot, system)
  };
}

async function expectSetupRequired(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
}

describe('verified development Bun runtime provider', () => {
  it('classifies missing and corrupt provenance as setup-required', async () => {
    const missing = await runtimeFixture();
    await expectSetupRequired(missing.provider.resolve({ signal: new AbortController().signal }));

    const corrupt = await runtimeFixture();
    await writeFile(join(corrupt.bunRoot, 'provenance.json'), '{}', { mode: 0o600 });
    await expectSetupRequired(corrupt.provider.resolve({ signal: new AbortController().signal }));
  });

  it('classifies missing and corrupt archives as setup-required', async () => {
    const missing = await runtimeFixture();
    await writeFile(join(missing.bunRoot, 'provenance.json'), await provenance(), { mode: 0o600 });
    await expectSetupRequired(missing.provider.resolve({ signal: new AbortController().signal }));

    const corrupt = await runtimeFixture();
    await writeFile(join(corrupt.bunRoot, 'provenance.json'), await provenance(), { mode: 0o600 });
    await writeFile(join(corrupt.archRoot, arm64ArchiveName), 'wrong archive bytes', {
      mode: 0o600
    });
    await expectSetupRequired(corrupt.provider.resolve({ signal: new AbortController().signal }));
  });

  it('rejects a Bun ancestor symlink before reading through lexical containment', async () => {
    const fixture = await runtimeFixture();
    await writeFile(join(fixture.bunRoot, 'provenance.json'), await provenance(), { mode: 0o600 });
    const outside = await mkdtemp(join(tmpdir(), 'selene-runtime-outside-'));
    roots.push(outside);
    await rm(fixture.archRoot, { recursive: true });
    await symlink(outside, fixture.archRoot);
    await expectSetupRequired(fixture.provider.resolve({ signal: new AbortController().signal }));
  });

  it('detects an app-owned staging ancestor replacement after it was pinned', async () => {
    const fixture = await runtimeFixture();
    const pinned = await fixture.locator.locate();
    const outside = await mkdtemp(join(tmpdir(), 'selene-runtime-replacement-'));
    roots.push(outside);
    await rm(fixture.resourceRoot, { recursive: true });
    await symlink(outside, fixture.resourceRoot);
    await expect(fixture.locator.assertPinned(pinned)).rejects.toMatchObject({
      code: 'SETUP_REQUIRED'
    });
  });

  it('uses the injected fixed executable with no shell or PATH in the actual process runner', async () => {
    const calls: Array<{
      readonly executable: string;
      readonly argumentsList: readonly string[];
      readonly options: BunUnzipSpawnOptions;
    }> = [];
    let fixtureScript = '';
    const system: BunRuntimeSystemPort = Object.freeze({
      platform: 'darwin',
      arch: 'arm64',
      fixedUnzip: async () => process.execPath,
      spawnUnzip: (
        executable: string,
        argumentsList: readonly string[],
        options: BunUnzipSpawnOptions
      ): BunUnzipChild => {
        calls.push({ executable, argumentsList: [...argumentsList], options });
        return spawn(executable, [fixtureScript, ...argumentsList], options) as BunUnzipChild;
      }
    });
    const fixture = await runtimeFixture();
    fixtureScript = join(fixture.repositoryRoot, 'controlled-unzip.mjs');
    await writeFile(
      fixtureScript,
      [
        "if (process.argv[2] !== '--controlled-probe') process.exitCode = 2;",
        "else process.stdout.write('fixed-runner-ok');"
      ].join('\n'),
      { mode: 0o600 }
    );
    await chmod(fixtureScript, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = join(fixture.repositoryRoot, 'untrusted-path-shadow');
    try {
      const output = await new FixedMacUnzipProcessRunner(system).run(
        ['--controlled-probe'],
        fixture.repositoryRoot,
        new AbortController().signal
      );
      expect(output).toBe('fixed-runner-ok');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call.executable).toBe(process.execPath);
      expect(call.options.shell).toBe(false);
      expect(call.options.detached).toBe(true);
      expect(call.options.env.PATH).toBeUndefined();
      expect(Object.getPrototypeOf(call.options.env)).toBeNull();
      expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    }
  });
});
