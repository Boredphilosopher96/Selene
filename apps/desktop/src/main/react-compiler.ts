import { createRequire } from 'node:module';
import { posix } from 'node:path';

import { build, type Plugin } from 'vite';

import {
  type ReactBuildArtifact,
  type ReactCompilerPort,
  type ReactSourceWorkspace,
  validateReactSourceWorkspace
} from '@selene/core';

const entryId = 'selene-preview-entry';
const sourcePrefix = 'selene-preview-source:';
const requireFromCompiler = createRequire(import.meta.url);

interface ViteOutput {
  readonly output: readonly {
    readonly type: 'asset' | 'chunk';
    readonly fileName: string;
    readonly source?: string | Uint8Array;
    readonly code?: string;
  }[];
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

function virtualWorkspacePlugin(workspace: ReactSourceWorkspace): Plugin {
  const files = new Map(workspace.files.map((file) => [file.path, file.content]));
  return {
    name: 'selene-virtual-react-workspace',
    resolveId(id, importer) {
      if (id === entryId) return entryId;
      if (id.startsWith(sourcePrefix)) return id;
      if (id === 'react' || id === 'react-dom' || id === 'react-dom/client') {
        return requireFromCompiler.resolve(id);
      }
      if (importer === undefined || !id.startsWith('.')) return undefined;
      const from = sourcePath(importer);
      if (from === undefined) return undefined;
      const raw = posix.normalize(posix.join(posix.dirname(from), id)).replace(/^\.\//, '');
      const candidates = /\.[A-Za-z0-9]+$/.test(raw)
        ? [raw]
        : [`${raw}.tsx`, `${raw}.ts`, `${raw}.css`, `${raw}/index.tsx`, `${raw}/index.ts`];
      const resolved = candidates.find((candidate) => files.has(candidate));
      return resolved === undefined ? undefined : sourceId(resolved);
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
      return path === undefined ? undefined : files.get(path);
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
      const output = (await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [virtualWorkspacePlugin(workspace)],
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
      return {
        revisionId: workspace.revision.id,
        code: chunk.code,
        ...(css.length === 0 ? {} : { css }),
        ...(map === undefined ? {} : { sourceMap: sourceText(map.source) }),
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
            message: error instanceof Error ? error.message : 'Compilation failed',
            path: workspace.entrypoint
          }
        ]
      };
    }
  }
}
