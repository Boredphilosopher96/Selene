import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packagesRoot = new URL('../../', import.meta.url).pathname;
const appsRoot = new URL('../../../apps/', import.meta.url).pathname;
const forbiddenSpecifier =
  /^(?:node:|electron(?:\/|$)|bun:|pg(?:\/|$)|postgres(?:\/|$)|https?$|ws$|express$|hono$|@selene\/collaboration\/(?:postgres|service)$)/;
const samlServerRuntime = join(packagesRoot, 'identity-runtime/src/saml.ts');
const identityRuntimeRoot = join(packagesRoot, 'identity-runtime/src/index.ts');
const allowedSamlServerNodeImports = new Set(['node:async_hooks', 'node:crypto']);
const trustedSamlConsumerRoots = [join(appsRoot, 'collaboration-service/src/')];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ['dist', 'node_modules'].includes(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && /(?<!\.test)\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

type SourceFile = { readonly path: string; readonly source: string };

const domainSources: readonly SourceFile[] = sourceFiles(packagesRoot).map((path) => ({
  path,
  source: readFileSync(path, 'utf8')
}));
const packageAndAppSources: readonly SourceFile[] = [
  ...domainSources,
  ...sourceFiles(appsRoot).map((path) => ({ path, source: readFileSync(path, 'utf8') }))
];

function moduleSpecifiers(source: string): string[] {
  const collected = moduleTokens(source);
  const specifiers: string[] = [];
  for (let index = 0; index < collected.length; index += 1) {
    const token = collected[index];
    const next = collected[index + 1];
    if (token.kind === 'word' && token.value === 'import' && next?.kind === 'string') {
      specifiers.push(next.value);
      continue;
    }
    if (
      token.kind === 'word' &&
      token.value === 'import' &&
      next?.value === '(' &&
      collected[index + 2]?.kind === 'string' &&
      collected[index + 3]?.value === ')'
    ) {
      specifiers.push(collected[index + 2].value);
      continue;
    }
    if (token.kind !== 'word' || (token.value !== 'import' && token.value !== 'export')) continue;
    for (let cursor = index + 1; cursor < collected.length; cursor += 1) {
      if (collected[cursor].value === ';') break;
      if (
        collected[cursor].kind === 'word' &&
        collected[cursor].value === 'from' &&
        collected[cursor + 1]?.kind === 'string'
      ) {
        specifiers.push(collected[cursor + 1].value);
        break;
      }
    }
  }
  return specifiers;
}

type ModuleToken = { readonly kind: 'word' | 'string' | 'punct'; readonly value: string };

/** Deterministically tokenizes TypeScript module syntax while ignoring comments and text literals. */
function moduleTokens(source: string): readonly ModuleToken[] {
  const tokens: ModuleToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        value += source[index];
        index += 1;
      }
      if (source[index] === quote) index += 1;
      tokens.push({ kind: 'string', value });
    } else if (character === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        index += 1;
      }
      index += 1;
    } else if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: 'word', value: source.slice(start, index) });
    } else {
      tokens.push({ kind: 'punct', value: character });
      index += 1;
    }
  }
  return tokens;
}

function relativePath(path: string): string {
  return path.replace(packagesRoot, 'packages/').replace(appsRoot, 'apps/');
}

function domainBoundaryViolations(sources: readonly SourceFile[]): string[] {
  return sources
    .filter(({ path, source }) => {
      const specifiers = moduleSpecifiers(source);
      if (path === samlServerRuntime) {
        return specifiers.some(
          (specifier) =>
            forbiddenSpecifier.test(specifier) &&
            !(specifier.startsWith('node:') && allowedSamlServerNodeImports.has(specifier))
        );
      }
      return specifiers.some((specifier) => forbiddenSpecifier.test(specifier));
    })
    .map(({ path }) => relativePath(path));
}

function isTrustedSamlConsumer(path: string): boolean {
  return trustedSamlConsumerRoots.some((root) => path.startsWith(root));
}

function isSamlRuntimeSpecifier(specifier: string): boolean {
  return (
    /^@selene\/identity-runtime\/saml(?:\/|$)/.test(specifier) ||
    /(?:^|\/)identity-runtime\/src\/saml(?:\.js)?(?:\/|$)/.test(specifier) ||
    /^\.\/saml(?:\.js)?(?:\/|$)/.test(specifier)
  );
}

function samlConsumerViolations(sources: readonly SourceFile[]): string[] {
  return sources
    .filter(({ path, source }) => {
      if (path === samlServerRuntime || isTrustedSamlConsumer(path)) return false;
      return moduleSpecifiers(source).some((specifier) => {
        if (!isSamlRuntimeSpecifier(specifier)) return false;
        return path !== identityRuntimeRoot || specifier.startsWith('./saml');
      });
    })
    .map(({ path }) => relativePath(path));
}

describe('collaboration public API boundaries', () => {
  it('classifies only the reviewed SAML entrypoint as a minimal Node server runtime', () => {
    expect(domainBoundaryViolations(domainSources)).toEqual([]);
  });

  it('allows only the explicit hosted server root to consume the server-only SAML subpath', () => {
    expect(samlConsumerViolations(packageAndAppSources)).toEqual([]);
  });

  it('rejects unauthorized Node imports, including electron and database imports in SAML', () => {
    expect(
      domainBoundaryViolations([
        {
          path: join(packagesRoot, 'core/src/unsafe.ts'),
          source: "import { readFileSync } from 'node:fs';"
        }
      ])
    ).toEqual(['packages/core/src/unsafe.ts']);
    expect(
      domainBoundaryViolations([
        { path: samlServerRuntime, source: "import { app } from 'electron';" },
        { path: samlServerRuntime, source: "import { Client } from 'pg';" }
      ])
    ).toEqual(['packages/identity-runtime/src/saml.ts', 'packages/identity-runtime/src/saml.ts']);
    expect(
      domainBoundaryViolations([
        { path: samlServerRuntime, source: "import { AsyncLocalStorage } from 'node:async_hooks';" }
      ])
    ).toEqual([]);
  });

  it('rejects untrusted SAML consumers and relative or prefix bypass fixtures', () => {
    expect(
      samlConsumerViolations([
        {
          path: join(appsRoot, 'collaboration-service/src/saml-auth.ts'),
          source: "import { SamlServerVerifier } from '@selene/identity-runtime/saml';"
        }
      ])
    ).toEqual([]);
    expect(
      samlConsumerViolations([
        {
          path: join(packagesRoot, 'ui/src/unsafe.ts'),
          source: "import { SamlServerVerifier } from '@selene/identity-runtime/saml';"
        },
        {
          path: join(packagesRoot, 'core/src/unsafe.ts'),
          source: "import { SamlServerVerifier } from '@selene/identity-runtime/saml/private';"
        },
        {
          path: join(appsRoot, 'web/src/unsafe.ts'),
          source: "import { SamlServerVerifier } from '../../packages/identity-runtime/src/saml';"
        },
        {
          path: join(appsRoot, 'desktop/src/renderer/unsafe.ts'),
          source: "import { SamlServerVerifier } from '@selene/identity-runtime/saml';"
        },
        {
          path: join(appsRoot, 'desktop/src/preload/unsafe.ts'),
          source: "import { SamlServerVerifier } from '../identity-runtime/src/saml.js';"
        },
        {
          path: join(packagesRoot, 'project-schema/src/unsafe.ts'),
          source: "import { SamlServerVerifier } from '@selene/identity-runtime/saml';"
        },
        {
          path: identityRuntimeRoot,
          source: "export * from './saml.js';"
        },
        {
          path: join(packagesRoot, 'ui/src/dynamic.ts'),
          source: "void import('@selene/identity-runtime/saml');"
        }
      ])
    ).toEqual([
      'packages/ui/src/unsafe.ts',
      'packages/core/src/unsafe.ts',
      'apps/web/src/unsafe.ts',
      'apps/desktop/src/renderer/unsafe.ts',
      'apps/desktop/src/preload/unsafe.ts',
      'packages/project-schema/src/unsafe.ts',
      'packages/identity-runtime/src/index.ts',
      'packages/ui/src/dynamic.ts'
    ]);
  });
});
