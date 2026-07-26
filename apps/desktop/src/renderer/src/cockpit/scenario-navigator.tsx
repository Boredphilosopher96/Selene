import { useEffect, useMemo, useRef, useState } from 'react';

import type { PrototypeGraph, PrototypeRuntimeSnapshot } from '@selene/core';

import type { DesignerSnapshot, PrototypeScenarioStartInput } from '../../../shared/designer-api';
import {
  isScenarioNavigatorMatch,
  isScenarioNavigatorNodeMatch,
  runtimeNavigatorContext,
  scenarioNavigatorEntries,
  scenarioNavigatorNodeGroups
} from './scenario-navigator-model';

export interface ScenarioNavigatorProps {
  readonly graph: PrototypeGraph;
  readonly projectId: string;
  readonly graphRevision: number;
  readonly hydration: DesignerSnapshot['prototypeGraphHydration'];
  readonly runtime: PrototypeRuntimeSnapshot | undefined;
  readonly onStartScenario: (request: PrototypeScenarioStartInput) => Promise<void>;
}

/** Read-only graph map plus the sole flow-respecting action: start a declared scenario. */
export function ScenarioNavigator({
  graph,
  projectId,
  graphRevision,
  hydration,
  runtime,
  onStartScenario
}: ScenarioNavigatorProps) {
  const [query, setQuery] = useState('');
  const [startingScenarioId, setStartingScenarioId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState(
    'Choose a named scenario to run its declared flow in Preview.'
  );
  const startLatch = useRef<string | undefined>(undefined);
  const operationId = useRef(0);
  const graphIdentity = `${projectId}:${graphRevision}`;
  const graphIdentityRef = useRef(graphIdentity);
  if (graphIdentityRef.current !== graphIdentity) {
    graphIdentityRef.current = graphIdentity;
    operationId.current += 1;
  }
  const entries = useMemo(() => scenarioNavigatorEntries(graph), [graph]);
  const nodeGroups = useMemo(() => scenarioNavigatorNodeGroups(graph), [graph]);
  const runtimeContext = useMemo(() => runtimeNavigatorContext(graph, runtime), [graph, runtime]);
  const visibleEntries = entries.filter((entry) => isScenarioNavigatorMatch(entry, query));
  const visibleNodeGroups = nodeGroups.map((group) => ({
    ...group,
    nodes: group.nodes.filter((node) => isScenarioNavigatorNodeMatch(node, query))
  }));

  useEffect(() => {
    startLatch.current = undefined;
    setStartingScenarioId(undefined);
    setStatus('Choose a named scenario to run its declared flow in Preview.');
  }, [graphIdentity]);

  const start = (scenarioId: string) => {
    if (startLatch.current !== undefined || hydration.state === 'recovery-required') return;
    const invocation = ++operationId.current;
    const identity = graphIdentity;
    startLatch.current = scenarioId;
    setStartingScenarioId(scenarioId);
    setStatus(`Starting ${scenarioId} from the saved graph…`);
    void onStartScenario({ projectId, graphRevision, scenarioId })
      .then(() => {
        if (operationId.current === invocation && graphIdentityRef.current === identity)
          setStatus(`Running ${scenarioId} in the compiled Preview.`);
      })
      .catch((error: unknown) => {
        if (operationId.current === invocation && graphIdentityRef.current === identity)
          setStatus(error instanceof Error ? error.message : 'The scenario could not be started.');
      })
      .finally(() => {
        if (operationId.current === invocation && graphIdentityRef.current === identity)
          startLatch.current = undefined;
        if (operationId.current === invocation && graphIdentityRef.current === identity)
          setStartingScenarioId(undefined);
      });
  };

  return (
    <aside
      className="scenario-navigator guided-setup review-panel"
      aria-labelledby="scenario-navigator-heading"
    >
      <header className="review-panel__header">
        <p className="conversation-history__eyebrow">Navigator</p>
        <h2 id="scenario-navigator-heading">Screens and scenarios</h2>
        <p>
          Browse the saved graph, then start a declared scenario. Screens are never jumped to
          directly.
        </p>
      </header>
      <div className="review-composer">
        <label>
          <span>Search saved graph</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Scenario, screen, page, overlay, state, route"
          />
        </label>
      </div>
      {hydration.state === 'recovery-required' ? (
        <p className="workspace-notice" role="alert">
          Scenario start is unavailable until recovery completes: {hydration.message}
        </p>
      ) : hydration.state === 'missing' ? (
        <p className="workspace-notice" role="status">
          No persisted graph is available yet; this local graph is ready to save and run.
        </p>
      ) : null}
      <details className="guided-setup__manual-input" open>
        <summary>Runtime</summary>
        <div>
          {runtimeContext ? (
            <dl className="review-thread-list">
              <div className="review-thread-row">
                <dt>Scenario</dt>
                <dd>{runtimeContext.scenario}</dd>
              </div>
              <div className="review-thread-row">
                <dt>Active screen or page</dt>
                <dd>{runtimeContext.activeNode}</dd>
              </div>
              {runtimeContext.activeState ? (
                <div className="review-thread-row">
                  <dt>State</dt>
                  <dd>{runtimeContext.activeState}</dd>
                </div>
              ) : null}
              {runtimeContext.activeOverlay ? (
                <div className="review-thread-row">
                  <dt>Overlay</dt>
                  <dd>{runtimeContext.activeOverlay}</dd>
                </div>
              ) : null}
              <div className="review-thread-row">
                <dt>Runtime path</dt>
                <dd>
                  {runtimeContext.omittedPathCount > 0
                    ? `${runtimeContext.omittedPathCount} earlier steps omitted · `
                    : ''}
                  {runtimeContext.path.join(' → ')}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="review-thread-group__empty" role="status">
              No runtime is active. Starting a named scenario opens its declared entry in Preview.
            </p>
          )}
        </div>
      </details>
      <details className="guided-setup__manual-input" open>
        <summary>Scenarios ({entries.length})</summary>
        <div>
          {entries.length === 0 ? (
            <p className="review-thread-group__empty" role="status">
              No saved scenarios are available.
            </p>
          ) : visibleEntries.length === 0 ? (
            <p className="review-thread-group__empty" role="status">
              No saved scenario matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="review-thread-list" aria-label="Declared scenarios">
              {visibleEntries.map((entry) => {
                const active = runtime?.scenarioId === entry.id;
                const starting = startingScenarioId === entry.id;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="review-thread-row"
                      aria-pressed={active}
                      aria-label={`Start scenario ${entry.name} from ${entry.startNodeLabel}`}
                      disabled={
                        hydration.state === 'recovery-required' || startingScenarioId !== undefined
                      }
                      onClick={() => start(entry.id)}
                    >
                      <strong>{active ? 'Running scenario' : 'Declared scenario'}</strong>
                      <span>{entry.name}</span>
                      <small>
                        {entry.startNodeKind} · {entry.startNodeLabel}
                        {entry.route === undefined ? '' : ` · ${entry.route}`}
                      </small>
                      {entry.initialStateLabel ? (
                        <small>Initial state: {entry.initialStateLabel}</small>
                      ) : null}
                      <small>Path: {entry.expectedPath.join(' → ')}</small>
                      {starting ? <small>Starting…</small> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
      {visibleNodeGroups.map((group) => (
        <details key={group.id} className="guided-setup__manual-input" open>
          <summary>
            {group.label} ({group.nodes.length})
          </summary>
          <div>
            {group.nodes.length === 0 ? (
              <p className="review-thread-group__empty" role="status">
                No {group.label.toLocaleLowerCase()} match this search.
              </p>
            ) : (
              <ul className="review-thread-list" aria-label={group.label}>
                {group.nodes.map((node) => (
                  <li key={node.id} className="review-thread-row">
                    <strong>{node.kind}</strong>
                    <span>{node.label}</span>
                    <small>
                      {node.id}
                      {node.route === undefined ? '' : ` · ${node.route}`}
                    </small>
                    {node.parentLabel ? <small>Contained by: {node.parentLabel}</small> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      ))}
      <p className="workspace-notice" aria-live="polite">
        {status}
      </p>
    </aside>
  );
}
