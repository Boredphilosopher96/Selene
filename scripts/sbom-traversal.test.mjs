import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectPackageDirectories } from './sbom-traversal.mjs';

describe('collectPackageDirectories', () => {
  it('follows only in-root links and bounds traversal depth', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'selene-sbom-'));
    try {
      const nodeModules = resolve(root, 'node_modules');
      const packageDirectory = resolve(nodeModules, 'safe-package');
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        resolve(packageDirectory, 'package.json'),
        '{"name":"safe-package","version":"1.0.0"}'
      );
      await symlink(tmpdir(), resolve(nodeModules, 'outside-link'));

      await expect(collectPackageDirectories({ nodeModules, allowedRoot: root })).resolves.toEqual([
        await realpath(packageDirectory)
      ]);
      await expect(
        collectPackageDirectories({
          nodeModules,
          allowedRoot: root,
          maxDepth: -1
        })
      ).rejects.toThrow('maximum depth');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
