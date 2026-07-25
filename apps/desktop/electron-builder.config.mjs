import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootManifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
);
const desktopManifest = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8')
);
const electronVersion = desktopManifest.devDependencies.electron;
const targetPlatform = process.env.SELENE_DESKTOP_TARGET_PLATFORM;
const targetArch = process.env.SELENE_DESKTOP_TARGET_ARCH;
if (!['macos', 'linux', 'windows'].includes(targetPlatform) || typeof targetArch !== 'string')
  throw new Error('Desktop packaging must declare SELENE_DESKTOP_TARGET_PLATFORM and SELENE_DESKTOP_TARGET_ARCH.');
const allowedTargetArchitectures = targetPlatform === 'macos'
  ? ['arm64', 'x64', 'universal']
  : ['x64'];
if (!allowedTargetArchitectures.includes(targetArch))
  throw new Error('Desktop packaging target architecture is unsupported.');
const configDirectory = dirname(fileURLToPath(import.meta.url));
const builderArguments = new Set(process.argv.slice(2));
const targetFlag = { macos: '--mac', linux: '--linux', windows: '--win' }[targetPlatform];
const targetFlags = ['--mac', '--linux', '--win'].filter((flag) => builderArguments.has(flag));
const architectureFlag = { arm64: '--arm64', x64: '--x64', universal: '--universal' }[targetArch];
const architectureFlags = ['--arm64', '--x64', '--universal'].filter((flag) => builderArguments.has(flag));
if (targetFlags.length !== 1 || targetFlags[0] !== targetFlag || architectureFlags.length !== 1 || architectureFlags[0] !== architectureFlag)
  throw new Error('electron-builder CLI target flags must match the declared desktop package target.');
const packagedBunArchitectures = process.env.SELENE_DESKTOP_BUN_ARCHES === undefined
  ? []
  : process.env.SELENE_DESKTOP_BUN_ARCHES.split(',');
if (new Set(packagedBunArchitectures).size !== packagedBunArchitectures.length || !packagedBunArchitectures.every((arch) => arch === 'arm64' || arch === 'x64'))
  throw new Error('SELENE_DESKTOP_BUN_ARCHES must be a unique comma-separated arm64/x64 list.');
if (targetPlatform === 'macos') {
  const required = targetArch === 'universal' ? ['arm64', 'x64'] : [targetArch];
  if (!['arm64', 'x64', 'universal'].includes(targetArch) || packagedBunArchitectures.length !== required.length || required.some((arch) => !packagedBunArchitectures.includes(arch)))
    throw new Error('macOS packaging requires exactly the verified Bun data resource for every target CPU.');
} else if (packagedBunArchitectures.length !== 0) {
  throw new Error('Only macOS packaging may include a verified Bun data resource.');
}
const packagedBunFiles = {
  arm64: 'bun-darwin-aarch64.zip',
  x64: 'bun-darwin-x64.zip'
};
const packagedBunProvenance = Object.freeze({
  arm64: Object.freeze({ fileName: 'bun-darwin-aarch64.zip', releaseUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip', archiveSha256: 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620', binarySha256: 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233', binaryPath: 'bun-darwin-aarch64/bun' }),
  x64: Object.freeze({ fileName: 'bun-darwin-x64.zip', releaseUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-x64.zip', archiveSha256: '4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633', binarySha256: 'ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0', binaryPath: 'bun-darwin-x64/bun' })
});
async function hashNoFollowResource(path, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('This platform cannot safely inspect verified Bun packaging resources.');
  const beforePath = await lstat(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size <= 0 || beforePath.size > maximumBytes) throw new Error('Verified Bun packaging resource is missing or unsafe.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024);
    if (!before.isFile() || before.size !== beforePath.size) throw new Error('Verified Bun packaging resource changed while being inspected.');
    for (let position = 0; position < before.size; position += buffer.byteLength) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position);
      if (result.bytesRead === 0) throw new Error('Verified Bun packaging resource changed while being inspected.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat(); const afterPath = await lstat(path);
    if (after.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino) throw new Error('Verified Bun packaging resource changed while being inspected.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
async function readSmallNoFollowResource(path) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('This platform cannot safely inspect verified Bun provenance.');
  const beforePath = await lstat(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size <= 0 || beforePath.size > 16 * 1024) throw new Error('Verified Bun packaging provenance is invalid.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); const content = Buffer.alloc(before.size); let offset = 0;
    if (!before.isFile() || before.size !== beforePath.size) throw new Error('Verified Bun packaging provenance changed while being inspected.');
    while (offset < content.byteLength) {
      const result = await handle.read(content, offset, content.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error('Verified Bun packaging provenance changed while being inspected.');
      offset += result.bytesRead;
    }
    const after = await handle.stat(); const afterPath = await lstat(path);
    if (after.size !== before.size || afterPath.dev !== before.dev || afterPath.ino !== before.ino) throw new Error('Verified Bun packaging provenance changed while being inspected.');
    return content;
  } finally { await handle.close(); }
}
const packagedBunResources = packagedBunArchitectures.length === 0
  ? []
  : [
      { from: '../../artifacts/desktop-runtime/bun/provenance.json', to: 'bun/provenance.json' },
      ...packagedBunArchitectures.map((arch) => ({
        from: `../../artifacts/desktop-runtime/bun/${arch}/${packagedBunFiles[arch]}`,
        to: `bun/${arch}/${packagedBunFiles[arch]}`
      }))
    ];
for (const resource of packagedBunResources) {
  const source = resolve(configDirectory, resource.from);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0)
    throw new Error('Verified Bun packaging resource is missing or unsafe.');
}
if (targetPlatform === 'macos') {
  const provenancePath = resolve(configDirectory, '../../artifacts/desktop-runtime/bun/provenance.json');
  const provenance = JSON.parse((await readSmallNoFollowResource(provenancePath)).toString('utf8'));
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.keys(provenance).sort().join(',') !== 'archives,bunVersion,format' || provenance.format !== 'selene-packaged-bun-runtime/v1' || provenance.bunVersion !== '1.3.14' || !provenance.archives || typeof provenance.archives !== 'object' || Object.keys(provenance.archives).sort().join(',') !== 'arm64,x64')
    throw new Error('Verified Bun packaging provenance is invalid.');
  for (const arch of ['arm64', 'x64']) {
    const source = provenance.archives[arch];
    if (!source || typeof source !== 'object' || Object.keys(source).sort().join(',') !== 'archiveSha256,binaryPath,binarySha256,fileName,releaseUrl')
      throw new Error('Verified Bun packaging provenance is invalid.');
    for (const [field, value] of Object.entries(packagedBunProvenance[arch])) if (source[field] !== value)
      throw new Error('Verified Bun packaging provenance does not match compiled constants.');
  }
  for (const arch of packagedBunArchitectures) {
    const source = resolve(configDirectory, '../../artifacts/desktop-runtime/bun', arch, packagedBunFiles[arch]);
    if (await hashNoFollowResource(source, 128 * 1024 * 1024) !== packagedBunProvenance[arch].archiveSha256)
      throw new Error('Verified Bun packaging archive does not match compiled provenance.');
  }
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(rootManifest.version)) {
  throw new Error(`Root package version is not a valid release version: ${rootManifest.version}`);
}

/**
 * The root package.json is Selene's sole product-version source. The desktop
 * workspace stays private and keeps its workspace version; extraMetadata
 * replaces that internal value in every shipped application package.
 */
export default {
  appId: 'io.github.boredphilosopher96.selene',
  productName: 'Selene',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    output: process.env.SELENE_DESKTOP_ARTIFACT_DIR ?? 'release'
  },
  files: ['out/**/*', 'package.json'],
  extraMetadata: {
    name: rootManifest.name,
    version: rootManifest.version
  },
  // Pin every release-matrix runtime to Electron's published SHA-256 digest.
  // This also makes a verified local cache sufficient for offline packaging;
  // electron-builder does not need a separate network fetch for SHASUMS256.
  electronDownload: {
    force: false,
    checksums: {
      [`electron-v${electronVersion}-darwin-arm64.zip`]:
        'ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28',
      [`electron-v${electronVersion}-darwin-x64.zip`]:
        '1349ff423539cfe2b3edf1b14111e618db234d9ba761cbe97ea549edcb2e7a98',
      [`electron-v${electronVersion}-linux-x64.zip`]:
        'f77ca6ed67bbc68702b69b56ad499bca6ae090705ade7d04f0ac545e409dec68',
      [`electron-v${electronVersion}-win32-x64.zip`]:
        'eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786'
    }
  },
  asar: true,
  // ZIP archives are inert data resources. Electron signing therefore never
  // touches the verified Bun Mach-O bytes inside them.
  extraResources: packagedBunResources,
  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    // Vite's optional native bindings are shipped for both CPU slices. They
    // must remain architecture-specific rather than being ASAR-merged.
    x64ArchFiles: '**/*.node',
    // electron-builder's built-in notarization is enabled only by the protected
    // macOS job after it materializes a short-lived App Store Connect API key.
    notarize:
      process.env.SELENE_SIGNING_APPROVED === 'true' &&
      Boolean(process.env.APPLE_API_KEY) &&
      Boolean(process.env.APPLE_API_KEY_ID) &&
      Boolean(process.env.APPLE_API_ISSUER),
    target: [{ target: 'dmg', arch: ['universal'] }]
  },
  dmg: {
    sign: false
  },
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  linux: {
    icon: 'build/icon.png',
    category: 'Development',
    maintainer: 'Sumukh Nitundila <Boredphilosopher96@users.noreply.github.com>',
    syncDesktopName: true,
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ]
  }
};
