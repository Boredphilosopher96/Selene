import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(packageDirectory, 'src');
const outputDirectory = resolve(packageDirectory, 'dist');
const cssAssets = Object.freeze([
  'designer-workspace.css',
  'foundation.css',
  'prototype-studio.css'
]);
const sourceExtensions = new Set(['.ts', '.tsx']);
const relativeCssImport = /\bimport\s*['"](\.{1,2}\/[^'"]+\.css)['"]/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        if (
          entry.isFile() &&
          [...sourceExtensions].some((extension) => entry.name.endsWith(extension))
        )
          return [path];
        return [];
      })
  );
  return files.flat();
}

function sourceRelativeCssPath(sourceFile, specifier) {
  const candidate = resolve(dirname(sourceFile), specifier);
  const sourceRelative = relative(sourceDirectory, candidate);
  if (isAbsolute(sourceRelative) || sourceRelative === '' || sourceRelative.startsWith(`..${sep}`))
    throw new Error(`UI CSS import escapes src: ${specifier}`);
  return sourceRelative.split(sep).join('/');
}

async function importedCssAssets() {
  const imports = await Promise.all(
    (await sourceFiles(sourceDirectory)).map(async (sourceFile) => {
      const contents = await readFile(sourceFile, 'utf8');
      return [...contents.matchAll(relativeCssImport)].map((match) =>
        sourceRelativeCssPath(sourceFile, match[1])
      );
    })
  );
  return [...new Set(imports.flat())].sort();
}

const importedAssets = await importedCssAssets();
if (importedAssets.join('\n') !== cssAssets.join('\n'))
  throw new Error('UI CSS asset list must exactly cover emitted relative CSS imports.');

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  cssAssets.map(async (asset) => {
    const source = resolve(sourceDirectory, asset);
    const destination = resolve(outputDirectory, asset);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`UI CSS asset is not a regular file: ${asset}`);
    const contents = await readFile(source);
    await writeFile(destination, contents);
  })
);
