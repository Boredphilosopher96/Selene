import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

export const installerExtensions = {
  linux: ['.AppImage', '.deb'],
  macos: ['.dmg'],
  windows: ['.exe']
};
const distributableExtensions = ['.AppImage', '.deb', '.dmg', '.exe', '.msi', '.pkg', '.zip'];

const extensionFor = (fileName) =>
  distributableExtensions.find((extension) => fileName.endsWith(extension));
const directPath = (directory, fileName) =>
  fileName.length > 0 && basename(fileName) === fileName && !fileName.includes(sep)
    ? resolve(directory, fileName)
    : undefined;

export async function selectInstallers({ platform, builderDirectory }) {
  const expected = installerExtensions[platform];
  if (!expected) throw new Error(`Unsupported release platform ${platform}.`);
  const entries = await readdir(builderDirectory, { withFileTypes: true });
  const installers = new Map(expected.map((extension) => [extension, []]));

  const candidates = entries.flatMap((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) return [];
    const extension = extensionFor(entry.name);
    if (!extension) return [];
    if (!installers.has(extension)) {
      throw new Error(`Unexpected ${extension} installer for ${platform}: ${entry.name}.`);
    }
    const filePath = directPath(builderDirectory, entry.name);
    if (!filePath) throw new Error(`Unsafe installer name ${entry.name}.`);
    return [{ entry, extension, filePath }];
  });
  await Promise.all(
    candidates.map(async ({ entry, extension, filePath }) => {
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Installer ${entry.name} is not a regular direct file.`);
      }
      installers.get(extension).push(entry.name);
    })
  );

  const selected = [];
  for (const extension of expected) {
    const matches = installers.get(extension);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one ${extension} installer for ${platform}; found ${matches.length}.`
      );
    }
    selected.push(matches[0]);
  }
  return selected.sort();
}

export async function stageDesktopReleaseAssets({
  platform,
  builderDirectory,
  releaseDirectory,
  allowedRoot
}) {
  const installers = await selectInstallers({ platform, builderDirectory });
  const relativeReleaseDirectory = relative(allowedRoot, releaseDirectory);
  if (
    relativeReleaseDirectory === '' ||
    relativeReleaseDirectory === '..' ||
    relativeReleaseDirectory.startsWith(`..${sep}`) ||
    resolve(allowedRoot, relativeReleaseDirectory) !== resolve(releaseDirectory)
  ) {
    throw new Error(`Release directory ${releaseDirectory} is outside the allowed artifact root.`);
  }
  await rm(releaseDirectory, { recursive: true, force: true });
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    installers.map((installer) =>
      copyFile(resolve(builderDirectory, installer), resolve(releaseDirectory, installer))
    )
  );
  return installers;
}

export async function assertReleaseAssetSet({
  releaseDirectory,
  installers,
  checksumName,
  sbomName
}) {
  const expected = new Set([...installers, checksumName, sbomName]);
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  if (entries.length !== expected.size) {
    throw new Error(
      `Release asset directory contains ${entries.length} entries; expected ${expected.size}.`
    );
  }
  for (const entry of entries) {
    if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected or unsafe release asset ${entry.name}.`);
    }
  }
}

if (import.meta.main) {
  const argumentsList = process.argv.slice(2);
  const optionValue = (name) => {
    const index = argumentsList.indexOf(name);
    return index === -1 ? undefined : argumentsList[index + 1];
  };
  const platform = optionValue('--platform');
  const builderDirectory = optionValue('--builder-directory');
  const releaseDirectory = optionValue('--release-directory');
  if (!platform || !builderDirectory || !releaseDirectory) {
    throw new Error(
      'Usage: stage-desktop-release-assets --platform <platform> --builder-directory <directory> --release-directory <directory>'
    );
  }
  const installers = await stageDesktopReleaseAssets({
    platform,
    builderDirectory: resolve(process.cwd(), builderDirectory),
    releaseDirectory: resolve(process.cwd(), releaseDirectory),
    allowedRoot: resolve(process.cwd(), 'artifacts')
  });
  console.log(`Staged ${installers.length} ${platform} installer(s).`);
}
