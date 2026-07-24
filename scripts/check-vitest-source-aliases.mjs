/* oxlint-disable no-await-in-loop */
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as ts from 'typescript/unstable/ast';

const root = fileURLToPath(new URL('../', import.meta.url));
const subprocessTimeoutMs = 120_000;
const subprocessMaxBuffer = 16 * 1024 * 1024;
function runBun(args, cwd, label) {
  const result = spawnSync('bun', args, {
    cwd,
    encoding: 'utf8',
    timeout: subprocessTimeoutMs,
    maxBuffer: subprocessMaxBuffer
  });
  if (result.error) throw new Error(`${label} spawn error: ${result.error.message}`);
  if (result.signal) throw new Error(`${label} terminated by signal ${result.signal}`);
  if (result.status !== 0)
    throw new Error(
      `${label} exited with status ${result.status}:\n${result.stdout}\n${result.stderr}`
    );
  return result;
}
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

function sourceSpecifiers(source) {
  if (typeof ts.createScanner !== 'function')
    throw new Error('TypeScript structural scanner unavailable');
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan())
    if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia)
      tokens.push({
        kind,
        text:
          kind === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText()
      });
  const specifiers = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== ts.SyntaxKind.ImportKeyword && token.kind !== ts.SyntaxKind.ExportKeyword)
      continue;
    const next = tokens[index + 1];
    if (token.kind === ts.SyntaxKind.ImportKeyword && next?.kind === ts.SyntaxKind.StringLiteral) {
      specifiers.push(next.text);
      continue;
    }
    if (token.kind === ts.SyntaxKind.ImportKeyword && next?.kind === ts.SyntaxKind.OpenParenToken) {
      if (tokens[index + 2]?.kind === ts.SyntaxKind.StringLiteral)
        specifiers.push(tokens[index + 2].text);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor].kind === ts.SyntaxKind.SemicolonToken) break;
      if (
        tokens[cursor].kind === ts.SyntaxKind.FromKeyword &&
        tokens[cursor + 1]?.kind === ts.SyntaxKind.StringLiteral
      ) {
        specifiers.push(tokens[cursor + 1].text);
        break;
      }
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith('@selene/'));
}

const packages = await workspacePackages();
const imports = new Map();
for (const file of await testFiles(root)) {
  const source = await readFile(file, 'utf8');
  for (const specifier of sourceSpecifiers(source, file))
    imports.set(specifier, relative(root, file));
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

// Import-shape fixture: side-effect imports and re-exports must be scanned too.
const fixtureImports = [
  ...sourceSpecifiers("import {\n  value\n} from '@selene/fixture/multiline';", 'fixture.ts'),
  ...sourceSpecifiers("import '@selene/fixture/side-effect';", 'fixture.ts'),
  ...sourceSpecifiers("export { value } from '@selene/fixture/re-export';", 'fixture.ts'),
  ...sourceSpecifiers(
    "void import('@selene/fixture/dynamic');\nvoid import(getSpecifier());",
    'fixture.ts'
  )
];
const negativeImports = sourceSpecifiers(
  "// import '@selene/fixture/comment';\nconst text = \"import '@selene/fixture/string'\";\nconst template = `import('@selene/fixture/template')`;\nconst pattern = /import\\('@selene\\/fixture\\/regex'\\)/;\nvoid import(\n  getSpecifier()\n);",
  'fixture.ts'
);
if (
  !fixtureImports.includes('@selene/fixture/multiline') ||
  !fixtureImports.includes('@selene/fixture/side-effect') ||
  !fixtureImports.includes('@selene/fixture/re-export') ||
  !fixtureImports.includes('@selene/fixture/dynamic') ||
  fixtureImports.includes('getSpecifier') ||
  negativeImports.length !== 0
)
  throw new Error('Vitest alias checker failed its multiline/import-shape fixture');

const disposable = await mkdtemp(join(tmpdir(), 'selene-vitest-cold-'));
try {
  await cp(root, disposable, {
    recursive: true,
    filter(source) {
      const name = source.replaceAll('\\', '/').split('/').at(-1);
      return !['node_modules', 'dist', 'artifacts', 'storybook-static', '.git', '.cache'].includes(
        name
      );
    }
  });
  runBun(['install', '--frozen-lockfile', '--ignore-scripts'], disposable, 'cold install');
  runBun(['run', 'typecheck'], disposable, 'cold pre-build typecheck');
  runBun(
    ['run', 'test', '--', '--run', 'apps/desktop/src/main/enterprise-security-runtime.test.ts'],
    disposable,
    'cold pre-build test'
  );
  console.log('ok: cold disposable install resolves Vitest workspace sources before build');
} finally {
  await rm(disposable, { recursive: true, force: true });
}
