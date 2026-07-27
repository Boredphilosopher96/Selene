import { describe, expect, it } from 'vitest';

import { parsePrototypeGraph } from './prototype-graph';
import {
  evaluateReactDefaultRenderability,
  ReactBindingManifestError,
  validateReactBindingManifest,
  type ReactBindingCompilerEvidence,
  type ReactBindingManifest,
  type ReactSourceWorkspace
} from './index';

const graph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'binding-proof',
  name: 'Binding proof',
  project: { projectId: 'binding-project', owner: 'owner' },
  revision: { id: 'r1', createdAt: '2026-07-25T00:00:00.000Z', summary: 'Initial' },
  handoff: { status: 'draft', owner: 'owner', summary: 'Initial' },
  initialNodeId: 'screen',
  fixtures: {},
  nodes: [
    {
      kind: 'screen',
      id: 'screen',
      label: 'Screen',
      route: '/',
      position: { x: 0, y: 0 },
      ports: [{ id: 'open', label: 'Open', trigger: 'click' }]
    }
  ],
  transitions: [{ id: 'open', kind: 'reset-flow', from: { nodeId: 'screen', portId: 'open' } }],
  scenarios: [{ id: 'default', name: 'Default', startNodeId: 'screen', expectedPath: ['screen'] }]
});

const manifest: ReactBindingManifest = {
  format: 'selene-react-binding-manifest/v1',
  schemaVersion: '2.0',
  projectId: 'binding-project',
  sourceRevisionId: 'r1',
  graphId: 'binding-proof',
  graphRevision: 0,
  nodeBindings: [{ graphNodeId: 'screen', sourceNodeId: 'screen.source' }],
  actionBindings: [{ graphNodeId: 'screen', portId: 'open', sourceNodeId: 'screen.action' }]
};

function workspace(): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId: 'binding-project',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: 'export default function App(){ return <main /> }'
      }
    ],
    dependencies: [],
    nodes: [
      { nodeId: 'screen.source', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'screen.action', path: 'src/App.tsx', exportName: 'default' }
    ],
    revision: { id: 'r1', createdAt: '2026-07-25T00:00:00.000Z', summary: 'Initial' }
  };
}

function evidence(
  overrides: Partial<ReactBindingCompilerEvidence> = {}
): ReactBindingCompilerEvidence {
  return {
    format: 'selene-react-binding-evidence/v1',
    parserIdentity: '@babel/parser@8.0.4',
    compilerIdentity: 'selene-vite-react-compiler/v1',
    projectId: 'binding-project',
    sourceRevisionId: 'r1',
    sourceSha256: 'a'.repeat(64),
    entrypoint: 'src/App.tsx',
    reachableFiles: ['src/App.tsx'],
    nodeMarkers: [
      { sourceNodeId: 'screen.source', path: 'src/App.tsx', exportName: 'default', guards: [] },
      { sourceNodeId: 'screen.action', path: 'src/App.tsx', exportName: 'default', guards: [] }
    ],
    actionMarkers: [
      {
        graphNodeId: 'screen',
        portId: 'open',
        sourceNodeId: 'screen.action',
        path: 'src/App.tsx',
        exportName: 'default',
        guards: []
      }
    ],
    ...overrides
  };
}

describe('React binding compiler receipt', () => {
  it('keeps missing bindings as an explicit renderer result, never message classification', () => {
    expect(
      evaluateReactDefaultRenderability(undefined, {
        graph,
        graphRevision: 0,
        workspace: workspace(),
        compilerEvidence: evidence()
      })
    ).toMatchObject({ status: 'unrenderable', reason: 'binding-missing' });
  });

  it('requires exact compiler-issued marker tuples rather than parsing source in core', () => {
    expect(
      validateReactBindingManifest(manifest, {
        graph,
        graphRevision: 0,
        workspace: workspace(),
        compilerEvidence: evidence()
      })
    ).toEqual(manifest);
    expect(() =>
      validateReactBindingManifest(manifest, {
        graph,
        graphRevision: 0,
        workspace: workspace(),
        compilerEvidence: evidence({ nodeMarkers: [] })
      })
    ).toThrow(ReactBindingManifestError);
  });

  it('rejects duplicate, hostile, and stale compiler evidence before use', () => {
    const duplicate = evidence({
      actionMarkers: [
        {
          graphNodeId: 'screen',
          portId: 'open',
          sourceNodeId: 'screen.action',
          path: 'src/App.tsx',
          exportName: 'default',
          guards: []
        },
        {
          graphNodeId: 'screen',
          portId: 'open',
          sourceNodeId: 'screen.action',
          path: 'src/App.tsx',
          exportName: 'default',
          guards: []
        }
      ]
    });
    expect(() =>
      validateReactBindingManifest(manifest, {
        graph,
        graphRevision: 0,
        workspace: workspace(),
        compilerEvidence: duplicate
      })
    ).toThrow(ReactBindingManifestError);
    const accessor = Object.defineProperty({}, 'format', {
      enumerable: true,
      get: () => 'selene-react-binding-evidence/v1'
    });
    expect(() =>
      validateReactBindingManifest(manifest, {
        graph,
        graphRevision: 0,
        workspace: workspace(),
        compilerEvidence: accessor as ReactBindingCompilerEvidence
      })
    ).toThrow(ReactBindingManifestError);
  });
});
