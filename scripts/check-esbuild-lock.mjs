import { readFile } from 'node:fs/promises';

const minimumPatchedVersion = [0, 28, 1];
const allowedElectronViteVersion = '0.25.12';

function parseJsonc(source) {
  return JSON.parse(source.replace(/,\s*([}\]])/g, '$1'));
}

function versionFromPackageReference(reference) {
  const match = /@(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?$/.exec(reference);
  if (!match) throw new Error(`Unable to read package version from lock entry: ${reference}`);
  return match.slice(1, 4).map(Number);
}

function isAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasEsbuildOverride(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) => key === 'esbuild' || hasEsbuildOverride(nested)
  );
}

const [manifestSource, lockSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../bun.lock', import.meta.url), 'utf8')
]);
const manifest = JSON.parse(manifestSource);
const lock = parseJsonc(lockSource);
const workspace = lock.workspaces?.[''];
const packages = lock.packages;

if (!workspace || !packages)
  throw new Error('bun.lock is missing its root workspace or package graph.');
if (
  hasOwn(manifest.dependencies ?? {}, 'esbuild') ||
  hasOwn(manifest.devDependencies ?? {}, 'esbuild')
)
  throw new Error('esbuild must remain a transitive resolution, not a root dependency.');
if (hasEsbuildOverride(manifest.overrides))
  throw new Error('esbuild must not be pinned with a package override.');
if (
  hasOwn(workspace.dependencies ?? {}, 'esbuild') ||
  hasOwn(workspace.devDependencies ?? {}, 'esbuild')
)
  throw new Error('bun.lock must not record a root esbuild dependency.');

const rootEsbuild = packages.esbuild;
if (!rootEsbuild) throw new Error('The shared Storybook/Vite esbuild resolution is missing.');
if (!isAtLeast(versionFromPackageReference(rootEsbuild[0]), minimumPatchedVersion))
  throw new Error('The shared Storybook/Vite esbuild resolution must be at least 0.28.1.');
for (const consumer of ['storybook', 'vite']) {
  const consumerEntry = packages[consumer];
  if (!consumerEntry) throw new Error(`${consumer} is missing from bun.lock.`);
  if (packages[`${consumer}/esbuild`])
    throw new Error(`${consumer} must use the shared patched esbuild resolution.`);
  const metadata = consumerEntry[2] ?? {};
  const acceptedRange = metadata.dependencies?.esbuild ?? metadata.peerDependencies?.esbuild;
  if (typeof acceptedRange !== 'string' || !acceptedRange.includes('^0.28.0'))
    throw new Error(`${consumer} does not declare support for the patched esbuild line.`);
}

for (const [path, entry] of Object.entries(packages)) {
  const reference = Array.isArray(entry) ? entry[0] : undefined;
  if (typeof reference !== 'string') continue;
  if (!reference.startsWith('esbuild@') && !reference.startsWith('@esbuild/')) continue;

  const isElectronViteException =
    path === 'electron-vite/esbuild' || path.startsWith('electron-vite/esbuild/@esbuild/');
  const version = versionFromPackageReference(reference).join('.');
  if (isElectronViteException) {
    if (version !== allowedElectronViteVersion)
      throw new Error(
        `electron-vite's isolated esbuild route must remain ${allowedElectronViteVersion}.`
      );
    continue;
  }
  if (!isAtLeast(versionFromPackageReference(reference), minimumPatchedVersion))
    throw new Error(`Unpatched esbuild lock entry outside electron-vite: ${path} (${version}).`);
}

console.log(
  'Verified Storybook and Vite use shared esbuild >= 0.28.1; electron-vite remains isolated.'
);
