import { readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const packageManifestPath = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/;
const isMissing = (error) => error?.code === 'ENOENT';

export function isRuntimePackageManifestPath(path) {
  return packageManifestPath.test(path);
}

export async function collectArchiveRuntimeManifests({ entries, extractFile }) {
  const manifestPaths = entries.filter(isRuntimePackageManifestPath).sort();
  return Promise.all(
    manifestPaths.map(async (path) => ({
      source: `app.asar:${path}`,
      manifest: JSON.parse(extractFile(path.replace(/^\//, '')).toString('utf8'))
    }))
  );
}

export async function collectUnpackedRuntimeManifests({
  directory,
  allowedRoot,
  maxDepth = 8,
  maxEntries = 2_000
}) {
  const resolvedRoot = await realpath(allowedRoot);
  const containedInRoot = (candidate) =>
    candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`);
  const manifests = [];
  const visited = new Set();
  let entriesSeen = 0;

  const walk = async (current, depth) => {
    if (depth > maxDepth)
      throw new Error(`Runtime SBOM traversal exceeded maximum depth ${maxDepth}.`);
    let resolvedCurrent;
    try {
      resolvedCurrent = await realpath(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!containedInRoot(resolvedCurrent) || visited.has(resolvedCurrent)) return;
    visited.add(resolvedCurrent);

    const entries = await readdir(resolvedCurrent, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        entriesSeen += 1;
        if (entriesSeen > maxEntries)
          throw new Error(`Runtime SBOM traversal exceeded ${maxEntries} entries.`);
        const child = resolve(resolvedCurrent, entry.name);
        if (entry.isDirectory()) return walk(child, depth + 1);
        const packagePath = `/${relative(resolvedRoot, child).split(sep).join('/')}`;
        if (
          entry.isFile() &&
          entry.name === 'package.json' &&
          isRuntimePackageManifestPath(packagePath)
        ) {
          manifests.push({
            source: `app.asar.unpacked:${child.slice(resolvedRoot.length + 1)}`,
            manifest: JSON.parse(await readFile(child, 'utf8'))
          });
        }
      })
    );
  };

  await walk(directory, 0);
  return manifests;
}

export function runtimeComponents({ manifests, electronVersion, deniedLicenses }) {
  const components = new Map();
  for (const { manifest, source } of manifests) {
    if (!manifest?.name || !manifest.version) continue;
    const key = `${manifest.name}@${manifest.version}`;
    const license = typeof manifest.license === 'string' ? manifest.license : undefined;
    const forbiddenLicense = deniedLicenses.find((entry) => license?.includes(entry));
    if (forbiddenLicense) throw new Error(`${key} declares denied license ${forbiddenLicense}.`);
    components.set(key, {
      type: 'library',
      'bom-ref': `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version}`,
      name: manifest.name,
      version: manifest.version,
      scope: 'required',
      ...(license ? { licenses: [{ license: { id: license } }] } : {}),
      properties: [{ name: 'selene:runtime-evidence', value: source }],
      purl: `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version}`
    });
  }
  const electronKey = `electron@${electronVersion}`;
  components.set(electronKey, {
    type: 'framework',
    'bom-ref': `pkg:npm/electron@${electronVersion}`,
    name: 'electron',
    version: electronVersion,
    scope: 'required',
    properties: [{ name: 'selene:runtime-evidence', value: 'electron-builder runtime target' }],
    purl: `pkg:npm/electron@${electronVersion}`
  });
  return [...components.values()].sort((left, right) => left.name.localeCompare(right.name));
}
