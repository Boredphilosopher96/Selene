type JsonRecord = Record<string, unknown>;

function record(value: unknown, description: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${description} must be an object`);
  return value as JsonRecord;
}

/** Reads only a fully pinned dependency, so test infrastructure cannot drift with the store. */
export function exactDependencyVersion(manifest: unknown, name: string): string {
  const packageManifest = record(manifest, 'package manifest');
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies']
    .flatMap((section) => {
      const dependencies = packageManifest[section];
      if (dependencies === undefined) return [];
      return [record(dependencies, `${section} in package manifest`)[name]];
    })
    .filter((version): version is string => typeof version === 'string');

  if (declared.length !== 1)
    throw new Error(`package manifest must declare exactly one version for ${name}`);
  const version = declared[0];
  if (version === undefined)
    throw new Error(`package manifest must declare exactly one version for ${name}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`package manifest must pin ${name} to an exact version`);
  return version;
}

export function exactBunStoreEntry(
  name: string,
  version: string,
  entries: readonly string[]
): string {
  const expected = `${name}@${version}`;
  const matches = entries.filter(
    (entry) =>
      entry === expected ||
      (entry.startsWith(`${expected}+`) && /^[0-9a-z]+$/.test(entry.slice(expected.length + 1)))
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `Bun package store is missing exact entry ${expected}`
        : `Bun package store has ambiguous exact entries for ${expected}`
    );
  return matches[0]!;
}
