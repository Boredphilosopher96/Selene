import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareDesktopDevelopmentRuntime } from './prepare-desktop-development-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = dirname(dirname(scriptPath));

export const requiredDesktopWorkspaceBuilds = Object.freeze([
  Object.freeze({
    packageName: 'core',
    artifacts: Object.freeze(['dist/index.js']),
    prerequisites: Object.freeze([
      Object.freeze({
        packageName: 'project-schema',
        artifacts: Object.freeze(['dist/index.js'])
      })
    ])
  }),
  Object.freeze({ packageName: 'agent-sdk', artifacts: Object.freeze(['dist/index.js']) }),
  Object.freeze({ packageName: 'collaboration', artifacts: Object.freeze(['dist/index.js']) }),
  Object.freeze({ packageName: 'design-inputs', artifacts: Object.freeze(['dist/index.js']) }),
  Object.freeze({ packageName: 'host-runtime', artifacts: Object.freeze(['dist/index.js']) }),
  Object.freeze({
    packageName: 'identity-runtime',
    artifacts: Object.freeze(['dist/index.js', 'dist/node.js'])
  })
]);

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

async function verifyArtifact(packageRoot, artifact) {
  const path = resolve(packageRoot, artifact);
  if (!contained(packageRoot, path))
    throw new Error('Desktop workspace build artifact path is unsafe.');
  const before = await lstat(path);
  const actual = await realpath(path);
  const after = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    actual !== path ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !contained(packageRoot, actual)
  )
    throw new Error(`Desktop workspace build did not emit ${basename(path)} safely.`);
}

async function verifyDirectory(path, parent) {
  if (parent !== undefined && !contained(parent, path))
    throw new Error('Desktop development directory is outside its trusted parent.');
  const before = await lstat(path);
  const actual = await realpath(path);
  const after = await lstat(path);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    actual !== path ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    throw new Error('Desktop development directory is unsafe.');
}

async function runChild(executable, argumentsList, options) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...argumentsList], {
      ...options,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new Error('Desktop development command failed.'));
    });
  });
}

async function verifyBuildArtifacts(build, packagesRoot) {
  const packageRoot = resolve(packagesRoot, build.packageName);
  await verifyDirectory(packageRoot, packagesRoot);
  for (const artifact of build.artifacts)
    // oxlint-disable-next-line no-await-in-loop -- Every declared entrypoint must exist before Electron is allowed to start.
    await verifyArtifact(packageRoot, artifact);
}

export async function prepareRequiredDesktopWorkspaces({
  repositoryRoot = defaultRepositoryRoot,
  run = runChild
} = {}) {
  const packagesRoot = resolve(repositoryRoot, 'packages');
  await verifyDirectory(repositoryRoot);
  await verifyDirectory(packagesRoot, repositoryRoot);
  for (const build of requiredDesktopWorkspaceBuilds) {
    const packageRoot = resolve(packagesRoot, build.packageName);
    // oxlint-disable-next-line no-await-in-loop -- Package roots are attested in the same topological sequence as their builds.
    await verifyDirectory(packageRoot, packagesRoot);
    for (const prerequisite of build.prerequisites ?? [])
      // oxlint-disable-next-line no-await-in-loop -- Declared prerequisite roots are trusted only after containment and identity checks.
      await verifyDirectory(resolve(packagesRoot, prerequisite.packageName), packagesRoot);
    // oxlint-disable-next-line no-await-in-loop -- Required package builds are topologically ordered and verified before dependants.
    await run(process.execPath, ['run', '--cwd', packageRoot, 'build'], {
      cwd: repositoryRoot
    });
    for (const prerequisite of build.prerequisites ?? [])
      // oxlint-disable-next-line no-await-in-loop -- The owning build must emit and attest each prerequisite before its own output is trusted.
      await verifyBuildArtifacts(prerequisite, packagesRoot);
    // oxlint-disable-next-line no-await-in-loop -- Re-attest each package and its emitted entries after its child exits.
    await verifyBuildArtifacts(build, packagesRoot);
  }
}

export async function startDesktopDevelopment({
  repositoryRoot = defaultRepositoryRoot,
  prepareRuntime = prepareDesktopDevelopmentRuntime,
  run = runChild
} = {}) {
  await prepareRuntime();
  await prepareRequiredDesktopWorkspaces({ repositoryRoot, run });
  const desktopRoot = resolve(repositoryRoot, 'apps', 'desktop');
  await verifyDirectory(resolve(repositoryRoot, 'apps'), repositoryRoot);
  await verifyDirectory(desktopRoot, resolve(repositoryRoot, 'apps'));
  await run(process.execPath, ['run', '--cwd', desktopRoot, 'dev'], {
    cwd: repositoryRoot
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath)
  await startDesktopDevelopment();
