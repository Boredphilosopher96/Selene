import {
  parsePrototypeRuntimeSnapshot,
  type PrototypeGraph,
  type PrototypeRuntimeSnapshot
} from '@selene/core/prototype';

const stateKey = 'selenePrototypeRuntime';

type BrowserRuntimeState = {
  readonly graphId: string;
  readonly snapshot: PrototypeRuntimeSnapshot;
};
type HistoryRuntimeState = Record<typeof stateKey, BrowserRuntimeState>;

function routeFor(graph: PrototypeGraph, snapshot: PrototypeRuntimeSnapshot): string {
  const node = graph.nodes.find((item) => item.id === snapshot.activeNodeId);
  if ((node?.kind === 'screen' || node?.kind === 'page') && node.route.startsWith('/'))
    return node.route;
  throw new Error('Prototype runtime cannot navigate to a non-route node');
}

function historyState(
  graph: PrototypeGraph,
  snapshot: PrototypeRuntimeSnapshot
): HistoryRuntimeState {
  return { [stateKey]: { graphId: graph.id, snapshot } };
}

function isBrowserRuntimeState(value: unknown, graphId: string): value is HistoryRuntimeState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as Record<string, unknown>)[stateKey];
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { graphId?: unknown }).graphId === graphId &&
    typeof (candidate as { snapshot?: unknown }).snapshot === 'object'
  );
}

/** Browser-only adapter around an already-validated internal graph route. */
export function createPrototypeBrowserNavigation(graph: PrototypeGraph) {
  return {
    replace(snapshot: PrototypeRuntimeSnapshot) {
      window.history.replaceState(historyState(graph, snapshot), '', routeFor(graph, snapshot));
    },
    push(snapshot: PrototypeRuntimeSnapshot) {
      window.history.pushState(historyState(graph, snapshot), '', routeFor(graph, snapshot));
    },
    onPopState(listener: (snapshot: PrototypeRuntimeSnapshot) => void) {
      const handler = (event: PopStateEvent) => {
        if (!isBrowserRuntimeState(event.state, graph.id)) return;
        try {
          listener(parsePrototypeRuntimeSnapshot(event.state[stateKey].snapshot, graph));
        } catch {
          // Ignore history entries not produced by this exact validated graph.
        }
      };
      window.addEventListener('popstate', handler);
      return () => window.removeEventListener('popstate', handler);
    }
  };
}
