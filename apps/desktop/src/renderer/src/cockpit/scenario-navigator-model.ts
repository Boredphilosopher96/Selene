import type { PrototypeGraph, PrototypeRuntimeSnapshot } from '@selene/core';

export interface ScenarioNavigatorEntry {
  readonly id: string;
  readonly name: string;
  readonly startNodeId: string;
  readonly startNodeLabel: string;
  readonly startNodeKind: string;
  readonly route?: string;
  readonly initialStateLabel?: string;
  readonly expectedPath: readonly string[];
}

export interface ScenarioNavigatorNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'screen' | 'page' | 'state' | 'overlay';
  readonly route?: string;
  readonly parentLabel?: string;
}

export interface ScenarioNavigatorNodeGroup {
  readonly id: 'screens-pages' | 'states' | 'overlays';
  readonly label: string;
  readonly nodes: readonly ScenarioNavigatorNode[];
}

function nodeLabel(graph: PrototypeGraph, nodeId: string): string | undefined {
  return graph.nodes.find((node) => node.id === nodeId)?.label;
}

/** Pure, read-only graph projection. Node cards never become navigation commands. */
export function scenarioNavigatorEntries(graph: PrototypeGraph): readonly ScenarioNavigatorEntry[] {
  return graph.scenarios.map((scenario) => {
    const startNode = graph.nodes.find((node) => node.id === scenario.startNodeId);
    return {
      id: scenario.id,
      name: scenario.name,
      startNodeId: scenario.startNodeId,
      startNodeLabel: startNode?.label ?? scenario.startNodeId,
      startNodeKind: startNode?.kind ?? 'unknown',
      ...(!startNode || !('route' in startNode) || startNode.route === undefined
        ? {}
        : { route: startNode.route }),
      ...(scenario.initialStateId === undefined
        ? {}
        : {
            initialStateLabel: nodeLabel(graph, scenario.initialStateId) ?? scenario.initialStateId
          }),
      expectedPath: scenario.expectedPath.map((nodeId) => nodeLabel(graph, nodeId) ?? nodeId)
    };
  });
}

/** Inventory every declared node, including nodes that no scenario presently reaches. */
export function scenarioNavigatorNodeGroups(
  graph: PrototypeGraph
): readonly ScenarioNavigatorNodeGroup[] {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    ...(!('route' in node) || node.route === undefined ? {} : { route: node.route }),
    ...(!('parentId' in node) || node.parentId === undefined
      ? {}
      : { parentLabel: nodeLabel(graph, node.parentId) ?? node.parentId })
  }));
  return [
    {
      id: 'screens-pages',
      label: 'Screens and pages',
      nodes: nodes.filter((node) => node.kind === 'screen' || node.kind === 'page')
    },
    { id: 'states', label: 'States', nodes: nodes.filter((node) => node.kind === 'state') },
    {
      id: 'overlays',
      label: 'Overlays',
      nodes: nodes.filter((node) => node.kind === 'overlay')
    }
  ];
}

export function isScenarioNavigatorNodeMatch(node: ScenarioNavigatorNode, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    [node.id, node.label, node.kind, node.route, node.parentLabel].some(
      (value) => value?.toLocaleLowerCase().includes(normalized) === true
    )
  );
}

export function isScenarioNavigatorMatch(entry: ScenarioNavigatorEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [
    entry.id,
    entry.name,
    entry.startNodeId,
    entry.startNodeLabel,
    entry.startNodeKind,
    entry.route,
    entry.initialStateLabel,
    ...entry.expectedPath
  ].some((value) => value?.toLocaleLowerCase().includes(normalized) === true);
}

export interface RuntimeNavigatorContext {
  readonly scenario: string;
  readonly activeNode: string;
  readonly activeState?: string;
  readonly activeOverlay?: string;
  readonly path: readonly string[];
  readonly omittedPathCount: number;
}

const maximumPresentedPathNodes = 12;

export function runtimeNavigatorContext(
  graph: PrototypeGraph,
  runtime: PrototypeRuntimeSnapshot | undefined
): RuntimeNavigatorContext | undefined {
  if (runtime === undefined) return undefined;
  const fullPath = runtime.history.map((nodeId) => nodeLabel(graph, nodeId) ?? nodeId);
  return {
    scenario: runtime.scenarioId ?? 'Default graph entry',
    activeNode: nodeLabel(graph, runtime.activeNodeId) ?? runtime.activeNodeId,
    ...(runtime.activeStateId === undefined
      ? {}
      : { activeState: nodeLabel(graph, runtime.activeStateId) ?? runtime.activeStateId }),
    ...(runtime.activeOverlayId === undefined
      ? {}
      : { activeOverlay: nodeLabel(graph, runtime.activeOverlayId) ?? runtime.activeOverlayId }),
    path: fullPath.slice(-maximumPresentedPathNodes),
    omittedPathCount: Math.max(0, fullPath.length - maximumPresentedPathNodes)
  };
}
