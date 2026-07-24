import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDesktopPackageOptions } from './package-desktop-options.mjs';
import {
  assertReleaseAssetSet,
  stageDesktopReleaseAssets
} from './stage-desktop-release-assets.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = resolve(root, 'apps/desktop');
const configPath = resolve(desktopRoot, 'electron-builder.config.mjs');
const { platform, arch, dryRun, smoke } = parseDesktopPackageOptions(process.argv.slice(2));
const electronBuilderTarget = { macos: '--mac', linux: '--linux', windows: '--win' }[platform];

const buildDirectory = resolve(root, 'artifacts/desktop-build', `${platform}-${arch}`);
const releaseDirectory = resolve(root, 'artifacts/release-assets', `${platform}-${arch}`);
const productVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const assetPrefix = `Selene-${productVersion}-${platform}-${arch}`;
const checksumName = `${assetPrefix}.SHA256SUMS.txt`;
const sbomName = `${assetPrefix}.sbom.cdx.json`;
await mkdir(buildDirectory, { recursive: true });

const run = (cmd, cwd = root, env = process.env) => {
  const result = Bun.spawnSync({ cmd, cwd, stdout: 'inherit', stderr: 'inherit', env });
  if (!result.success) throw new Error(`${cmd.join(' ')} failed with exit code ${result.exitCode}`);
};

run(['bun', 'run', '--cwd', desktopRoot, 'build']);
run(
  [
    'bunx',
    'electron-builder',
    '--projectDir',
    desktopRoot,
    '--config',
    configPath,
    electronBuilderTarget,
    `--${arch}`,
    '--publish',
    'never',
    ...(dryRun ? ['--dir'] : [])
  ],
  root,
  { ...process.env, SELENE_DESKTOP_ARTIFACT_DIR: buildDirectory }
);

if (!existsSync(buildDirectory))
  throw new Error(`electron-builder did not create ${buildDirectory}`);

if (!dryRun) {
  const installers = await stageDesktopReleaseAssets({
    platform,
    builderDirectory: buildDirectory,
    releaseDirectory,
    checksumName,
    allowedRoot: resolve(root, 'artifacts')
  });
  run(['bun', 'scripts/generate-sbom.mjs', '--output', resolve(releaseDirectory, sbomName)]);
  await assertReleaseAssetSet({
    releaseDirectory,
    installers,
    checksumName,
    sbomName
  });
}
if (smoke)
  run(['bun', 'scripts/smoke-desktop.mjs', '--platform', platform, '--directory', buildDirectory]);

console.log(
  `${dryRun ? 'Dry-run packaged' : 'Packaged'} Selene ${platform}-${arch}; ${dryRun ? 'unpacked smoke output' : 'bounded release assets'} are in ${dryRun ? buildDirectory : releaseDirectory}`
);
