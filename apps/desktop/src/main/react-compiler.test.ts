import { describe, expect, it } from 'vitest';

import { ViteReactCompilerPort } from './react-compiler';

describe('ViteReactCompilerPort', () => {
  it('bundles multi-file TSX, TypeScript, CSS, and the React runtime in memory', async () => {
    const result = await new ViteReactCompilerPort().compile({
      format: 'selene-react-workspace/v1',
      projectId: 'demo',
      entrypoint: 'src/App.tsx',
      files: [
        {
          path: 'src/App.tsx',
          language: 'tsx',
          content:
            "import './preview.css'; import { greeting } from './content'; export default function App() { return <main data-selene-node-id=\"app.root\">{greeting}</main>; }"
        },
        {
          path: 'src/content.ts',
          language: 'ts',
          content: "export const greeting = 'Hello bundled preview';"
        },
        { path: 'src/preview.css', language: 'css', content: 'main { color: rebeccapurple; }' }
      ],
      dependencies: [],
      nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
      revision: { id: 'r1', createdAt: '2026-07-23T00:00:00Z', summary: 'Initial' }
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('Hello bundled preview');
    expect(result.code).toContain('createRoot');
    expect(result.css).toContain('rebeccapurple');
    expect(result.sourceMap).toContain('App.tsx');
  });

  it('resolves both production and development automatic JSX runtimes', async () => {
    const compiler = new ViteReactCompilerPort();
    const workspace = {
      format: 'selene-react-workspace/v1' as const,
      projectId: 'jsx-runtime',
      entrypoint: 'src/App.tsx',
      files: [
        {
          path: 'src/App.tsx',
          language: 'tsx' as const,
          content:
            'export default function App() { return <main data-selene-node-id="app.root">Runtime</main>; }'
        }
      ],
      dependencies: [],
      nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
      revision: {
        id: 'r1',
        createdAt: '2026-07-23T00:00:00Z',
        summary: 'Automatic JSX runtime'
      }
    };

    await expect(compiler.compile(workspace)).resolves.toMatchObject({ diagnostics: [] });
  });

  it('rejects dynamic and absolute imports before Vite can resolve host files', async () => {
    const result = await new ViteReactCompilerPort().compile({
      format: 'selene-react-workspace/v1',
      projectId: 'untrusted-import',
      entrypoint: 'src/App.tsx',
      files: [
        {
          path: 'src/App.tsx',
          language: 'tsx',
          content:
            'void import(\'file:///private/not-a-workspace-file\'); export default function App() { return <main data-selene-node-id="app.root">Blocked</main>; }'
        }
      ],
      dependencies: [],
      nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
      revision: { id: 'r1', createdAt: '2026-07-24T00:00:00Z', summary: 'Untrusted import' }
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      'Generated previews may only import workspace-relative files or the React runtime'
    );
  });
});
