import { describe, expect, it } from 'vitest';

import { parsePrototypeGraph } from './prototype-graph';
import {
  evaluateReactScenarioRenderability,
  evaluateReactDefaultRenderability,
  parseReactBindingCompilerEvidence,
  parseReactBindingManifest,
  ReactBindingManifestError,
  validateReactRuntimeSurface,
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
    parserIdentity: '@typescript/typescript6@6.0.2',
    compilerIdentity: 'selene-vite-react-compiler/v1',
    projectId: 'binding-project',
    sourceRevisionId: 'r1',
    sourceSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
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

describe('React binding compiler evidence', () => {
  it('requires a canonical SHA-256 output digest', () => {
    expect(() => parseReactBindingCompilerEvidence({ ...evidence(), outputSha256: '' })).toThrow(
      'React compiler evidence is invalid.'
    );
    expect(() =>
      parseReactBindingCompilerEvidence({ ...evidence(), outputSha256: 'A'.repeat(64) })
    ).toThrow('React compiler evidence is invalid.');
  });
});

const guardedGraph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'guarded-proof',
  name: 'Guarded proof',
  project: { projectId: 'binding-project', owner: 'owner' },
  revision: { id: 'r1', createdAt: '2026-07-25T00:00:00.000Z', summary: 'Initial' },
  handoff: { status: 'draft', owner: 'owner', summary: 'Initial' },
  initialNodeId: 'dashboard',
  fixtures: {},
  nodes: [
    {
      kind: 'screen',
      id: 'dashboard',
      label: 'Dashboard',
      route: '/',
      position: { x: 0, y: 0 },
      ports: [{ id: 'open-review', label: 'Review', trigger: 'click' }]
    },
    {
      kind: 'state',
      id: 'loading',
      label: 'Loading',
      parentId: 'dashboard',
      position: { x: 0, y: 120 },
      ports: []
    },
    {
      kind: 'overlay',
      id: 'review',
      label: 'Review',
      dismissible: true,
      position: { x: 240, y: 0 },
      ports: []
    }
  ],
  transitions: [
    {
      id: 'dashboard-review',
      kind: 'open-overlay',
      from: { nodeId: 'dashboard', portId: 'open-review' },
      to: { nodeId: 'review' }
    }
  ],
  scenarios: [
    {
      id: 'review-flow',
      name: 'Review flow',
      startNodeId: 'dashboard',
      initialStateId: 'loading',
      expectedPath: ['dashboard', 'review']
    }
  ]
});

const guardedManifest: ReactBindingManifest = {
  format: 'selene-react-binding-manifest/v1',
  schemaVersion: '2.0',
  projectId: 'binding-project',
  sourceRevisionId: 'r1',
  graphId: 'guarded-proof',
  graphRevision: 0,
  nodeBindings: [
    { graphNodeId: 'dashboard', sourceNodeId: 'dashboard.source' },
    { graphNodeId: 'loading', sourceNodeId: 'loading.source' },
    { graphNodeId: 'review', sourceNodeId: 'review.source' }
  ],
  actionBindings: [
    { graphNodeId: 'dashboard', portId: 'open-review', sourceNodeId: 'review.action' }
  ]
};

function guardedWorkspace(): ReactSourceWorkspace {
  return {
    ...workspace(),
    nodes: [
      { nodeId: 'dashboard.source', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'loading.source', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'review.source', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'review.action', path: 'src/App.tsx', exportName: 'default' }
    ]
  };
}

function guardedEvidence(
  overrides: Partial<ReactBindingCompilerEvidence> = {}
): ReactBindingCompilerEvidence {
  return {
    ...evidence(),
    nodeMarkers: [
      {
        sourceNodeId: 'dashboard.source',
        path: 'src/App.tsx',
        exportName: 'default',
        guards: [{ surface: 'node', operator: 'equals', value: 'dashboard' }]
      },
      {
        sourceNodeId: 'loading.source',
        path: 'src/App.tsx',
        exportName: 'default',
        guards: [{ surface: 'state', operator: 'equals', value: 'loading' }]
      },
      {
        sourceNodeId: 'review.source',
        path: 'src/App.tsx',
        exportName: 'default',
        guards: [{ surface: 'overlay', operator: 'equals', value: 'review' }]
      }
    ],
    actionMarkers: [
      {
        graphNodeId: 'dashboard',
        portId: 'open-review',
        sourceNodeId: 'review.action',
        path: 'src/App.tsx',
        exportName: 'default',
        guards: [
          { surface: 'node', operator: 'equals', value: 'dashboard' },
          { surface: 'state', operator: 'equals', value: 'loading' },
          { surface: 'overlay', operator: 'not-equals', value: 'review' }
        ]
      }
    ],
    ...overrides
  };
}

function guardedContext(overrides: Partial<ReactBindingCompilerEvidence> = {}) {
  return {
    graph: guardedGraph,
    graphRevision: 0,
    workspace: guardedWorkspace(),
    compilerEvidence: guardedEvidence(overrides)
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

  it('replays node, state, overlay, and action guards across a scenario expected path', () => {
    expect(
      evaluateReactScenarioRenderability(guardedManifest, guardedContext(), 'review-flow')
    ).toEqual({ status: 'renderable', scenarioId: 'review-flow' });
  });

  it('rejects wrong node and state guards before a scenario can advance', () => {
    expect(
      evaluateReactDefaultRenderability(
        guardedManifest,
        guardedContext({
          nodeMarkers: [
            {
              sourceNodeId: 'dashboard.source',
              path: 'src/App.tsx',
              exportName: 'default',
              guards: [{ surface: 'node', operator: 'equals', value: 'other' }]
            },
            ...guardedEvidence().nodeMarkers.slice(1)
          ]
        })
      )
    ).toMatchObject({ status: 'unrenderable', reason: 'runtime-guard-mismatch' });
    expect(
      evaluateReactScenarioRenderability(
        guardedManifest,
        guardedContext({
          nodeMarkers: [
            guardedEvidence().nodeMarkers[0]!,
            {
              sourceNodeId: 'loading.source',
              path: 'src/App.tsx',
              exportName: 'default',
              guards: [{ surface: 'state', operator: 'equals', value: 'idle' }]
            },
            guardedEvidence().nodeMarkers[2]!
          ]
        }),
        'review-flow'
      )
    ).toMatchObject({ status: 'unrenderable', reason: 'runtime-guard-mismatch' });
  });

  it('rejects wrong action and post-dispatch overlay guards along the expected path', () => {
    expect(
      evaluateReactScenarioRenderability(
        guardedManifest,
        guardedContext({
          actionMarkers: [
            {
              ...guardedEvidence().actionMarkers[0]!,
              guards: [{ surface: 'state', operator: 'equals', value: 'idle' }]
            }
          ]
        }),
        'review-flow'
      )
    ).toMatchObject({ status: 'unrenderable', reason: 'runtime-guard-mismatch' });
    expect(
      evaluateReactScenarioRenderability(
        guardedManifest,
        guardedContext({
          nodeMarkers: [
            guardedEvidence().nodeMarkers[0]!,
            guardedEvidence().nodeMarkers[1]!,
            {
              sourceNodeId: 'review.source',
              path: 'src/App.tsx',
              exportName: 'default',
              guards: [{ surface: 'overlay', operator: 'equals', value: 'other' }]
            }
          ]
        }),
        'review-flow'
      )
    ).toMatchObject({ status: 'unrenderable', reason: 'runtime-guard-mismatch' });
  });

  it('enforces action guards for a host-supplied active runtime snapshot', () => {
    expect(() =>
      validateReactRuntimeSurface(
        guardedManifest,
        guardedContext(),
        { activeNodeId: 'dashboard', activeStateId: 'loading', activeOverlayId: undefined },
        { nodeId: 'dashboard', portId: 'open-review' }
      )
    ).not.toThrow();
    expect(() =>
      validateReactRuntimeSurface(
        guardedManifest,
        guardedContext(),
        { activeNodeId: 'dashboard', activeStateId: 'idle', activeOverlayId: undefined },
        { nodeId: 'dashboard', portId: 'open-review' }
      )
    ).toThrow(ReactBindingManifestError);
  });

  it('accepts the schema maximum action binding count before inert parsing', () => {
    expect(
      parseReactBindingManifest({
        ...manifest,
        actionBindings: Array.from({ length: 16_000 }, (_value, index) => ({
          graphNodeId: 'screen',
          portId: `port-${index}`,
          sourceNodeId: 'screen.action'
        }))
      })
    ).toMatchObject({ actionBindings: { length: 16_000 } });
  });
});
