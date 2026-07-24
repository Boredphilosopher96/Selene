import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDesktopPackageOptions } from './package-desktop-options.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = resolve(root, 'apps/desktop');
const configPath = resolve(desktopRoot, 'electron-builder.config.mjs');
const { platform, arch, dryRun, smoke } = parseDesktopPackageOptions(process.argv.slice(2));
const electronBuilderTarget = { macos: '--mac', linux: '--linux', windows: '--win' }[platform];

const artifactDirectory = resolve(root, 'artifacts/desktop', `${platform}-${arch}`);
await mkdir(artifactDirectory, { recursive: true });

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
  { ...process.env, SELENE_DESKTOP_ARTIFACT_DIR: artifactDirectory }
);

if (!existsSync(artifactDirectory))
  throw new Error(`electron-builder did not create ${artifactDirectory}`);

run(['bun', 'scripts/generate-sbom.mjs', '--output', resolve(artifactDirectory, 'sbom.cdx.json')]);
run(['bun', 'scripts/generate-checksums.mjs', '--directory', artifactDirectory]);
if (smoke)
  run([
    'bun',
    'scripts/smoke-desktop.mjs',
    '--platform',
    platform,
    '--directory',
    artifactDirectory
  ]);

console.log(
  `${dryRun ? 'Dry-run packaged' : 'Packaged'} Selene ${platform}-${arch} artifacts in ${artifactDirectory}`
);
