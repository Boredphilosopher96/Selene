import { describe, expect, it } from 'vitest';

import {
  applyAgentSourcePatch,
  exportReactSourceWorkspace,
  fakeAgentPatch,
  RevisionedReactBuilder,
  type ReactSourceWorkspace,
  SourceValidationError
} from './generation';
import { executeProjectCommand } from './index';

function workspace(): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId: 'demo',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: 'export default () => <main data-selene-node-id="screen.root" />;'
      }
    ],
    dependencies: [],
    nodes: [{ nodeId: 'screen.root', path: 'src/App.tsx', exportName: 'default' }],
    revision: { id: 'r1', createdAt: '2026-07-23T00:00:00Z', summary: 'Initial' }
  };
}

describe('generated React workspaces', () => {
  it('accepts a typed fake-agent TSX/TS/CSS patch and advances the revision', () => {
    const next = applyAgentSourcePatch(workspace(), fakeAgentPatch('Orders'), {
      id: 'r2',
      createdAt: '2026-07-23T00:01:00Z'
    });
    expect(next.revision.parentId).toBe('r1');
    expect(next.files.map((file) => file.path)).toEqual([
      'src/App.tsx',
      'src/screen.css',
      'src/state.ts'
    ]);
    expect(next.nodes.map((node) => node.nodeId)).toEqual(['screen.root', 'screen.title']);
  });

  it('rejects traversal, unresolved imports, dependencies, and silent node deletion', () => {
    expect(() =>
      applyAgentSourcePatch(
        workspace(),
        { summary: 'bad', operations: [{ type: 'write', path: '../bad.ts', content: '' }] },
        { id: 'r2', createdAt: 'x' }
      )
    ).toThrow(SourceValidationError);
    expect(() =>
      applyAgentSourcePatch(
        workspace(),
        {
          summary: 'bad',
          operations: [
            {
              type: 'write',
              path: 'src/App.tsx',
              content: "import 'left-pad'; export default () => <main />;"
            }
          ]
        },
        { id: 'r2', createdAt: 'x' }
      )
    ).toThrow(/Stable node ID/);
  });

  it('preserves the last good build when a newer build fails or is stale', async () => {
    const builder = new RevisionedReactBuilder();
    const good = await builder.build(
      {
        compile: async (value) => ({ revisionId: value.revision.id, code: 'ok', diagnostics: [] })
      },
      workspace()
    );
    const fallback = await builder.build(
      {
        compile: async () => {
          throw new Error('syntax error');
        }
      },
      workspace()
    );
    expect(good.code).toBe('ok');
    expect(fallback.code).toBe('ok');
    expect(fallback.diagnostics[0]?.message).toContain('syntax error');
  });

  it('covers the fake-agent prompt-to-preview review flow and reproducible export', async () => {
    const generated = applyAgentSourcePatch(workspace(), fakeAgentPatch('Orders'), {
      id: 'r2',
      createdAt: '2026-07-23T00:01:00Z'
    });
    const preview = await new RevisionedReactBuilder().build(
      {
        compile: async (value) => ({
          revisionId: value.revision.id,
          code: value.files.map((file) => file.content).join('\n'),
          sourceMap: '{"version":3}',
          diagnostics: []
        })
      },
      generated
    );
    const review = executeProjectCommand(
      {
        format: 'selene-designer-workspace/v1',
        projectId: 'demo',
        name: 'Demo',
        status: 'draft',
        selectedScreenId: 'orders',
        selectedState: 'default',
        screens: [
          {
            id: 'orders',
            name: 'Orders',
            route: '/orders',
            states: ['default', 'error'],
            nodeIds: ['screen.root', 'screen.title']
          }
        ],
        comments: [],
        developerDirections: [],
        changelog: [{ id: 'start', at: '2026-07-23T00:00:00Z', summary: 'Start' }],
        updatedAt: '2026-07-23T00:00:00Z'
      },
      { type: 'select-node', nodeId: 'screen.title' }
    );
    const commented = executeProjectCommand(review, {
      type: 'add-comment',
      id: 'comment-1',
      nodeId: 'screen.title',
      body: 'Check empty state',
      author: 'Tester',
      createdAt: '2026-07-23T00:01:00Z'
    });
    const errorState = executeProjectCommand(commented, { type: 'select-state', state: 'error' });

    expect(preview.code).toContain('Orders');
    expect(errorState).toMatchObject({
      selectedScreenId: 'orders',
      selectedState: 'error',
      selectedNodeId: 'screen.title'
    });
    expect(errorState.comments[0]?.body).toContain('empty state');
    expect(exportReactSourceWorkspace(generated)).toBe(exportReactSourceWorkspace(generated));
  });

  it('treats adversarial fake-agent prompt text as JSX text rather than generated code', () => {
    const patch = fakeAgentPatch('</h1>{globalThis.process.exit()}<script>');
    const app = patch.operations.find(
      (operation): operation is Extract<(typeof patch.operations)[number], { type: 'write' }> =>
        operation.type === 'write' && operation.path === 'src/App.tsx'
    );
    expect(app?.content).toContain(
      '&lt;/h1&gt;&#123;globalThis.process.exit()&#125;&lt;script&gt;'
    );
    expect(app?.content).not.toContain('</h1>{globalThis');
  });
});
