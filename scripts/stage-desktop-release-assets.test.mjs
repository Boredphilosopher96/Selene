import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertReleaseAssetSet,
  selectInstallers,
  stageDesktopReleaseAssets
} from './stage-desktop-release-assets.mjs';

describe('desktop release asset staging', () => {
  it('stages only the expected installer and installer checksum', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'selene-release-assets-'));
    try {
      const builderDirectory = resolve(root, 'builder');
      const releaseDirectory = resolve(root, 'release-assets/macos-universal');
      await mkdir(builderDirectory, { recursive: true });
      await mkdir(releaseDirectory, { recursive: true });
      await writeFile(
        resolve(builderDirectory, 'Selene-0.1.0-alpha.0-mac-universal.dmg'),
        'installer'
      );
      await writeFile(resolve(builderDirectory, 'builder-debug.yml'), 'transient');
      await writeFile(resolve(releaseDirectory, 'stale.txt'), 'stale');

      const installers = await stageDesktopReleaseAssets({
        platform: 'macos',
        builderDirectory,
        releaseDirectory,
        checksumName: 'Selene-0.1.0-alpha.0-macos-universal.SHA256SUMS.txt',
        allowedRoot: root
      });
      const checksumName = 'Selene-0.1.0-alpha.0-macos-universal.SHA256SUMS.txt';
      await writeFile(
        resolve(releaseDirectory, 'Selene-0.1.0-alpha.0-macos-universal.sbom.cdx.json'),
        '{}'
      );
      await assertReleaseAssetSet({
        releaseDirectory,
        installers,
        checksumName,
        sbomName: 'Selene-0.1.0-alpha.0-macos-universal.sbom.cdx.json'
      });
      await expect(readFile(resolve(releaseDirectory, checksumName), 'utf8')).resolves.toContain(
        'Selene-0.1.0-alpha.0-mac-universal.dmg'
      );
      await writeFile(resolve(releaseDirectory, 'unexpected.txt'), 'unexpected');
      await expect(
        assertReleaseAssetSet({
          releaseDirectory,
          installers,
          checksumName,
          sbomName: 'Selene-0.1.0-alpha.0-macos-universal.sbom.cdx.json'
        })
      ).rejects.toThrow('Release asset directory contains');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, duplicate, unexpected, and symlinked installers', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'selene-release-assets-'));
    try {
      const builderDirectory = resolve(root, 'builder');
      await mkdir(builderDirectory, { recursive: true });
      await writeFile(resolve(builderDirectory, 'first.dmg'), 'one');
      await writeFile(resolve(builderDirectory, 'second.dmg'), 'two');
      await expect(selectInstallers({ platform: 'macos', builderDirectory })).rejects.toThrow(
        'exactly one .dmg'
      );
      await rm(resolve(builderDirectory, 'second.dmg'));
      await writeFile(resolve(builderDirectory, 'unexpected.zip'), 'zip');
      await expect(selectInstallers({ platform: 'macos', builderDirectory })).rejects.toThrow(
        'Unexpected .zip installer'
      );
      await rm(resolve(builderDirectory, 'unexpected.zip'));
      await rm(resolve(builderDirectory, 'first.dmg'));
      await writeFile(resolve(root, 'outside.dmg'), 'outside');
      await symlink(resolve(root, 'outside.dmg'), resolve(builderDirectory, 'linked.dmg'));
      await expect(selectInstallers({ platform: 'macos', builderDirectory })).rejects.toThrow(
        'found 0'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a release directory that escapes the artifact root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'selene-release-assets-'));
    try {
      const builderDirectory = resolve(root, 'builder');
      await mkdir(builderDirectory, { recursive: true });
      await writeFile(resolve(builderDirectory, 'Selene.dmg'), 'installer');
      await expect(
        stageDesktopReleaseAssets({
          platform: 'macos',
          builderDirectory,
          releaseDirectory: resolve(root, '..', 'escaped-release-assets'),
          checksumName: 'SHA256SUMS.txt',
          allowedRoot: root
        })
      ).rejects.toThrow('outside the allowed artifact root');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
