import { readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const isMissing = (error) => error?.code === 'ENOENT';

export async function collectPackageDirectories({
  nodeModules,
  allowedRoot,
  maxDepth = 32,
  maxEntries = 10_000
}) {
  const resolvedRoot = await realpath(allowedRoot);
  const containedInRoot = (candidate) =>
    candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`);
  const visitedDirectories = new Set();
  const packageDirectories = new Set();
  let entriesSeen = 0;

  const walk = async (directory, depth) => {
    if (depth > maxDepth) throw new Error(`SBOM traversal exceeded maximum depth ${maxDepth}.`);

    let resolvedDirectory;
    try {
      resolvedDirectory = await realpath(directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    // Resolve before traversing: symlinks may only point into this checkout.
    if (!containedInRoot(resolvedDirectory) || visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);

    let entries;
    try {
      entries = await readdir(resolvedDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error) || error?.code === 'ENOTDIR') return;
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === '.bin') return;
        entriesSeen += 1;
        if (entriesSeen > maxEntries)
          throw new Error(`SBOM traversal exceeded ${maxEntries} entries.`);

        const child = resolve(resolvedDirectory, entry.name);
        let resolvedChild;
        try {
          resolvedChild = await realpath(child);
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        if (!containedInRoot(resolvedChild)) return;

        try {
          await readdir(resolvedChild);
        } catch (error) {
          if (error?.code === 'ENOTDIR' || isMissing(error)) return;
          throw error;
        }

        // Bun keeps transitive packages in an in-root .bun container. It is a
        // traversal-only directory, never an SBOM component itself.
        if (entry.name === '.bun' || entry.name.startsWith('@'))
          return walk(resolvedChild, depth + 1);
        if (entry.name.startsWith('.')) return;
        packageDirectories.add(resolvedChild);
        return walk(resolve(resolvedChild, 'node_modules'), depth + 1);
      })
    );
  };

  await walk(nodeModules, 0);
  return [...packageDirectories];
}
