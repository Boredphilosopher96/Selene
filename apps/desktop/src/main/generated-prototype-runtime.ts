/** Standalone generated code. It has no desktop capabilities or private package imports. */
export const generatedPrototypeRuntimeSource = String.raw`
export interface PrototypePort {
  readonly id: string;
  readonly label: string;
  readonly trigger: 'click' | 'submit' | 'change' | 'key' | 'timeout';
  readonly timeoutMs?: number;
}
export interface PrototypeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'screen' | 'page' | 'state' | 'overlay';
  readonly route?: string;
  readonly ports: readonly PrototypePort[];
}
export type PrototypeTransition = {
  readonly id: string;
  readonly from: { readonly nodeId: string; readonly portId: string };
} & (
  | { readonly kind: 'navigate' | 'set-state' | 'open-overlay' | 'close-overlay'; readonly to: { readonly nodeId: string } }
  | { readonly kind: 'back' | 'reset-flow' }
);
export interface PrototypeGraph {
  readonly initialNodeId: string;
  readonly nodes: readonly PrototypeNode[];
  readonly transitions: readonly PrototypeTransition[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly name: string;
    readonly startNodeId: string;
    readonly initialStateId?: string;
  }[];
  readonly fixtures: Readonly<Record<string, unknown>>;
}
export interface PrototypeSnapshot {
  readonly activeNodeId: string;
  readonly activeStateId?: string | undefined;
  readonly activeOverlayId?: string | undefined;
  readonly scenarioId?: string | undefined;
  readonly history: readonly string[];
  readonly historyPathLengths: readonly number[];
  readonly activePathTransitionIds: readonly string[];
  readonly fixtures: Readonly<Record<string, unknown>>;
}
export function startPrototype(graph: PrototypeGraph, scenarioId?: string): PrototypeSnapshot {
  const scenario = graph.scenarios.find(item => item.id === scenarioId);
  if (scenarioId !== undefined && scenario === undefined) throw new Error('Unknown prototype scenario');
  const activeNodeId = scenario?.startNodeId ?? graph.initialNodeId;
  return {
    activeNodeId,
    ...(scenario?.initialStateId === undefined ? {} : { activeStateId: scenario.initialStateId }),
    ...(scenario === undefined ? {} : { scenarioId: scenario.id }),
    history: [activeNodeId], historyPathLengths: [0], activePathTransitionIds: [],
    fixtures: structuredClone(graph.fixtures)
  };
}
export function prototypeBack(snapshot: PrototypeSnapshot): PrototypeSnapshot {
  if (snapshot.history.length <= 1) return structuredClone(snapshot);
  const history = snapshot.history.slice(0, -1);
  const activeNodeId = history.at(-1);
  if (activeNodeId === undefined) throw new Error('Prototype history is missing');
  return {
    ...snapshot, activeNodeId, activeStateId: undefined, activeOverlayId: undefined, history,
    historyPathLengths: snapshot.historyPathLengths.slice(0, -1),
    activePathTransitionIds: snapshot.activePathTransitionIds.slice(0, snapshot.historyPathLengths.at(-2) ?? 0)
  };
}
export function triggerPrototype(graph: PrototypeGraph, snapshot: PrototypeSnapshot, nodeId: string, portId: string): PrototypeSnapshot {
  if (![snapshot.activeNodeId, snapshot.activeStateId, snapshot.activeOverlayId].includes(nodeId))
    throw new Error('Action source is not active in this prototype snapshot');
  const transition = graph.transitions.find(item => item.from.nodeId === nodeId && item.from.portId === portId);
  if (transition === undefined) throw new Error('No transition is wired to that action port');
  const activePathTransitionIds = [...snapshot.activePathTransitionIds, transition.id];
  switch (transition.kind) {
    case 'navigate':
      return { ...snapshot, activeNodeId: transition.to.nodeId, activeStateId: undefined, activeOverlayId: undefined,
        history: [...snapshot.history, transition.to.nodeId], historyPathLengths: [...snapshot.historyPathLengths, activePathTransitionIds.length], activePathTransitionIds };
    case 'back': return prototypeBack(snapshot);
    case 'set-state': return { ...snapshot, activeStateId: transition.to.nodeId, activePathTransitionIds };
    case 'open-overlay': return { ...snapshot, activeOverlayId: transition.to.nodeId, activePathTransitionIds };
    case 'close-overlay':
      if (snapshot.activeOverlayId !== transition.to.nodeId) throw new Error('Overlay is not active');
      return { ...snapshot, activeOverlayId: undefined, activePathTransitionIds };
    case 'reset-flow':
      return { ...startPrototype(graph, snapshot.scenarioId), historyPathLengths: [activePathTransitionIds.length], activePathTransitionIds };
  }
}
`;
