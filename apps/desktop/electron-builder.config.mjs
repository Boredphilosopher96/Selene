import { lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
