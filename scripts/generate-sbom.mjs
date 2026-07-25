import { extractFile, listPackage } from '@electron/asar';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
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
const optionNames = new Set(['--platform', '--arch', '--build-directory', '--output']);
const options = new Map();
for (let index = 0; index < argumentsList.length; index += 1) {
  const name = argumentsList[index];
  if (!optionNames.has(name)) throw new Error(`Unknown or positional SBOM argument: ${name}`);
  if (options.has(name)) throw new Error(`Duplicate SBOM option: ${name}`);
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`Missing value for SBOM option ${name}.`);
  options.set(name, value);
  index += 1;
}
const optionValue = (name) => options.get(name);
const productVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const hostPlatform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
const hostArch = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!hostPlatform || !hostArch)
  throw new Error(`Unsupported SBOM host ${process.platform}/${process.arch}.`);
const platform = optionValue('--platform') ?? hostPlatform;
const arch = optionValue('--arch') ?? hostArch;
if (!['linux', 'macos', 'windows'].includes(platform))
  throw new Error(`Unsupported SBOM platform ${platform}.`);
const supportedArchitectures =
  platform === 'macos' ? ['x64', 'arm64', 'universal'] : ['x64', 'arm64'];
if (!supportedArchitectures.includes(arch))
  throw new Error(`Unsupported SBOM architecture ${arch} for ${platform}.`);
const assetPrefix = `Selene-${productVersion}-${platform}-${arch}`;
const buildDirectoryOption =
  optionValue('--build-directory') ?? `artifacts/desktop-build/${platform}-${arch}`;
const outputOption =
  optionValue('--output') ??
  `artifacts/release-assets/${platform}-${arch}/${assetPrefix}.sbom.cdx.json`;

const packagedBun = Object.freeze({
  arm64: Object.freeze({ fileName: 'bun-darwin-aarch64.zip', archiveSha256: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620', binarySha256: 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233', binaryPath: 'bun-darwin-aarch64/bun' }),
  x64: Object.freeze({ fileName: 'bun-darwin-x64.zip', archiveSha256: '4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633', binarySha256: 'ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0', binaryPath: 'bun-darwin-x64/bun' })
});

async function readBoundedNoFollow(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('This platform cannot safely inspect packaged Bun provenance.');
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size <= 0 || pathBefore.size > maximumBytes) throw new Error('Packaged Bun provenance resource is unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size) throw new Error('Packaged Bun provenance resource changed while being read.');
    const content = Buffer.alloc(before.size); let offset = 0;
    while (offset < content.byteLength) {
      const result = await handle.read(content, offset, content.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error('Packaged Bun provenance resource changed while being read.');
      offset += result.bytesRead;
    }
    const after = await handle.stat(); const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) throw new Error('Packaged Bun provenance resource changed while being read.');
    return content;
  } finally { await handle.close(); }
}
async function hashBoundedNoFollow(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('This platform cannot safely inspect a packaged Bun archive.');
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size <= 0 || pathBefore.size > maximumBytes) throw new Error('Packaged Bun archive resource is unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== pathBefore.size) throw new Error('Packaged Bun archive resource changed while being read.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      if (result.bytesRead === 0) throw new Error('Packaged Bun archive resource changed while being read.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat(); const pathAfter = await lstat(path);
    if (after.size !== before.size || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) throw new Error('Packaged Bun archive resource changed while being read.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function packagedBunComponents(resourcesDirectory) {
  if (platform !== 'macos') return [];
  const provenancePath = resolve(resourcesDirectory, 'bun', 'provenance.json');
  const provenance = JSON.parse((await readBoundedNoFollow(provenancePath, 16 * 1024)).toString('utf8'));
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.keys(provenance).sort().join(',') !== 'archives,bunVersion,format' || provenance.format !== 'selene-packaged-bun-runtime/v1' || provenance.bunVersion !== '1.3.14' || !provenance.archives || typeof provenance.archives !== 'object') throw new Error('Packaged Bun provenance resource is invalid.');
  const components = [];
  const selectedRuntimeArchitectures = arch === 'universal' ? ['arm64', 'x64'] : [arch];
  for (const runtimeArch of selectedRuntimeArchitectures) {
    if (runtimeArch !== 'arm64' && runtimeArch !== 'x64') throw new Error('Packaged Bun provenance includes an unsupported architecture.');
    const expected = packagedBun[runtimeArch]; const source = provenance.archives[runtimeArch];
    if (!source || typeof source !== 'object' || Object.keys(source).sort().join(',') !== 'archiveSha256,binaryPath,binarySha256,fileName,releaseUrl') throw new Error('Packaged Bun provenance resource is invalid.');
    if (source.fileName !== expected.fileName || source.archiveSha256 !== expected.archiveSha256 || source.binarySha256 !== expected.binarySha256 || source.binaryPath !== expected.binaryPath || source.releaseUrl !== `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/${expected.fileName}`) throw new Error('Packaged Bun provenance does not match Selene release constants.');
    const archivePath = resolve(resourcesDirectory, 'bun', runtimeArch, expected.fileName);
    if (await hashBoundedNoFollow(archivePath, 128 * 1024 * 1024) !== expected.archiveSha256) throw new Error('Packaged Bun archive resource does not match provenance.');
    components.push({
      type: 'file',
      'bom-ref': `pkg:generic/bun-darwin-${runtimeArch}@1.3.14`,
      name: `bun-darwin-${runtimeArch}-archive`, version: '1.3.14', scope: 'required',
      hashes: [{ alg: 'SHA-256', content: expected.archiveSha256 }],
      properties: [
        { name: 'selene:runtime-evidence', value: `resources/bun/${runtimeArch}/${expected.fileName}` },
        { name: 'selene:bun-binary-sha256', value: expected.binarySha256 },
        { name: 'selene:bun-binary-path', value: expected.binaryPath },
        { name: 'selene:bun-release-url', value: source.releaseUrl }
      ],
      purl: `pkg:generic/bun-darwin-${runtimeArch}@1.3.14`
    });
  }
  return components;
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
if (platform === 'macos')
  components.push(...await packagedBunComponents(dirname(archivePath)));
components.sort((left, right) => left.name.localeCompare(right.name));

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
