import { extractFile, listPackage } from '@electron/asar';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import {
  collectArchiveRuntimeManifests,
  collectUnpackedRuntimeManifests,
  runtimeComponents
} from './runtime-sbom.mjs';

const root = process.cwd();
const deniedLicenses = [
  'AGPL-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'SSPL-1.0'
];
const argumentsList = process.argv.slice(2);
const optionValue = (name) => {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
};
const buildDirectoryOption = optionValue('--build-directory');
const outputOption = optionValue('--output');
if (!buildDirectoryOption || !outputOption) {
  throw new Error(
    'Usage: generate-sbom --build-directory <desktop-build-directory> --output <file>'
  );
}

async function findPackagedAsar(directory, depth = 0, traversal = { entries: 0 }) {
  if (depth > 12) throw new Error('Packaged runtime discovery exceeded maximum depth 12.');
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedDirectories = [];
  const archiveCandidates = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    traversal.entries += 1;
    if (traversal.entries > 5_000)
      throw new Error('Packaged runtime discovery exceeded 5000 entries.');
    const child = resolve(directory, entry.name);
    if (
      entry.isFile() &&
      entry.name === 'app.asar' &&
      basename(dirname(child)).toLowerCase() === 'resources'
    ) {
      archiveCandidates.push(child);
    }
    if (entry.isDirectory()) nestedDirectories.push(child);
  }
  const nestedArchives = await Promise.all(
    nestedDirectories.map((child) => findPackagedAsar(child, depth + 1, traversal))
  );
  const archives = await Promise.all(
    archiveCandidates.map(async (candidate) => {
      const metadata = await lstat(candidate);
      return metadata.isFile() && !metadata.isSymbolicLink() ? candidate : undefined;
    })
  );
  return [...archives.filter(Boolean), ...nestedArchives.flat()];
}

const buildDirectory = resolve(root, buildDirectoryOption);
const outputPath = resolve(root, outputOption);
const archives = await findPackagedAsar(buildDirectory);
if (archives.length !== 1) {
  throw new Error(
    `Expected exactly one packaged app.asar in ${buildDirectory}; found ${archives.length}.`
  );
}
const [archivePath] = archives;
const archiveEntries = listPackage(archivePath, { isPack: false });
const appManifest = JSON.parse(extractFile(archivePath, 'package.json').toString('utf8'));
const archiveManifests = await collectArchiveRuntimeManifests({
  entries: archiveEntries,
  extractFile: (path) => extractFile(archivePath, path)
});
const unpackedManifests = await collectUnpackedRuntimeManifests({
  directory: `${archivePath}.unpacked/node_modules`,
  allowedRoot: `${archivePath}.unpacked`
});
const desktopManifest = JSON.parse(
  await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8')
);
// electron-builder requires Electron in devDependencies but uses this exact
// pin as the runtime it embeds in every shipped desktop application.
const electronVersion = desktopManifest.devDependencies?.electron;
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('Desktop runtime must declare an exact Electron Builder target version.');
}
const components = runtimeComponents({
  manifests: [...archiveManifests, ...unpackedManifests],
  electronVersion,
  deniedLicenses
});
if (components.length === 1)
  throw new Error('No packaged runtime dependency manifests were found.');

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: appManifest.name, version: appManifest.version },
    tools: {
      components: [{ type: 'application', name: 'Selene runtime SBOM generator', version: '1.0.0' }]
    }
  },
  components
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(
  `Wrote packaged-runtime CycloneDX SBOM with ${components.length} components to ${outputPath}.`
);
