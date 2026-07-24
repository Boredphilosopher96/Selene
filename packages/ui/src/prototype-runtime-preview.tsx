import type { ReactNode } from 'react';

import type { PrototypeGraph, PrototypeRuntimeSnapshot } from '@selene/core';

import { NewOrderPage, OrdersPage } from './orders-prototype-pages';

import './prototype-studio.css';

export interface PrototypePageContext {
  readonly graph: PrototypeGraph;
  readonly snapshot: PrototypeRuntimeSnapshot;
  readonly trigger: (nodeId: string, portId: string) => void;
}

export interface PrototypeRuntimePreviewProps {
  readonly graph: PrototypeGraph;
  readonly snapshot: PrototypeRuntimeSnapshot;
  readonly onTrigger: (nodeId: string, portId: string) => void;
  readonly onBack: () => void;
  readonly onScenarioStart: (scenarioId: string) => void;
  /** Hosts may supply their own compiled page tree without changing the runtime. */
  readonly renderPage?: ((context: PrototypePageContext) => ReactNode) | undefined;
}

/**
 * React runtime host for portable graphs. The bundled orders fixture uses real
 * screen components and DOM events; arbitrary graph text is never evaluated.
 */
export function PrototypeRuntimePreview({
  graph,
  snapshot,
  onTrigger,
  onBack,
  onScenarioStart,
  renderPage
}: PrototypeRuntimePreviewProps) {
  const activeNode = graph.nodes.find((node) => node.id === snapshot.activeNodeId);
  const route =
    activeNode?.kind === 'screen' || activeNode?.kind === 'page' ? activeNode.route : undefined;
  const page = renderPage ? (
    renderPage({ graph, snapshot, trigger: onTrigger })
  ) : graph.id === 'orders-flow' ? (
    <OrdersPrototypePages snapshot={snapshot} trigger={onTrigger} />
  ) : (
    <UnsupportedPrototypePage />
  );

  return (
    <section className="prototype-runtime" aria-label="Compiled React prototype">
      <header>
        <div>
          <p className="prototype-kicker">Compiled React prototype</p>
          <h2>{activeNode?.label ?? 'Missing screen'}</h2>
          {route ? <code>{route}</code> : null}
        </div>
        <button type="button" onClick={onBack} disabled={snapshot.history.length <= 1}>
          Back
        </button>
      </header>
      <label className="prototype-runtime__scenario">
        Scenario
        <select
          aria-label="Start scenario"
          value={snapshot.scenarioId ?? ''}
          onChange={(event) => onScenarioStart(event.currentTarget.value)}
        >
          {graph.scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
      </label>
      <div className="prototype-runtime__surface">{page}</div>
      <ol className="prototype-runtime__history" aria-label="Navigation history">
        {snapshot.history.map((nodeId, index) => (
          <li key={`${index}-${nodeId}`}>{nodeId}</li>
        ))}
      </ol>
    </section>
  );
}

function OrdersPrototypePages({
  snapshot,
  trigger
}: {
  readonly snapshot: PrototypeRuntimeSnapshot;
  readonly trigger: (nodeId: string, portId: string) => void;
}) {
  if (snapshot.activeNodeId === 'new-order') {
    return (
      <NewOrderPage
        saved={snapshot.activeOverlayId === 'saved'}
        onSave={() => trigger('new-order', 'save')}
        onCancel={() => trigger('new-order', 'cancel')}
        onDismiss={() => trigger('saved', 'dismiss')}
      />
    );
  }
  return (
    <OrdersPage
      state={snapshot.activeStateId === 'orders-empty' ? 'empty' : 'success'}
      onCreateOrder={() => trigger('orders', 'create')}
      onRestoreOrders={() => trigger('orders-empty', 'restore')}
      onShowEmpty={() => trigger('orders', 'filter-empty')}
    />
  );
}

function UnsupportedPrototypePage() {
  return (
    <article className="prototype-page" aria-label="Unsupported prototype page">
      <h3>Host a compiled page tree</h3>
      <p>This graph has no registered React fixture.</p>
    </article>
  );
}
