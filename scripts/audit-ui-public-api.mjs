import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const uiSourceDirectory = 'packages/ui/src';
const uiDistDirectory = 'packages/ui/dist';
const maximumRuntimeBytes = 32 * 1024;
const rootRuntimeEntry = 'index.js';
const workspaceRuntimeEntry = 'workspace.js';
const prototypeRuntimeEntry = 'prototype.js';

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
const workspaceExport = packageManifest.exports?.['./workspace'];
const prototypeExport = packageManifest.exports?.['./prototype'];
const optionalExports = {
  './prototype-flow': './dist/prototype-flow.js',
  './prototype-runtime': './dist/prototype-runtime.js',
  './designer-workspace': './dist/designer-workspace-entry.js'
};
if (rootExport?.import !== './dist/index.js' || rootExport.types !== './dist/index.d.ts') {
  throw new Error('@selene/ui must publish its root package export from dist/index.{js,d.ts}.');
}
if (
  workspaceExport?.import !== './dist/workspace.js' ||
  workspaceExport.types !== './dist/workspace.d.ts'
) {
  throw new Error('@selene/ui must publish its optional workspace from dist/workspace.{js,d.ts}.');
}
for (const [surface, importPath] of Object.entries(optionalExports)) {
  const entry = packageManifest.exports?.[surface];
  if (entry?.import !== importPath || entry.types !== importPath.replace(/\.js$/, '.d.ts')) {
    throw new Error(`${surface} must publish a stable dist entrypoint and declaration.`);
  }
}
if (
  prototypeExport?.import !== './dist/prototype.js' ||
  prototypeExport.types !== './dist/prototype.d.ts'
) {
  throw new Error('@selene/ui must publish prototype surfaces from dist/prototype.{js,d.ts}.');
}
await Promise.all([
  stat(join(uiDistDirectory, 'index.js')),
  stat(join(uiDistDirectory, 'index.d.ts')),
  stat(join(uiDistDirectory, 'workspace.js')),
  stat(join(uiDistDirectory, 'workspace.d.ts')),
  stat(join(uiDistDirectory, 'prototype.js')),
  stat(join(uiDistDirectory, 'prototype.d.ts')),
  ...Object.values(optionalExports).flatMap((importPath) => [
    stat(join(uiDistDirectory, importPath.slice('./dist/'.length))),
    stat(join(uiDistDirectory, importPath.slice('./dist/'.length).replace(/\.js$/, '.d.ts')))
  ])
]);

const publicTypeEntrypoints = await Promise.all(
  [
    'index.d.ts',
    'workspace.d.ts',
    'prototype.d.ts',
    ...Object.values(optionalExports).map((entry) =>
      entry.slice('./dist/'.length).replace(/\.js$/, '.d.ts')
    )
  ].map((entry) => readFile(join(uiDistDirectory, entry), 'utf8'))
);
if (
  publicTypeEntrypoints.some((source) => /(?:Collection|Label|Overlay)ContractError/.test(source))
) {
  throw new Error('@selene/ui must not publish private contract error provenance.');
}

const sourceFiles = (await files(uiSourceDirectory)).filter(
  (path) => /\.(ts|tsx)$/.test(path) && !/\.(stories|test)\.(ts|tsx)$/.test(path)
);
const reviewedRuntimeImports = new Set(['@selene/core', 'react', 'react-dom']);
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

const runtimeFiles = new Map(
  (await files(uiDistDirectory))
    .filter((path) => path.endsWith('.js'))
    .map((path) => [path.slice(uiDistDirectory.length + 1), path])
);

async function reachableRuntimeFiles(entry) {
  const reachable = new Set();
  async function visit(file) {
    if (reachable.has(file)) return;
    const path = runtimeFiles.get(file);
    if (!path) throw new Error(`Missing emitted UI runtime module: ${file}`);
    reachable.add(file);
    const source = await readFile(path, 'utf8');
    await Promise.all(
      [...source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map((match) =>
        visit(match[1].endsWith('.js') ? match[1] : `${match[1]}.js`)
      )
    );
  }
  await visit(entry);
  return reachable;
}

const rootRuntimeFiles = await reachableRuntimeFiles(rootRuntimeEntry);
const workspaceRuntimeFiles = await reachableRuntimeFiles(workspaceRuntimeEntry);
const prototypeRuntimeFiles = await reachableRuntimeFiles(prototypeRuntimeEntry);
const flowRuntimeFiles = await reachableRuntimeFiles('prototype-flow.js');
const runtimeRuntimeFiles = await reachableRuntimeFiles('prototype-runtime.js');
const designerRuntimeFiles = await reachableRuntimeFiles('designer-workspace-entry.js');
if (
  rootRuntimeFiles.has('designer-workspace.js') ||
  rootRuntimeFiles.has('workspace-primitives.js')
) {
  throw new Error('Optional workspace surfaces must not be reachable from @selene/ui.');
}
if (
  !workspaceRuntimeFiles.has('designer-workspace.js') ||
  !workspaceRuntimeFiles.has('workspace-primitives.js')
) {
  throw new Error('The @selene/ui/workspace entrypoint must include workspace implementations.');
}
if (
  rootRuntimeFiles.has('prototype-flow-canvas.js') ||
  rootRuntimeFiles.has('prototype-runtime-preview.js')
) {
  throw new Error('Executable prototype surfaces must not be reachable from @selene/ui.');
}
if (
  !prototypeRuntimeFiles.has('prototype-flow-canvas.js') ||
  !prototypeRuntimeFiles.has('prototype-runtime-preview.js')
) {
  throw new Error('The @selene/ui/prototype entrypoint must include graph and runtime views.');
}
if (
  !flowRuntimeFiles.has('prototype-flow-canvas.js') ||
  flowRuntimeFiles.has('prototype-runtime-preview.js') ||
  flowRuntimeFiles.has('orders-prototype-pages.js')
) {
  throw new Error(
    'The @selene/ui/prototype-flow entrypoint must exclude runtime and orders views.'
  );
}
if (
  !runtimeRuntimeFiles.has('prototype-runtime-preview.js') ||
  runtimeRuntimeFiles.has('prototype-flow-canvas.js')
) {
  throw new Error('The @selene/ui/prototype-runtime entrypoint must exclude the flow editor.');
}
if (
  !designerRuntimeFiles.has('designer-workspace.js') ||
  [...designerRuntimeFiles].some(
    (file) => file.startsWith('prototype-') || file.startsWith('orders-')
  )
) {
  throw new Error('The @selene/ui/designer-workspace entrypoint must exclude prototype surfaces.');
}
const runtimeBytes = (
  await Promise.all(
    [...rootRuntimeFiles].map(async (file) => (await stat(runtimeFiles.get(file))).size)
  )
).reduce((total, bytes) => total + bytes, 0);

const bundle = await Bun.build({
  entrypoints: ['scripts/fixtures/ui-primitives-consumer.tsx'],
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  minify: true,
  target: 'browser',
  write: false
});
if (!bundle.success) throw new Error('Could not bundle a primitive-only browser consumer.');
const consumerJavaScript = await Promise.all(
  bundle.outputs.filter((output) => output.kind === 'entry-point').map((output) => output.text())
).then((outputs) => outputs.join('\n'));
if (
  consumerJavaScript.includes('designer-workspace') ||
  consumerJavaScript.includes('prototype-flow-canvas')
) {
  throw new Error('A primitive-only browser consumer retained an optional product implementation.');
}
console.log(
  `ok: @selene/ui primitive root: ${(runtimeBytes / 1024).toFixed(1)} KiB / ${(maximumRuntimeBytes / 1024).toFixed(1)} KiB; optional workspace and prototype surfaces are isolated`
);
if (runtimeBytes > maximumRuntimeBytes) process.exitCode = 1;
