import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootManifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
);

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
  asar: true,
  mac: {
    category: 'public.app-category.productivity',
    // Vite's optional native bindings are shipped for both CPU slices. They
    // must remain architecture-specific rather than being ASAR-merged.
    x64ArchFiles: '**/*.node',
    target: [{ target: 'dmg', arch: ['universal'] }]
  },
  dmg: {
    sign: false
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  linux: {
    category: 'Development',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ]
  },
  // electron-builder reads signing/notarization credentials only when a
  // protected workflow explicitly supplies them. Unsigned builds get no
  // credential-shaped environment values and remain the default.
  afterSign:
    process.env.SELENE_SIGNING_APPROVED === 'true'
      ? fileURLToPath(new URL('../../scripts/notarize-desktop.mjs', import.meta.url))
      : undefined
};
