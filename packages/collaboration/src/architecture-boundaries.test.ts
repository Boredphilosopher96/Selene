import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packagesRoot = new URL('../../', import.meta.url).pathname;
const forbiddenSpecifier =
  /^(?:node:|electron(?:\/|$)|bun:|pg(?:\/|$)|postgres(?:\/|$)|https?$|ws$|express$|hono$|@selene\/collaboration\/(?:postgres|service)$)/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ['dist', 'node_modules'].includes(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && /(?<!\.test)\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

const domainSources = sourceFiles(packagesRoot).map((path) => ({
  path,
  source: readFileSync(path, 'utf8')
}));

function importedSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(/^\s*import(?:\s+type)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm),
    ([, specifier]) => specifier
  );
}

describe('collaboration public API boundaries', () => {
  it('keeps every domain package independent of Electron, Node, database, transport, and concrete-provider imports', () => {
    const violations = domainSources
      .filter(({ source }) =>
        importedSpecifiers(source).some((specifier) => forbiddenSpecifier.test(specifier))
      )
      .map(({ path }) => path.replace(packagesRoot, 'packages/'));
    expect(violations).toEqual([]);
  });
});
