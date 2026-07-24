import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const uiSourceDirectory = 'packages/ui/src';
const uiDistDirectory = 'packages/ui/dist';
// Covers foundation primitives plus the reviewed prototype canvas/runtime surface.
const maximumRuntimeBytes = 48 * 1024;

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      })
    )
  ).flat();
}

const packageManifest = JSON.parse(await readFile('packages/ui/package.json', 'utf8'));
const rootExport = packageManifest.exports?.['.'];
if (rootExport?.import !== './dist/index.js' || rootExport.types !== './dist/index.d.ts') {
  throw new Error('@selene/ui must publish its root package export from dist/index.{js,d.ts}.');
}
await Promise.all([
  stat(join(uiDistDirectory, 'index.js')),
  stat(join(uiDistDirectory, 'index.d.ts'))
]);

const sourceFiles = (await files(uiSourceDirectory)).filter(
  (path) => /\.(ts|tsx)$/.test(path) && !/\.(stories|test)\.(ts|tsx)$/.test(path)
);
const reviewedRuntimeImports = new Set(['@selene/core', 'react']);
const externalImports = new Set();
const sourceContents = await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')));
for (const source of sourceContents) {
  for (const match of source.matchAll(/from ['"]([^./][^'"]*)['"]/g)) externalImports.add(match[1]);
}
const unexpectedImports = [...externalImports].filter(
  (name) => !reviewedRuntimeImports.has(name) && !name.startsWith('@storybook/')
);
if (unexpectedImports.length > 0) {
  throw new Error(`@selene/ui has unreviewed runtime imports: ${unexpectedImports.join(', ')}.`);
}

const runtimeFiles = (await files(uiDistDirectory)).filter(
  (path) => path.endsWith('.js') && !path.endsWith('.stories.js')
);
const runtimeBytes = (
  await Promise.all(runtimeFiles.map(async (path) => (await stat(path)).size))
).reduce((total, bytes) => total + bytes, 0);
console.log(
  `ok: @selene/ui package export contract and runtime modules: ${(runtimeBytes / 1024).toFixed(1)} KiB / ${(maximumRuntimeBytes / 1024).toFixed(1)} KiB`
);
if (runtimeBytes > maximumRuntimeBytes) process.exitCode = 1;
