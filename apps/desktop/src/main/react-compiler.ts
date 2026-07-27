import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import { build, type Plugin } from 'vite';

import {
  type ReactBuildArtifact,
  type ReactBuildReceipt,
  type ReactCompilerPort,
  type ReactSourceWorkspace,
  serializeCanonicalData,
  validateReactSourceWorkspace
} from '@selene/core';

const entryId = 'selene-preview-entry';
const sourcePrefix = 'selene-preview-source:';
const requireFromCompiler = createRequire(import.meta.url);
const reactRuntimeModules = new Set([
  'react',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client'
]);

interface ViteOutput {
  readonly output: readonly {
    readonly type: 'asset' | 'chunk';
    readonly fileName: string;
    readonly source?: string | Uint8Array;
    readonly code?: string;
  }[];
}

interface CompilerRuntimePathAccess {
  readonly resolveModule: (moduleId: string) => string;
  readonly resourcesPath?: string;
  readonly isRegularFile: (path: string) => boolean;
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

/**
 * Vite/Rolldown use native filesystem access for resolved dependencies. Electron's
 * Node loader can read an ASAR path, but native resolvers cannot treat that archive
 * as a directory. Only the fixed React compiler allowlist may cross to the matching
 * packaged physical copy, which electron-builder verifies under app.asar.unpacked.
 */
export function resolveCompilerRuntimePath(
  moduleId: string,
  access: CompilerRuntimePathAccess = {
    resolveModule: (id) => requireFromCompiler.resolve(id),
    resourcesPath: process.resourcesPath,
    isRegularFile
  }
): string {
  if (!reactRuntimeModules.has(moduleId))
    throw new Error('Preview compiler requested an unapproved runtime module.');
  const resolved = access.resolveModule(moduleId);
  if (!access.resourcesPath) return resolved;
  const archiveRoot = resolve(access.resourcesPath, 'app.asar');
  if (!isContainedPath(archiveRoot, resolved)) return resolved;
  const relativeRuntimePath = relative(archiveRoot, resolved);
  if (!relativeRuntimePath.startsWith(`node_modules${sep}`))
    throw new Error('Packaged preview compiler runtime is outside the approved dependency root.');
  const unpackedRoot = resolve(access.resourcesPath, 'app.asar.unpacked');
  const unpacked = resolve(unpackedRoot, relativeRuntimePath);
  if (!isContainedPath(unpackedRoot, unpacked) || !access.isRegularFile(unpacked))
    throw new Error('Packaged preview compiler runtime is unavailable.');
  return unpacked;
}

const terminalEscape = String.fromCharCode(0x1b);
const terminalBell = String.fromCharCode(0x07);
const terminalCsi = String.fromCharCode(0x9b);
const ansiSequence = new RegExp(
  `${terminalEscape}(?:\\][^${terminalBell}${terminalEscape}]*(?:${terminalBell}|${terminalEscape}\\\\)|[@-_][0-?]*[ -/]*[@-~])|${terminalCsi}[0-?]*[ -/]*[@-~]`,
  'g'
);

function stripRemainingControls(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 ||
        (code >= 11 && code <= 26) ||
        (code >= 28 && code <= 31) ||
        (code >= 127 && code <= 159)
        ? ' '
        : character;
    })
    .join('');
}

/** User-visible compiler diagnostics are bounded plain text, never terminal output. */
export function sanitizeCompilerDiagnostic(error: unknown): string {
  const message =
    error instanceof Error && typeof error.message === 'string'
      ? error.message.slice(0, 8_000)
      : '';
  const sanitized = stripRemainingControls(message.replace(ansiSequence, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4_000);
  return sanitized || 'Compilation failed.';
}

function sourceId(path: string): string {
  return `${sourcePrefix}${path}`;
}

function sourcePath(id: string): string | undefined {
  return id.startsWith(sourcePrefix) ? id.slice(sourcePrefix.length) : undefined;
}

function sourceText(source: string | Uint8Array | undefined): string {
  if (typeof source === 'string') return source;
  return source === undefined ? '' : new TextDecoder().decode(source);
}

function virtualWorkspacePlugin(
  workspace: ReactSourceWorkspace,
  reachableFiles: Set<string>
): Plugin {
  const files = new Map(workspace.files.map((file) => [file.path, file.content]));
  return {
    name: 'selene-virtual-react-workspace',
    resolveId(id, importer) {
      if (id === entryId) return entryId;
      if (id.startsWith(sourcePrefix)) return id;
      if (reactRuntimeModules.has(id)) {
        return resolveCompilerRuntimePath(id);
      }
      if (importer === undefined) return undefined;
      const from = sourcePath(importer);
      if (from === undefined) return undefined;
      if (!id.startsWith('.')) {
        throw new Error(
          `Generated previews may only import workspace-relative files or the React runtime: ${id}`
        );
      }
      const raw = posix.normalize(posix.join(posix.dirname(from), id)).replace(/^\.\//, '');
      const candidates = /\.[A-Za-z0-9]+$/.test(raw)
        ? [raw]
        : [
            `${raw}.tsx`,
            `${raw}.ts`,
            `${raw}.css`,
            `${raw}.json`,
            `${raw}/index.tsx`,
            `${raw}/index.ts`
          ];
      const resolved = candidates.find((candidate) => files.has(candidate));
      if (resolved === undefined) {
        throw new Error(`Generated preview import is not a workspace file: ${id}`);
      }
      return sourceId(resolved);
    },
    load(id) {
      if (id === entryId) {
        return [
          `import React from 'react';`,
          `import { createRoot } from 'react-dom/client';`,
          `import App from ${JSON.stringify(sourceId(workspace.entrypoint))};`,
          `const root = document.getElementById('root');`,
          `if (!root) throw new Error('Selene preview root is missing');`,
          `createRoot(root).render(React.createElement(App));`
        ].join('\n');
      }
      const path = sourcePath(id);
      if (path === undefined) return undefined;
      reachableFiles.add(path);
      return files.get(path);
    }
  };
}

/** A real in-memory Vite bundle; source is never written or evaluated in Electron main. */
export class ViteReactCompilerPort implements ReactCompilerPort {
  public async compile(
    workspace: ReactSourceWorkspace,
    signal?: AbortSignal
  ): Promise<ReactBuildArtifact> {
    validateReactSourceWorkspace(workspace);
    if (signal?.aborted) throw new DOMException('Build cancelled', 'AbortError');
    try {
      const reachableFiles = new Set<string>();
      const output = (await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [virtualWorkspacePlugin(workspace, reachableFiles)],
        build: {
          write: false,
          sourcemap: true,
          minify: false,
          cssCodeSplit: false,
          rollupOptions: {
            input: entryId,
            output: { format: 'es', entryFileNames: 'preview.js', assetFileNames: 'preview.[ext]' }
          }
        }
      })) as ViteOutput;
      if (signal?.aborted) throw new DOMException('Build cancelled', 'AbortError');
      const chunk = output.output.find((item) => item.type === 'chunk');
      if (chunk?.code === undefined) throw new Error('Vite did not produce a preview chunk');
      const css = output.output
        .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
        .map((item) => sourceText(item.source))
        .join('\n');
      const map = output.output.find(
        (item) => item.type === 'asset' && item.fileName.endsWith('.map')
      );
      // `load` is called only for modules Vite actually resolves into this build.
      reachableFiles.add(workspace.entrypoint);
      const receipt: ReactBuildReceipt = {
        format: 'selene-react-build-receipt/v1',
        compilerIdentity: 'selene-vite-react-compiler/v1',
        projectId: workspace.projectId,
        sourceRevisionId: workspace.revision.id,
        sourceSha256: createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex'),
        outputSha256: createHash('sha256')
          .update(
            serializeCanonicalData({
              code: chunk.code,
              css,
              sourceMap: map === undefined ? '' : sourceText(map.source)
            })
          )
          .digest('hex'),
        reachableFiles: [...reachableFiles].sort()
      };
      return {
        revisionId: workspace.revision.id,
        code: chunk.code,
        ...(css.length === 0 ? {} : { css }),
        ...(map === undefined ? {} : { sourceMap: sourceText(map.source) }),
        receipt,
        diagnostics: []
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        revisionId: workspace.revision.id,
        code: '',
        diagnostics: [
          {
            code: 'MISSING_SOURCE',
            message: sanitizeCompilerDiagnostic(error),
            path: workspace.entrypoint
          }
        ]
      };
    }
  }
}
