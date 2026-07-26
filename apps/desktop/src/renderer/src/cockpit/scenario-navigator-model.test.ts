import { describe, expect, it } from 'vitest';
import { parsePrototypeGraph, type PrototypeRuntimeSnapshot } from '@selene/core';

import {
  isScenarioNavigatorMatch,
  isScenarioNavigatorNodeMatch,
  runtimeNavigatorContext,
  scenarioNavigatorEntries,
  scenarioNavigatorNodeGroups
} from './scenario-navigator-model';

const graph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'navigator',
  name: 'Navigator fixture',
  project: { projectId: 'navigator-project', owner: 'Selene' },
  revision: { id: 'navigator-r1', createdAt: '2026-07-25T20:00:00.000Z', summary: 'Fixture' },
  handoff: { status: 'draft', owner: 'Selene', summary: 'Fixture' },
  initialNodeId: 'dashboard',
  nodes: [
    {
      id: 'dashboard',
      kind: 'screen',
      label: 'Dashboard',
      route: '/',
      position: { x: 0, y: 0 },
      ports: [{ id: 'open-review', label: 'Open review', trigger: 'click' }]
    },
    {
      id: 'loading',
      kind: 'state',
      label: 'Loading',
      parentId: 'dashboard',
      position: { x: 1, y: 1 },
      ports: []
    },
    {
      id: 'review',
      kind: 'overlay',
      label: 'Review details',
      dismissible: true,
      position: { x: 2, y: 2 },
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
  ],
  fixtures: {}
});

describe('scenario navigator model', () => {
  it('projects declared flow scenarios without creating direct node navigation', () => {
    const [entry] = scenarioNavigatorEntries(graph);
    expect(entry).toMatchObject({
      id: 'review-flow',
      startNodeLabel: 'Dashboard',
      startNodeKind: 'screen',
      initialStateLabel: 'Loading',
      expectedPath: ['Dashboard', 'Review details']
    });
    expect(isScenarioNavigatorMatch(entry!, 'overlay')).toBe(true);
    expect(isScenarioNavigatorMatch(entry!, 'missing')).toBe(false);
  });

  it('labels runtime scenario, active node, state, overlay, and history from the graph', () => {
    const runtime: PrototypeRuntimeSnapshot = {
      activeNodeId: 'dashboard',
      activeStateId: 'loading',
      activeOverlayId: 'review',
      scenarioId: 'review-flow',
      history: ['dashboard', 'review'],
      historyPathLengths: [0, 1],
      activePathTransitionIds: [],
      fixtures: {}
    };
    expect(runtimeNavigatorContext(graph, runtime)).toEqual({
      scenario: 'review-flow',
      activeNode: 'Dashboard',
      activeState: 'Loading',
      activeOverlay: 'Review details',
      path: ['Dashboard', 'Review details'],
      omittedPathCount: 0
    });
  });

  it('bounds only the displayed runtime trail while retaining the newest graph context', () => {
    const runtime: PrototypeRuntimeSnapshot = {
      activeNodeId: 'dashboard',
      scenarioId: 'review-flow',
      history: Array.from({ length: 13 }, () => 'dashboard'),
      historyPathLengths: Array.from({ length: 13 }, (_, index) => index),
      activePathTransitionIds: [],
      fixtures: {}
    };
    expect(runtimeNavigatorContext(graph, runtime)).toMatchObject({
      omittedPathCount: 1,
      path: Array.from({ length: 12 }, () => 'Dashboard')
    });
  });

  it('keeps every graph node in a searchable, read-only inventory even when no scenario reaches it', () => {
    const groups = scenarioNavigatorNodeGroups(graph);
    expect(groups.find((group) => group.id === 'overlays')?.nodes).toMatchObject([
      { id: 'review', label: 'Review details', kind: 'overlay' }
    ]);
    expect(isScenarioNavigatorNodeMatch(groups[2]!.nodes[0]!, 'review')).toBe(true);
    expect(isScenarioNavigatorNodeMatch(groups[2]!.nodes[0]!, 'missing')).toBe(false);
  });
});
