import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const argumentsList = process.argv.slice(2);
if (argumentsList.length !== 2 || argumentsList[0] !== '--build-directory')
  throw new Error('Expected exactly --build-directory <path>.');
const requestedDirectory = argumentsList[1];
if (!requestedDirectory || requestedDirectory.startsWith('-'))
  throw new Error('Packaged preview runtime build directory is invalid.');

async function findPackagedAsar(directory, depth = 0, traversal = { entries: 0 }) {
  if (depth > 12) throw new Error('Packaged preview runtime discovery exceeded maximum depth 12.');
  const entries = await readdir(directory, { withFileTypes: true });
  const archiveCandidates = [];
  const nestedDirectories = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    traversal.entries += 1;
    if (traversal.entries > 5_000)
      throw new Error('Packaged preview runtime discovery exceeded 5000 entries.');
    const child = resolve(directory, entry.name);
    if (
      entry.isFile() &&
      entry.name === 'app.asar' &&
      basename(dirname(child)).toLowerCase() === 'resources'
    ) {
      archiveCandidates.push(child);
      continue;
    }
    if (entry.isDirectory()) nestedDirectories.push(child);
  }
  const [archives, nested] = await Promise.all([
    Promise.all(
      archiveCandidates.map(async (candidate) => {
        const metadata = await lstat(candidate);
        return metadata.isFile() && !metadata.isSymbolicLink() ? candidate : undefined;
      })
    ),
    Promise.all(
      nestedDirectories.map((candidate) => findPackagedAsar(candidate, depth + 1, traversal))
    )
  ]);
  return [...archives.filter(Boolean), ...nested.flat()];
}

const archiveCandidates = await findPackagedAsar(resolve(process.cwd(), requestedDirectory));
if (archiveCandidates.length !== 1)
  throw new Error(
    `Expected exactly one packaged app.asar for preview runtime verification; found ${archiveCandidates.length}.`
  );
const [archivePath] = archiveCandidates;
const unpackedRoot = `${archivePath}.unpacked`;
const isContainedPath = (root, candidate) => {
  const path = relative(root, candidate);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const requiredRuntimeFiles = [
  'node_modules/react/index.js',
  'node_modules/react/jsx-dev-runtime.js',
  'node_modules/react/jsx-runtime.js',
  'node_modules/react-dom/client.js',
  'node_modules/react-dom/index.js',
  'node_modules/scheduler/index.js'
];
const runtimeFiles = await Promise.all(
  requiredRuntimeFiles.map(async (relativePath) => {
    const candidate = resolve(unpackedRoot, relativePath);
    if (!isContainedPath(unpackedRoot, candidate))
      throw new Error('Packaged preview runtime path escaped app.asar.unpacked.');
    return { relativePath, metadata: await lstat(candidate) };
  })
);
for (const { relativePath, metadata } of runtimeFiles) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0)
    throw new Error(`Packaged preview runtime file is missing or unsafe: ${relativePath}`);
}

console.log(`Verified packaged preview runtime paths in ${archivePath}.`);
