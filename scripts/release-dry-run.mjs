import { spawnSync } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const workspaceRoots = ['apps', 'packages'];
const workspaceDirectories = await Promise.all(
  workspaceRoots.map(async (workspaceRoot) => {
    const directory = resolve(root, workspaceRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(directory, entry.name));
  })
);
const packageDirectories = [root, ...workspaceDirectories.flat()];

const manifests = await Promise.all(
  packageDirectories.map(async (directory) => {
    const manifestPath = resolve(directory, 'package.json');
    return { manifest: JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath };
  })
);

for (const [index, directory] of packageDirectories.entries()) {
  const { manifest, manifestPath } = manifests[index];

  if (manifest.private !== true) {
    throw new Error(
      `${manifest.name ?? manifestPath} is not private. Publishing requires a separately approved release change.`
    );
  }

  const packed = spawnSync({
    cmd: ['bun', 'pm', 'pack', '--dry-run', '--ignore-scripts', '--quiet'],
    cwd: directory,
    stdout: 'inherit',
    stderr: 'inherit'
  });

  if (packed.exitCode !== 0) {
    throw new Error(`Dry-run packing failed for ${manifest.name ?? manifestPath}.`);
  }
}

console.log(`Validated ${packageDirectories.length} private Selene packages with dry-run packing.`);
