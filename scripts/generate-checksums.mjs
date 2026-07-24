import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = process.cwd();
const argumentsList = process.argv.slice(2);
const directoryOption = argumentsList.indexOf('--directory');
if (directoryOption === -1 || !argumentsList[directoryOption + 1]) {
  throw new Error('Usage: bun scripts/generate-checksums.mjs --directory <artifact-directory>');
}

const artifactDirectory = resolve(root, argumentsList[directoryOption + 1]);
const outputName = 'SHA256SUMS.txt';

const files = [];
const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = resolve(directory, entry.name);
      if (entry.isDirectory()) return walk(filePath);
      if (entry.isFile() && entry.name !== outputName) files.push(filePath);
    })
  );
};

await walk(artifactDirectory);
const checksums = await Promise.all(
  files.sort().map(async (filePath) => {
    const digest = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');
    return `${digest}  ${filePath.slice(artifactDirectory.length + 1)}`;
  })
);

if (checksums.length === 0) throw new Error(`No package artifacts found in ${artifactDirectory}`);
await writeFile(resolve(artifactDirectory, outputName), `${checksums.join('\n')}\n`);
console.log(
  `Wrote SHA-256 checksums for ${checksums.length} artifacts to ${basename(artifactDirectory)}/${outputName}`
);
