import { spawnSync } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const workspaceRoots = ['apps', 'packages'];
const packageDirectories = [root];

for (const workspaceRoot of workspaceRoots) {
  const directory = resolve(root, workspaceRoot);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) packageDirectories.push(resolve(directory, entry.name));
  }
}

for (const directory of packageDirectories) {
  const manifestPath = resolve(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

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
