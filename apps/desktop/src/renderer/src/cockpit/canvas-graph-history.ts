import {
  serializeCanonicalData,
  removePrototypeTransition,
  upsertPrototypeTransition,
  type PrototypeGraph,
  type PrototypeTransition
} from '@selene/core';

export class CanvasConnectionEditError extends Error {}

export interface CanvasGraphHistory {
  readonly graph: PrototypeGraph;
  readonly revision: number;
  readonly past: readonly PrototypeGraph[];
  readonly future: readonly PrototypeGraph[];
}

export type CanvasGraphHistoryChange =
  { readonly kind: 'commit'; readonly graph: PrototypeGraph } | { readonly kind: 'undo' | 'redo' };

export interface CanvasGraphHistoryOperation {
  readonly kind: CanvasGraphHistoryChange['kind'];
  readonly before: CanvasGraphHistory;
  readonly graph: PrototypeGraph;
}

export function sameCanvasGraph(left: PrototypeGraph, right: PrototypeGraph): boolean {
  return serializeCanonicalData(left) === serializeCanonicalData(right);
}

export function createCanvasGraphHistory(
  graph: PrototypeGraph,
  revision: number
): CanvasGraphHistory {
  return { graph, revision, past: [], future: [] };
}

export function reconcileCanvasGraphHistory(
  history: CanvasGraphHistory,
  graph: PrototypeGraph,
  revision: number
): CanvasGraphHistory {
  const sameOwner =
    history.graph.project.projectId === graph.project.projectId && history.graph.id === graph.id;
  if (sameOwner && revision < history.revision) return history;
  if (sameOwner && revision === history.revision && sameCanvasGraph(history.graph, graph))
    return history;
  return createCanvasGraphHistory(graph, revision);
}

export function planCanvasGraphHistory(
  history: CanvasGraphHistory,
  change: CanvasGraphHistoryChange
): CanvasGraphHistoryOperation | undefined {
  const graph =
    change.kind === 'commit'
      ? change.graph
      : change.kind === 'undo'
        ? history.past.at(-1)
        : history.future[0];
  if (graph === undefined || sameCanvasGraph(graph, history.graph)) return undefined;
  return { kind: change.kind, before: history, graph };
}

/** Call only after persistence acknowledges this exact graph and the next revision. */
export function acknowledgeCanvasGraphHistory(
  operation: CanvasGraphHistoryOperation,
  saved: { readonly graph: PrototypeGraph; readonly revision: number }
): CanvasGraphHistory {
  const before = operation.before;
  if (saved.revision !== before.revision + 1 || !sameCanvasGraph(saved.graph, operation.graph))
    return createCanvasGraphHistory(saved.graph, saved.revision);
  switch (operation.kind) {
    case 'commit':
      return {
        ...saved,
        past: [...before.past, before.graph].slice(-64),
        future: []
      };
    case 'undo':
      return { ...saved, past: before.past.slice(0, -1), future: [before.graph, ...before.future] };
    case 'redo':
      return { ...saved, past: [...before.past, before.graph], future: before.future.slice(1) };
  }
}

export async function persistCanvasGraphHistory(
  operation: CanvasGraphHistoryOperation,
  save: (
    graph: PrototypeGraph
  ) => Promise<{ readonly graph: PrototypeGraph; readonly revision: number }>
): Promise<CanvasGraphHistory> {
  return acknowledgeCanvasGraphHistory(operation, await save(operation.graph));
}

export interface CanvasConnectionDraft {
  readonly transitionId?: string;
  readonly sourceNodeId: string;
  readonly portId: string;
  readonly kind: PrototypeTransition['kind'];
  readonly targetNodeId: string;
}

export function editCanvasGraphConnection(
  graph: PrototypeGraph,
  draft: CanvasConnectionDraft,
  newTransitionId: string
):
  | { readonly kind: 'ready'; readonly graph: PrototypeGraph }
  | { readonly kind: 'unavailable'; readonly message: string } {
  const source = graph.nodes.find((node) => node.id === draft.sourceNodeId);
  const target = graph.nodes.find((node) => node.id === draft.targetNodeId);
  if (!source?.ports.some((port) => port.id === draft.portId))
    return { kind: 'unavailable', message: 'Choose a declared source action.' };
  if (
    draft.transitionId !== undefined &&
    !graph.transitions.some((item) => item.id === draft.transitionId)
  )
    return { kind: 'unavailable', message: 'That connection is no longer in the saved graph.' };
  if (
    graph.transitions.some(
      (item) =>
        item.id !== draft.transitionId &&
        item.from.nodeId === source.id &&
        item.from.portId === draft.portId
    )
  )
    return {
      kind: 'unavailable',
      message: 'That source action already has a connection. Select it to edit it.'
    };
  const id = draft.transitionId ?? newTransitionId;
  const from = { nodeId: source.id, portId: draft.portId };
  let transition: PrototypeTransition;
  switch (draft.kind) {
    case 'back':
    case 'reset-flow':
      transition = { id, kind: draft.kind, from };
      break;
    case 'navigate':
      if (target?.kind !== 'screen' && target?.kind !== 'page')
        return { kind: 'unavailable', message: 'Navigation needs a screen or page destination.' };
      transition = { id, kind: draft.kind, from, to: { nodeId: target.id } };
      break;
    case 'set-state': {
      const owner = source.kind === 'state' ? source.parentId : source.id;
      if (target?.kind !== 'state' || target.parentId !== owner)
        return { kind: 'unavailable', message: 'Choose a state belonging to the source screen.' };
      transition = { id, kind: draft.kind, from, to: { nodeId: target.id } };
      break;
    }
    case 'open-overlay':
    case 'close-overlay':
      if (target?.kind !== 'overlay' || (draft.kind === 'close-overlay' && source.id !== target.id))
        return {
          kind: 'unavailable',
          message: 'Choose an overlay. Close must target the source overlay itself.'
        };
      transition = { id, kind: draft.kind, from, to: { nodeId: target.id } };
      break;
  }
  try {
    const existing = graph.transitions.find((item) => item.id === draft.transitionId);
    if (existing && serializeCanonicalData(existing) === serializeCanonicalData(transition))
      return { kind: 'ready', graph };
    const base = existing ? removePrototypeTransition(graph, existing.id) : graph;
    return { kind: 'ready', graph: upsertPrototypeTransition(base, transition) };
  } catch {
    return {
      kind: 'unavailable',
      message: 'That connection does not satisfy the saved prototype graph.'
    };
  }
}

export function reconnectCanvasGraphConnection(
  graph: PrototypeGraph,
  transitionId: string,
  connection: {
    readonly source: string;
    readonly sourceHandle: string | null;
    readonly target: string;
  }
): ReturnType<typeof editCanvasGraphConnection> {
  const transition = graph.transitions.find((item) => item.id === transitionId);
  if (transition === undefined || !('to' in transition))
    return {
      kind: 'unavailable',
      message: 'Select a connection with a destination to reconnect it.'
    };
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  const kind =
    target?.kind === 'state'
      ? 'set-state'
      : target?.kind === 'overlay'
        ? source?.kind === 'overlay'
          ? 'close-overlay'
          : 'open-overlay'
        : 'navigate';
  return editCanvasGraphConnection(
    graph,
    {
      transitionId,
      sourceNodeId: connection.source,
      portId: connection.sourceHandle ?? '',
      kind,
      targetNodeId: connection.target
    },
    transitionId
  );
}
