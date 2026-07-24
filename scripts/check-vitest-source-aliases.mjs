/* oxlint-disable no-await-in-loop */
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const vitestConfig = await readFile(join(root, 'vitest.config.ts'), 'utf8');
const aliases = new Set(
  [...vitestConfig.matchAll(/['"](@selene\/[^'"]+)['"]\s*:/g)].map((match) => match[1])
);

async function workspacePackages() {
  const names = new Set();
  for (const rootDirectory of [join(root, 'apps'), join(root, 'packages')]) {
    for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          await readFile(join(rootDirectory, entry.name, 'package.json'), 'utf8')
        );
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@selene/'))
          names.add(manifest.name);
      } catch {}
    }
  }
  return names;
}

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ['node_modules', 'dist', 'artifacts', 'storybook-static', '.git', '.cache'].includes(
        entry.name
      )
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (/\.(test|spec)\.(ts|tsx|mjs|mts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const packages = await workspacePackages();
const imports = new Map();
for (const file of await testFiles(root)) {
  const source = await readFile(file, 'utf8');
  const patterns = [
    /^\s*import\s+(?:type\s+)?[^;\n]*?from\s+['"](@selene\/[^'"]+)['"]/gm,
    /^\s*import\s*\(\s*['"](@selene\/[^'"]+)['"]\s*\)/gm
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.set(match[1], relative(root, file));
  }
}
function missingAliasEntries(specifiers, availableAliases, workspaceNames) {
  const missingEntries = [];
  for (const [specifier, file] of specifiers) {
    const packageName = specifier.split('/').slice(0, 2).join('/');
    if (!workspaceNames.has(packageName)) continue;
    const isExactPackageImport = specifier === packageName;
    const covered =
      availableAliases.has(specifier) ||
      (isExactPackageImport && availableAliases.has(packageName));
    if (!covered) missingEntries.push(`${specifier} (${file})`);
  }
  return missingEntries;
}
const missing = missingAliasEntries(imports, aliases, packages);
if (missing.length > 0) throw new Error(`Vitest source aliases missing: ${missing.join(', ')}`);

// Negative fixture: a package-root alias must never cover a subpath import.
const fixtureMissing = missingAliasEntries(
  new Map([['@selene/fixture/subpath', 'fixture.test.ts']]),
  new Set(['@selene/fixture']),
  new Set(['@selene/fixture'])
);
if (fixtureMissing.length !== 1 || !fixtureMissing[0].startsWith('@selene/fixture/subpath'))
  throw new Error('Vitest alias checker failed its missing-subpath negative fixture');

const disposable = await mkdtemp(join(tmpdir(), 'selene-vitest-cold-'));
try {
  await cp(root, disposable, {
    recursive: true,
    filter(source) {
      const name = source.split('/').at(-1);
      return !['node_modules', 'dist', 'artifacts', 'storybook-static', '.git', '.cache'].includes(
        name
      );
    }
  });
  const install = spawnSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: disposable,
    encoding: 'utf8'
  });
  if (install.status !== 0)
    throw new Error(`cold install failed:\n${install.stdout}\n${install.stderr}`);
  const test = spawnSync(
    'bun',
    ['run', 'test', '--', '--run', 'apps/desktop/src/main/enterprise-security-runtime.test.ts'],
    { cwd: disposable, encoding: 'utf8' }
  );
  if (test.status !== 0)
    throw new Error(`cold pre-build test failed:\n${test.stdout}\n${test.stderr}`);
  console.log('ok: cold disposable install resolves Vitest workspace sources before build');
} finally {
  await rm(disposable, { recursive: true, force: true });
}
