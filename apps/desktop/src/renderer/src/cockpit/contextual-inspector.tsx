import { useMemo, useState, type MouseEvent } from 'react';

import type { DesignerSnapshot, SpatialTargetInput } from '../../../shared/designer-api';
import {
  deriveInspectorSelection,
  isInspectorSearchMatch,
  normalizedPercent
} from './contextual-inspector-model';

type HandoffMode = 'ai' | 'review';

export interface ContextualInspectorProps {
  readonly snapshot: DesignerSnapshot;
  readonly selectedArtifactPinId: string | undefined;
  readonly aiTarget: SpatialTargetInput | undefined;
  readonly reviewTarget: SpatialTargetInput | undefined;
  readonly targetMode: 'idle' | 'ai' | 'review';
  readonly aiBusy: boolean;
  readonly onHandoff: (
    mode: HandoffMode,
    target: SpatialTargetInput,
    invoking: HTMLButtonElement
  ) => void;
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="review-thread-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Unreported({ label }: { readonly label: string }) {
  return <DetailRow label={label} value="Not reported by preview" />;
}

/** Read-only renderer context composed from the host snapshot and current trusted spatial selections. */
export function ContextualInspector({
  snapshot,
  selectedArtifactPinId,
  aiTarget,
  reviewTarget,
  targetMode,
  aiBusy,
  onHandoff
}: ContextualInspectorProps) {
  const [query, setQuery] = useState('');
  const selection = useMemo(
    () => deriveInspectorSelection({ snapshot, selectedArtifactPinId, aiTarget, reviewTarget }),
    [snapshot, selectedArtifactPinId, aiTarget, reviewTarget]
  );
  const scenario = snapshot.scenarios.find((item) => item.id === snapshot.selectedScenarioId);
  const selectionName =
    selection.node?.exportName ?? (selection.target ? 'Spatial selection' : 'No selection');
  const hasMatch = (values: readonly (string | undefined)[]) =>
    isInspectorSearchMatch(query, values);
  const selectionMatches = hasMatch([
    selectionName,
    selection.node?.path,
    selection.target?.nodeRef,
    selection.targetOrigin,
    targetMode === 'idle' ? 'No target tool active' : `${targetMode} target selection active`
  ]);
  const scenarioMatches = hasMatch([
    scenario?.title,
    scenario?.state,
    scenario?.locale,
    scenario?.theme,
    ...(scenario?.navigation ?? []).flatMap((item) => [item.action, item.route])
  ]);
  const baselineMatches = hasMatch([
    snapshot.baseline.readiness,
    snapshot.baseline.currency,
    snapshot.baseline.baseline?.intent,
    ...snapshot.baseline.changesSinceBaseline.flatMap((item) => [item.kind, item.reason])
  ]);
  const catalogEntries = snapshot.componentCatalog.entries.filter((entry) =>
    hasMatch([entry.component, entry.href])
  );
  const catalogMatches = query.trim().length === 0 || catalogEntries.length > 0;
  const handoffMatches = hasMatch(['AI edit', 'review comment', selectionName]);
  const hasAnyMatch =
    selectionMatches || scenarioMatches || baselineMatches || catalogMatches || handoffMatches;
  const handoff = (mode: HandoffMode, event: MouseEvent<HTMLButtonElement>) => {
    if (selection.target) onHandoff(mode, selection.target, event.currentTarget);
  };

  return (
    <section
      id="inspector-inspect"
      role="tabpanel"
      aria-labelledby="inspector-tab-inspect"
      className="contextual-inspector guided-setup review-panel review-handoff-panel"
    >
      <header className="review-panel__header">
        <p className="conversation-history__eyebrow">Inspect</p>
        <h2>Artifact context</h2>
        <p>Read-only context from the compiled preview and host-supplied project snapshot.</p>
      </header>
      <div className="review-composer">
        <label>
          <span>Search inspect context</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Node, route, catalog, change"
          />
        </label>
      </div>
      {!hasAnyMatch ? (
        <p className="review-thread-group__empty" role="status">
          No inspect context matches “{query.trim()}”. Clear the search to see the current snapshot.
        </p>
      ) : null}
      {selectionMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Selection and hierarchy</summary>
          <div>
            {selection.node || selection.target ? (
              <dl className="review-thread-list">
                <DetailRow label="Identity" value={selectionName} />
                {selection.node ? (
                  <DetailRow label="Source path" value={selection.node.path} />
                ) : null}
                {selection.node ? (
                  <DetailRow label="Export" value={selection.node.exportName} />
                ) : null}
                {selection.node ? (
                  <DetailRow
                    label="Hierarchy"
                    value={`${selection.node.path} → ${selection.node.exportName}`}
                  />
                ) : null}
                {selection.target?.nodeRef && !selection.node ? (
                  <DetailRow label="Preview node reference" value={selection.target.nodeRef} />
                ) : null}
                {selection.targetOrigin ? (
                  <DetailRow label="Selection source" value={selection.targetOrigin} />
                ) : null}
                <DetailRow
                  label="Targeting mode"
                  value={
                    targetMode === 'idle'
                      ? 'No target tool active'
                      : `${targetMode === 'ai' ? 'AI edit' : 'Review comment'} selection active`
                  }
                />
                {selection.catalogEntry ? (
                  <DetailRow label="Catalog match" value={selection.catalogEntry.component} />
                ) : null}
              </dl>
            ) : (
              <p className="review-thread-group__empty">
                No node or preview region is selected. Select a review pin or choose a preview
                target to inspect it.
              </p>
            )}
          </div>
        </details>
      ) : null}
      {selectionMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Measured preview data</summary>
          <div>
            {selection.target ? (
              <dl className="review-thread-list">
                <DetailRow
                  label="Horizontal position"
                  value={normalizedPercent(selection.target.x)}
                />
                <DetailRow
                  label="Vertical position"
                  value={normalizedPercent(selection.target.y)}
                />
                <DetailRow
                  label="Selection width"
                  value={
                    selection.target.width === undefined
                      ? 'Point selection'
                      : normalizedPercent(selection.target.width)
                  }
                />
                <DetailRow
                  label="Selection height"
                  value={
                    selection.target.height === undefined
                      ? 'Point selection'
                      : normalizedPercent(selection.target.height)
                  }
                />
                <DetailRow
                  label="Measured viewport"
                  value={`${selection.target.viewport.width} × ${selection.target.viewport.height}px`}
                />
                <Unreported label="Spacing" />
                <Unreported label="Typography" />
                <Unreported label="Color and style" />
              </dl>
            ) : (
              <p className="review-thread-group__empty">
                No measured point or region is available for the current selection.
              </p>
            )}
          </div>
        </details>
      ) : null}
      {scenarioMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Scenario and route</summary>
          <div>
            {scenario ? (
              <dl className="review-thread-list">
                <DetailRow label="Scenario" value={scenario.title} />
                <DetailRow label="State" value={scenario.state} />
                <DetailRow
                  label="Viewport"
                  value={`${scenario.viewport.width} × ${scenario.viewport.height}px`}
                />
                <DetailRow label="Locale" value={scenario.locale} />
                <DetailRow label="Theme" value={scenario.theme} />
                <DetailRow
                  label="Route path"
                  value={
                    scenario.navigation.map((step) => step.route).join(' → ') || 'Not reported'
                  }
                />
              </dl>
            ) : (
              <p className="review-thread-group__empty">
                The selected scenario is not present in this snapshot.
              </p>
            )}
          </div>
        </details>
      ) : null}
      {baselineMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Baseline and changes</summary>
          <div>
            <dl className="review-thread-list">
              <DetailRow label="Readiness" value={snapshot.baseline.readiness} />
              <DetailRow label="Currency" value={snapshot.baseline.currency} />
              <DetailRow
                label="Baseline intent"
                value={snapshot.baseline.baseline?.intent ?? 'No baseline recorded'}
              />
              <DetailRow
                label="Changes since baseline"
                value={String(snapshot.baseline.changesSinceBaseline.length)}
              />
              <DetailRow
                label="Approvals"
                value={
                  snapshot.baseline.approvalsStale
                    ? 'Prior approvals are stale'
                    : 'No stale approvals reported'
                }
              />
            </dl>
            {snapshot.baseline.changesSinceBaseline.length > 0 ? (
              <ul className="review-thread-list">
                {snapshot.baseline.changesSinceBaseline.slice(0, 3).map((change) => (
                  <li className="review-thread-row" key={change.id}>
                    <strong>{change.kind}</strong> {change.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      ) : null}
      {catalogMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Design-system catalog</summary>
          <div>
            <p className="review-pin-note">
              {snapshot.componentCatalog.entries.length} host-supplied catalog{' '}
              {snapshot.componentCatalog.entries.length === 1 ? 'entry' : 'entries'}; references are
              read-only.
            </p>
            {catalogEntries.length > 0 ? (
              <ul className="review-thread-list">
                {catalogEntries.map((entry) => (
                  <li className="review-thread-row" key={`${entry.component}-${entry.href}`}>
                    <strong>{entry.component}</strong>
                    <small>{entry.href}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="review-thread-group__empty">No catalog entries match this search.</p>
            )}
          </div>
        </details>
      ) : null}
      {handoffMatches ? (
        <details className="guided-setup__manual-input" open>
          <summary>Send this context</summary>
          <div>
            <p>
              Use the same selected preview point or region in an existing AI or stakeholder
              workflow.
            </p>
            <div
              className="review-handoff-panel__actions"
              role="group"
              aria-label="Selected context handoff"
            >
              <button
                type="button"
                disabled={!selection.target || aiBusy}
                onClick={(event) => handoff('ai', event)}
              >
                Use in AI edit
              </button>
              <button
                className="review-handoff-panel__secondary"
                type="button"
                disabled={!selection.target}
                onClick={(event) => handoff('review', event)}
              >
                Use in review comment
              </button>
            </div>
            {!selection.target ? (
              <p className="review-pin-note">
                {selection.node
                  ? 'This node has no preview geometry. Choose a preview pin or target before handing off context.'
                  : 'Choose a preview pin or target before handing off context.'}
              </p>
            ) : null}
            {selection.target && aiBusy ? (
              <p className="review-pin-note">
                Wait for the current AI operation before starting another edit.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
