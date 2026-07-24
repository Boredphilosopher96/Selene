import type { ReactNode } from 'react';

import type { PrototypeGraph, PrototypeRuntimeSnapshot } from '@selene/core';

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
  if (snapshot.activeNodeId === 'new-order')
    return <NewOrderPage snapshot={snapshot} trigger={trigger} />;
  return <OrdersPage snapshot={snapshot} trigger={trigger} />;
}

function OrdersPage({
  snapshot,
  trigger
}: {
  readonly snapshot: PrototypeRuntimeSnapshot;
  readonly trigger: (nodeId: string, portId: string) => void;
}) {
  const empty = snapshot.activeStateId === 'orders-empty';
  return (
    <article className="prototype-page prototype-page--orders" aria-label="Orders prototype page">
      <div className="prototype-page__bar">
        <strong>Northstar</strong>
        <span>Orders</span>
        <button type="button" onClick={() => trigger('orders', 'create')}>
          Create order
        </button>
      </div>
      <h3>Orders</h3>
      {empty ? (
        <section className="prototype-page__empty">
          <strong>No orders match this filter.</strong>
          <button type="button" onClick={() => trigger('orders-empty', 'restore')}>
            Restore orders
          </button>
        </section>
      ) : (
        <ul className="prototype-page__orders">
          <li>
            <strong>#1042</strong>
            <span>Ada Lovelace · $128.00</span>
          </li>
          <li>
            <strong>#1043</strong>
            <span>Grace Hopper · $240.00</span>
          </li>
        </ul>
      )}
      <button
        type="button"
        className="prototype-page__secondary"
        onClick={() => trigger('orders', 'filter-empty')}
      >
        Show empty
      </button>
    </article>
  );
}

function NewOrderPage({
  snapshot,
  trigger
}: {
  readonly snapshot: PrototypeRuntimeSnapshot;
  readonly trigger: (nodeId: string, portId: string) => void;
}) {
  const saved = snapshot.activeOverlayId === 'saved';
  return (
    <article
      className="prototype-page prototype-page--new-order"
      aria-label="New order prototype page"
    >
      <h3>New order</h3>
      <p>Create an order without any network request.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          trigger('new-order', 'save');
        }}
      >
        <label>
          Customer
          <input aria-label="Customer" defaultValue="Ada Lovelace" />
        </label>
        <label>
          Amount
          <input aria-label="Amount" defaultValue="128.00" />
        </label>
        <div>
          <button type="submit">Save order</button>
          <button
            type="button"
            className="prototype-page__secondary"
            onClick={() => trigger('new-order', 'cancel')}
          >
            Cancel
          </button>
        </div>
      </form>
      {saved ? (
        <aside className="prototype-runtime__overlay" aria-label="Order saved overlay">
          <strong>Order saved</strong>
          <button type="button" onClick={() => trigger('saved', 'dismiss')}>
            Dismiss
          </button>
        </aside>
      ) : null}
    </article>
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
