import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

const safeFileName = (fileName) =>
  fileName.length > 0 && basename(fileName) === fileName && !fileName.includes(sep);

export async function writeChecksums({ directory, files, outputName = 'SHA256SUMS.txt' }) {
  if (!safeFileName(outputName)) throw new Error(`Unsafe checksum output name ${outputName}.`);
  const entries = await readdir(directory, { withFileTypes: true });
  const availableFiles = new Set(
    entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map((entry) => entry.name)
  );
  const selectedFiles = files ?? [...availableFiles].filter((fileName) => fileName !== outputName);
  if (selectedFiles.length === 0)
    throw new Error(`No files selected for checksums in ${directory}.`);

  const uniqueFiles = [...new Set(selectedFiles)].sort();
  if (
    uniqueFiles.length !== selectedFiles.length ||
    uniqueFiles.some((fileName) => !safeFileName(fileName))
  ) {
    throw new Error('Checksum inputs must be unique, direct file names.');
  }
  await Promise.all(
    uniqueFiles.map(async (fileName) => {
      const filePath = resolve(directory, fileName);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !availableFiles.has(fileName)) {
        throw new Error(`Checksum input ${fileName} is not a regular direct file.`);
      }
    })
  );

  const checksums = await Promise.all(
    uniqueFiles.map(async (fileName) => {
      const digest = createHash('sha256')
        .update(await readFile(resolve(directory, fileName)))
        .digest('hex');
      return `${digest}  ${fileName}`;
    })
  );
  await writeFile(resolve(directory, outputName), `${checksums.join('\n')}\n`);
  return resolve(directory, outputName);
}

if (import.meta.main) {
  const argumentsList = process.argv.slice(2);
  const optionValue = (name) => {
    const index = argumentsList.indexOf(name);
    return index === -1 ? undefined : argumentsList[index + 1];
  };
  const directory = optionValue('--directory');
  if (!directory)
    throw new Error('Usage: generate-checksums --directory <artifact-directory> [--output <file>]');
  const files = argumentsList
    .filter((argument_) => argument_.startsWith('--file='))
    .map((argument_) => argument_.slice(7));
  const outputName = optionValue('--output');
  const outputPath = await writeChecksums({
    directory: resolve(process.cwd(), directory),
    files: files.length === 0 ? undefined : files,
    ...(outputName ? { outputName } : {})
  });
  console.log(`Wrote SHA-256 checksums to ${outputPath}.`);
}
