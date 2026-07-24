import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopPackagePath = join(repositoryRoot, 'apps/desktop/package.json');
if (!existsSync(desktopPackagePath)) {
  console.log('Skipping Electron runtime verification: desktop workspace is not installed');
  process.exit(0);
}

const requireFromDesktop = createRequire(desktopPackagePath);
const electronPackagePath = requireFromDesktop.resolve('electron/package.json');
const electronDirectory = dirname(electronPackagePath);
const electronPackage = JSON.parse(readFileSync(electronPackagePath, 'utf8'));

function installedRuntimePath() {
  const pointerPath = join(electronDirectory, 'path.txt');
  if (!existsSync(pointerPath)) return undefined;

  const relativeRuntimePath = readFileSync(pointerPath, 'utf8').trim();
  if (
    relativeRuntimePath.length === 0 ||
    isAbsolute(relativeRuntimePath) ||
    relativeRuntimePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error('Electron runtime pointer is invalid');
  }

  const versionPath = join(electronDirectory, 'dist/version');
  if (!existsSync(versionPath)) return undefined;
  const installedVersion = readFileSync(versionPath, 'utf8').trim().replace(/^v/, '');
  if (installedVersion !== electronPackage.version) return undefined;

  const runtimePath = join(electronDirectory, 'dist', relativeRuntimePath);
  return existsSync(runtimePath) ? runtimePath : undefined;
}

let runtimePath = installedRuntimePath();
if (runtimePath === undefined) {
  const installResult = globalThis.Bun.spawnSync({
    cmd: [process.execPath, join(electronDirectory, 'install.js')],
    cwd: electronDirectory,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env
  });
  if (!installResult.success) {
    throw new Error(`Electron ${electronPackage.version} runtime installation failed`);
  }
  runtimePath = installedRuntimePath();
}

if (runtimePath === undefined) {
  throw new Error(`Electron ${electronPackage.version} runtime is incomplete after installation`);
}

console.log(`Verified Electron ${electronPackage.version} runtime at ${runtimePath}`);
