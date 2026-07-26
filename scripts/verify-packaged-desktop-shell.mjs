import { extractFile, listPackage } from '@electron/asar';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, posix, resolve } from 'node:path';

const maximumArchiveBytes = 1_500 * 1024 * 1024;
const maximumArchiveEntries = 20_000;
const maximumDiscoveryDepth = 12;
const maximumDiscoveryEntries = 5_000;
const maximumRendererHtmlBytes = 1 * 1024 * 1024;
const maximumStylesheets = 64;
const maximumStylesheetBytes = 4 * 1024 * 1024;
const maximumStylesheetTotalBytes = 12 * 1024 * 1024;
const rendererDirectory = 'out/renderer';

const selectorGroups = Object.freeze({
  shell: Object.freeze(['.designer-workspace', '.workspace-topbar', '.workspace-product-title']),
  preview: Object.freeze([
    '.preview-pane',
    '.preview-device',
    '.preview-artifact-stage',
    '.canvas-tool-palette'
  ]),
  flow: Object.freeze(['.prototype-flow', '.prototype-flow__viewport', '.prototype-flow__node'])
});

function optionValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return undefined;
  if (argumentsList.filter((argument) => argument === name).length !== 1)
    throw new Error(`Duplicate desktop shell verifier option: ${name}.`);
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return value;
}

function normalizeArchivePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes('\0')
  )
    throw new Error(`${label} is invalid.`);
  const normalized = posix.normalize(value.replace(/^\/+/, ''));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized) ||
    normalized.includes('\\')
  )
    throw new Error(`${label} escapes the packaged renderer.`);
  return normalized;
}

function htmlAttribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function stylesheetPathFromHref(href) {
  if (
    !href ||
    href.startsWith('/') ||
    href.includes('\\') ||
    href.includes('%') ||
    href.includes('?') ||
    href.includes('#') ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
  )
    throw new Error('Packaged renderer stylesheet link is invalid.');
  const relativeHref = href.startsWith('./') ? href.slice(2) : href;
  const segments = relativeHref.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    throw new Error('Packaged renderer stylesheet link escapes the renderer base.');
  const stylesheetPath = normalizeArchivePath(
    posix.join(rendererDirectory, relativeHref),
    'Renderer stylesheet'
  );
  if (!stylesheetPath.startsWith(`${rendererDirectory}/`))
    throw new Error('Packaged renderer stylesheet link escapes the renderer base.');
  return stylesheetPath;
}

export function rendererStylesheetPaths(html, entries) {
  const knownEntries = new Set(entries.map((entry) => normalizeArchivePath(entry, 'ASAR entry')));
  const paths = new Set();
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = tag[0];
    const relation = htmlAttribute(attributes, 'rel');
    if (!relation?.split(/\s+/).some((value) => value.toLowerCase() === 'stylesheet')) continue;
    const href = htmlAttribute(attributes, 'href');
    const stylesheetPath = stylesheetPathFromHref(href);
    if (!stylesheetPath.endsWith('.css') || !knownEntries.has(stylesheetPath))
      throw new Error(`Packaged renderer stylesheet is missing: ${stylesheetPath}.`);
    paths.add(stylesheetPath);
  }
  if (paths.size === 0) throw new Error('Packaged renderer HTML does not link a stylesheet.');
  if (paths.size > maximumStylesheets)
    throw new Error(`Packaged renderer HTML links more than ${maximumStylesheets} stylesheets.`);
  return [...paths].sort();
}

async function findPackagedAsar(directory, depth = 0, traversal = { entries: 0 }) {
  if (depth > maximumDiscoveryDepth)
    throw new Error(`Desktop shell discovery exceeded depth ${maximumDiscoveryDepth}.`);
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedDirectories = [];
  const archiveCandidates = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    traversal.entries += 1;
    if (traversal.entries > maximumDiscoveryEntries)
      throw new Error(`Desktop shell discovery exceeded ${maximumDiscoveryEntries} entries.`);
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
  const descendants = await Promise.all(
    nestedDirectories.map((child) => findPackagedAsar(child, depth + 1, traversal))
  );
  return [...archiveCandidates, ...descendants.flat()];
}

function readArchiveEntry(archivePath, entryPath, maximumBytes) {
  const content = extractFile(archivePath, entryPath);
  if (!Buffer.isBuffer(content) || content.byteLength === 0 || content.byteLength > maximumBytes)
    throw new Error(`Packaged renderer entry is missing or oversized: ${entryPath}.`);
  return content;
}

export async function verifyPackagedDesktopShell({ buildDirectory }) {
  if (typeof buildDirectory !== 'string' || buildDirectory.length === 0)
    throw new Error('Desktop shell verifier requires a build directory.');
  const archives = await findPackagedAsar(resolve(buildDirectory));
  if (archives.length !== 1)
    throw new Error(`Expected exactly one packaged app.asar; found ${archives.length}.`);
  const [archivePath] = archives;
  const archiveMetadata = await lstat(archivePath);
  if (
    !archiveMetadata.isFile() ||
    archiveMetadata.isSymbolicLink() ||
    archiveMetadata.size <= 0 ||
    archiveMetadata.size > maximumArchiveBytes
  )
    throw new Error('Packaged app.asar is missing or exceeds the desktop shell verifier bound.');

  const entries = listPackage(archivePath, { isPack: false });
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > maximumArchiveEntries)
    throw new Error(`Packaged app.asar has an invalid number of entries.`);
  const normalizedEntries = entries.map((entry) => normalizeArchivePath(entry, 'ASAR entry'));
  const htmlPath = `${rendererDirectory}/index.html`;
  if (!normalizedEntries.includes(htmlPath))
    throw new Error(`Packaged app.asar does not contain ${htmlPath}.`);
  const html = readArchiveEntry(archivePath, htmlPath, maximumRendererHtmlBytes).toString('utf8');
  if (!/<div\s+id=(?:"root"|'root')\s*><\/div>/i.test(html))
    throw new Error('Packaged renderer HTML does not contain the application root.');

  const stylesheets = rendererStylesheetPaths(html, normalizedEntries);
  let stylesheetBytes = 0;
  let stylesheetText = '';
  for (const stylesheet of stylesheets) {
    const content = readArchiveEntry(archivePath, stylesheet, maximumStylesheetBytes);
    stylesheetBytes += content.byteLength;
    if (stylesheetBytes > maximumStylesheetTotalBytes)
      throw new Error('Packaged renderer stylesheet total exceeds the verifier bound.');
    stylesheetText += content.toString('utf8');
  }
  for (const [surface, selectors] of Object.entries(selectorGroups)) {
    for (const selector of selectors) {
      if (!stylesheetText.includes(selector))
        throw new Error(`Packaged renderer CSS is missing ${surface} selector ${selector}.`);
    }
  }
  return Object.freeze({ archivePath, stylesheetBytes, stylesheets: Object.freeze(stylesheets) });
}

if (import.meta.main) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 2 || !argumentsList.includes('--build-directory'))
    throw new Error(
      'Usage: bun scripts/verify-packaged-desktop-shell.mjs --build-directory <path>'
    );
  const buildDirectory = optionValue(argumentsList, '--build-directory');
  const result = await verifyPackagedDesktopShell({ buildDirectory });
  console.log(
    `Verified packaged desktop shell in ${result.archivePath}: ${result.stylesheets.length} linked CSS file(s), ${result.stylesheetBytes} bytes.`
  );
}
