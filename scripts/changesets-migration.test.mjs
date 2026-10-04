import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'package.json'));
const cliPath = require.resolve('@changesets/cli/bin.js');

describe('Changesets 3 release preparation compatibility', () => {
  it('adds a changeset, reports private-package bumps and versions/changelogs without publishing', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'selene-changesets-v3-'));
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, CI: 'true', npm_config_user_agent: 'bun/1.3.14' }
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result;
    };
    try {
      await mkdir(resolve(directory, '.changeset'));
      await mkdir(resolve(directory, 'packages/core'), { recursive: true });
      await mkdir(resolve(directory, 'packages/app'), { recursive: true });
      await writeFile(
        resolve(directory, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          private: true,
          packageManager: 'bun@1.3.14',
          workspaces: ['packages/*']
        })
      );
      // Manypkg 3 identifies Bun workspaces by their lockfile marker.
      await writeFile(resolve(directory, 'bun.lock'), '// Isolated Bun workspace fixture\n');
      await writeFile(
        resolve(directory, 'packages/core/package.json'),
        JSON.stringify({ name: '@selene/core', version: '0.0.0', private: true })
      );
      await writeFile(
        resolve(directory, 'packages/app/package.json'),
        JSON.stringify({
          name: '@selene/app',
          version: '0.0.0',
          private: true,
          dependencies: { '@selene/core': 'workspace:*' }
        })
      );
      const config = JSON.parse(await readFile(resolve(root, '.changeset/config.json'), 'utf8'));
      expect(config.privatePackages).toEqual({ version: true, tag: false });
      expect(config.snapshot.useCalculatedVersion).toBe(true);
      expect(Reflect.has(config, '___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH')).toBe(false);
      await writeFile(resolve(directory, '.changeset/config.json'), JSON.stringify(config));
      await symlink(resolve(root, 'node_modules'), resolve(directory, 'node_modules'), 'dir');
      await mkdir(resolve(directory, 'empty-git-hooks'));
      for (const args of [
        ['init', '--initial-branch=main'],
        ['add', 'package.json', 'bun.lock', '.changeset', 'packages'],
        [
          '-c',
          'user.name=Selene fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgSign=false',
          '-c',
          `core.hooksPath=${resolve(directory, 'empty-git-hooks')}`,
          'commit',
          '-m',
          'Initialize isolated release fixture'
        ]
      ]) {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
      run('add', '--patch', '@selene/core', '--message', 'Preserve private release preparation');
      const pending = (await readdir(resolve(directory, '.changeset'))).filter((file) =>
        file.endsWith('.md')
      );
      expect(pending).toHaveLength(1);
      run('status', '--output', resolve(directory, 'status.json'));
      const status = JSON.parse(await readFile(resolve(directory, 'status.json'), 'utf8'));
      expect(status.releases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: '@selene/core',
            oldVersion: '0.0.0',
            newVersion: '0.0.1'
          }),
          expect.objectContaining({ name: '@selene/app', oldVersion: '0.0.0', newVersion: '0.0.1' })
        ])
      );
      run('version');
      expect(
        JSON.parse(await readFile(resolve(directory, 'packages/core/package.json'), 'utf8')).version
      ).toBe('0.0.1');
      expect(
        JSON.parse(await readFile(resolve(directory, 'packages/app/package.json'), 'utf8')).version
      ).toBe('0.0.1');
      expect(await readFile(resolve(directory, 'packages/core/CHANGELOG.md'), 'utf8')).toContain(
        'Preserve private release preparation'
      );
      expect(
        (await readdir(resolve(directory, '.changeset'))).filter((file) => file.endsWith('.md'))
      ).toHaveLength(0);
      const empty = spawnSync(process.execPath, [cliPath, 'version'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000
      });
      expect(empty.error).toBeUndefined();
      expect(empty.status).toBe(1);
      expect(empty.stdout + empty.stderr).toContain('No unreleased changesets');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
