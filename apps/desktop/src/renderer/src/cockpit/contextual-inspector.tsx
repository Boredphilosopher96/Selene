import { useMemo, useState, type MouseEvent } from 'react';

import type { DesignerSnapshot, SpatialTargetInput } from '../../../shared/designer-api';
import {
  deriveInspectorSelection,
  isInspectorSearchMatch,
  normalizedPercent
} from './contextual-inspector-model';
import type { CanvasPrototypeConnectionSelection } from './canvas-workspace';
import type { PreviewElementTelemetrySelection } from '../../../shared/preview-channel';

type HandoffMode = 'ai' | 'review';

export interface ContextualInspectorProps {
  readonly snapshot: DesignerSnapshot;
  readonly selectedArtifactPinId: string | undefined;
  readonly aiTarget: SpatialTargetInput | undefined;
  readonly reviewTarget: SpatialTargetInput | undefined;
  readonly targetMode: 'idle' | 'ai' | 'review';
  readonly aiBusy: boolean;
  readonly selectedGraphNodeId?: string;
  readonly hideSnapshotSelection?: boolean;
  readonly selectedPreviewTelemetry?: PreviewElementTelemetrySelection;
  readonly prototypeConnection?: CanvasPrototypeConnectionSelection;
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
  selectedGraphNodeId,
  hideSnapshotSelection = false,
  selectedPreviewTelemetry,
  prototypeConnection,
  onHandoff
}: ContextualInspectorProps) {
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<'implementation' | 'ai' | 'unavailable'>();
  const selectionSnapshot = useMemo(() => {
    if (!hideSnapshotSelection) return snapshot;
    const { selectedNodeId: _selectedNodeId, ...withoutSelectedNode } = snapshot;
    return withoutSelectedNode;
  }, [hideSnapshotSelection, snapshot]);
  const selection = useMemo(
    () =>
      deriveInspectorSelection({
        snapshot: selectionSnapshot,
        selectedArtifactPinId,
        aiTarget,
        reviewTarget
      }),
    [selectionSnapshot, selectedArtifactPinId, aiTarget, reviewTarget]
  );
  const scenario = snapshot.scenarios.find((item) => item.id === snapshot.selectedScenarioId);
  const graphNode = snapshot.editablePrototype.graph.nodes.find(
    (node) => node.id === selectedGraphNodeId
  );
  const sourceNode = selection.node;
  const telemetry =
    selectedPreviewTelemetry?.provenance === 'authenticated-preview' &&
    sourceNode?.nodeId === selectedPreviewTelemetry.nodeId &&
    snapshot.source.revision.id === selectedPreviewTelemetry.revisionId
      ? selectedPreviewTelemetry.values
      : undefined;
  const hasDeveloperSelection = sourceNode !== undefined || graphNode !== undefined;
  const selectedName = sourceNode?.exportName ?? selection.target?.nodeRef ?? graphNode?.label;
  const sourceIdentity = sourceNode
    ? {
        stableId: sourceNode.nodeId,
        exportName: sourceNode.exportName,
        path: sourceNode.path,
        revisionId: snapshot.source.revision.id,
        designSystem: selection.catalogEntry ?? null
      }
    : undefined;
  const implementationContext = sourceIdentity
    ? JSON.stringify(sourceIdentity, null, 2)
    : 'Source identity unavailable: the current canvas selection has no host-confirmed React mapping.';
  const aiContext = JSON.stringify(
    {
      selection: sourceIdentity ?? {
        stableId: selection.target?.nodeRef ?? graphNode?.id ?? null,
        status: 'React source mapping unavailable'
      },
      frame: graphNode ? { id: graphNode.id, label: graphNode.label, kind: graphNode.kind } : null,
      preview:
        telemetry && selectedPreviewTelemetry
          ? {
              provenance: selectedPreviewTelemetry.provenance,
              revisionId: selectedPreviewTelemetry.revisionId,
              computed: telemetry
            }
          : 'Authenticated element telemetry unavailable',
      scenario: scenario
        ? {
            title: scenario.title,
            state: scenario.state,
            routes: scenario.navigation.map((step) => step.route)
          }
        : null,
      canvasAnchor: selection.target ?? null,
      baseline: {
        currency: snapshot.baseline.currency,
        readiness: snapshot.baseline.readiness,
        changesSinceBaseline: snapshot.baseline.changesSinceBaseline.length
      }
    },
    null,
    2
  );
  const copy = async (kind: 'implementation' | 'ai', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied('unavailable');
    }
  };
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
  const connectionMatches =
    prototypeConnection !== undefined &&
    hasMatch([
      prototypeConnection.transition.kind,
      prototypeConnection.sourceLabel,
      prototypeConnection.actionLabel,
      prototypeConnection.targetLabel
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
    selectionMatches ||
    connectionMatches ||
    scenarioMatches ||
    baselineMatches ||
    catalogMatches ||
    handoffMatches;
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
        <p className="conversation-history__eyebrow">Dev Mode · Inspect</p>
        <h2>{selectedName ?? 'Select a layer'}</h2>
        <p>Computed preview values and host-confirmed React handoff context.</p>
      </header>
      <section
        className="dev-inspector"
        aria-label="Selection developer details"
        data-empty={hasDeveloperSelection ? undefined : true}
      >
        {hasDeveloperSelection ? (
          <>
            <div className="dev-inspector__identity">
              <span className="dev-inspector__glyph" aria-hidden="true">
                {telemetry ? '⌁' : graphNode?.kind === 'overlay' ? '◇' : '▱'}
              </span>
              <div>
                <strong>{selectedName}</strong>
                <small>
                  {sourceNode
                    ? `${sourceNode.path} · ${sourceNode.nodeId}`
                    : graphNode
                      ? `${graphNode.kind} frame · ${graphNode.id}`
                      : 'Selected layer'}
                </small>
              </div>
              <span className="dev-inspector__status">
                {telemetry ? 'Live preview' : 'Frame context'}
              </span>
            </div>
            <div className="dev-inspector__breadcrumb" aria-label="Selection hierarchy">
              <span>{snapshot.source.projectId}</span>
              <b aria-hidden="true">›</b>
              <span>{sourceNode?.path ?? graphNode?.label ?? 'Selected layer'}</span>
              <b aria-hidden="true">›</b>
              <strong>{selectedName}</strong>
            </div>
            <details open>
              <summary>Layout</summary>
              <dl className="dev-inspector__grid">
                <DetailRow
                  label="Rendered size"
                  value={
                    telemetry
                      ? `${Math.round(telemetry.width)} × ${Math.round(telemetry.height)} px`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Display / position"
                  value={
                    telemetry
                      ? `${telemetry.display} · ${telemetry.position}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Box sizing"
                  value={telemetry?.boxSizing ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Margin"
                  value={telemetry?.margin ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Padding"
                  value={telemetry?.padding ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Gap"
                  value={telemetry?.gap ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Flex alignment"
                  value={
                    telemetry
                      ? `${telemetry.flexDirection} · ${telemetry.alignItems} · ${telemetry.justifyContent}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Grid tracks"
                  value={
                    telemetry
                      ? `${telemetry.gridTemplateColumns} / ${telemetry.gridTemplateRows}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Overflow"
                  value={telemetry?.overflow ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Canvas anchor"
                  value={
                    selection.target
                      ? `${normalizedPercent(selection.target.x)}, ${normalizedPercent(selection.target.y)} · ${
                          selection.target.width === undefined
                            ? 'point'
                            : `${normalizedPercent(selection.target.width)} × ${normalizedPercent(
                                selection.target.height ?? 0
                              )}`
                        }`
                      : 'Unavailable — no measured canvas target'
                  }
                />
              </dl>
            </details>
            <details open>
              <summary>Appearance</summary>
              <dl className="dev-inspector__grid">
                <DetailRow
                  label="Typography"
                  value={
                    telemetry
                      ? `${telemetry.fontFamily} · ${telemetry.fontSize}/${telemetry.lineHeight} · ${telemetry.fontWeight}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Letter / alignment"
                  value={
                    telemetry
                      ? `${telemetry.letterSpacing} · ${telemetry.textAlign} · ${telemetry.textDecoration}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Foreground"
                  value={telemetry?.color ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Background"
                  value={telemetry?.backgroundColor ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Border / radius"
                  value={
                    telemetry
                      ? `${telemetry.border} · ${telemetry.borderRadius}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Shadow / opacity"
                  value={
                    telemetry
                      ? `${telemetry.boxShadow} · ${telemetry.opacity}`
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Design tokens"
                  value="Unavailable — no token provenance reported"
                />
              </dl>
            </details>
            <details open>
              <summary>Accessibility</summary>
              <dl className="dev-inspector__grid">
                <DetailRow
                  label="Semantic HTML tag"
                  value={telemetry?.semanticTag ?? 'Not reported by authenticated preview'}
                />
                <DetailRow
                  label="Explicit ARIA role"
                  value={
                    telemetry
                      ? telemetry.explicitAriaRole || 'No explicit role attribute'
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Computed accessible name"
                  value="Unavailable — browser accessibility tree is not exposed to this preview"
                />
                <DetailRow
                  label="Explicit ARIA label"
                  value={
                    telemetry
                      ? telemetry.ariaLabel || 'No explicit aria-label attribute'
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Explicit description"
                  value={
                    telemetry
                      ? telemetry.accessibleDescription || 'No aria-description or title attribute'
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="ARIA states"
                  value={
                    telemetry
                      ? [
                          ['disabled', telemetry.ariaDisabled],
                          ['expanded', telemetry.ariaExpanded],
                          ['pressed', telemetry.ariaPressed],
                          ['checked', telemetry.ariaChecked],
                          ['selected', telemetry.ariaSelected],
                          ['hidden', telemetry.ariaHidden]
                        ]
                          .filter((entry) => entry[1])
                          .map((entry) => `${entry[0]}=${entry[1]}`)
                          .join(' · ') || 'No explicit ARIA state attributes'
                      : 'Not reported by authenticated preview'
                  }
                />
                <DetailRow
                  label="Tab index"
                  value={
                    telemetry ? String(telemetry.tabIndex) : 'Not reported by authenticated preview'
                  }
                />
              </dl>
            </details>
            <details open>
              <summary>React source & provenance</summary>
              <dl className="dev-inspector__grid">
                <DetailRow
                  label="Source identity"
                  value={
                    sourceNode
                      ? `${sourceNode.path} · ${sourceNode.exportName}`
                      : 'Unavailable — no host-confirmed React mapping'
                  }
                />
                <DetailRow
                  label="Design system"
                  value={
                    selection.catalogEntry
                      ? `${selection.catalogEntry.component} · ${selection.catalogEntry.href}`
                      : 'Unavailable — no catalog match'
                  }
                />
                <DetailRow
                  label="Telemetry provenance"
                  value={
                    selectedPreviewTelemetry && telemetry
                      ? `Authenticated preview · ${selectedPreviewTelemetry.revisionId}`
                      : 'Unavailable — selection and rendered revision are not both confirmed'
                  }
                />
                <DetailRow
                  label="Component state"
                  value={
                    snapshot.editablePrototype.runtime?.activeStateId ?? 'No active state reported'
                  }
                />
                <DetailRow
                  label="Prototype action"
                  value={
                    prototypeConnection
                      ? `${prototypeConnection.actionLabel} → ${prototypeConnection.targetLabel ?? 'runtime history'}`
                      : 'No selected interaction'
                  }
                />
              </dl>
            </details>
            <div className="dev-inspector__copy" role="group" aria-label="Copy developer context">
              <button
                type="button"
                onClick={() => void copy('implementation', implementationContext)}
              >
                Copy
              </button>
              <button type="button" onClick={() => void copy('ai', aiContext)}>
                Copy for AI
              </button>
              {copied ? (
                <output role="status">
                  {copied === 'unavailable'
                    ? 'Clipboard unavailable in this renderer session'
                    : copied === 'ai'
                      ? 'AI context copied'
                      : 'Implementation context copied'}
                </output>
              ) : null}
            </div>
          </>
        ) : (
          <div className="dev-inspector__empty">
            <span className="dev-inspector__empty-glyph" aria-hidden="true">
              ◫
            </span>
            <p>
              Click a rendered React element or canvas artboard to reveal its implementation
              details.
            </p>
            <ul>
              <li>Computed layout and visual styles</li>
              <li>Semantic HTML and explicit ARIA metadata</li>
              <li>React source, design-system provenance, and AI-ready context</li>
            </ul>
          </div>
        )}
      </section>
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
      {connectionMatches && prototypeConnection ? (
        <details className="guided-setup__manual-input" open>
          <summary>Prototype connection</summary>
          <div>
            <dl className="review-thread-list">
              <DetailRow label="Trigger" value={prototypeConnection.actionLabel} />
              <DetailRow label="From" value={prototypeConnection.sourceLabel} />
              <DetailRow
                label="Action"
                value={prototypeConnection.transition.kind.replaceAll('-', ' ')}
              />
              <DetailRow
                label="Destination"
                value={
                  prototypeConnection.targetLabel ??
                  (prototypeConnection.transition.kind === 'back'
                    ? 'Previous screen in runtime history'
                    : 'Prototype start state')
                }
              />
            </dl>
            <p className="review-pin-note">
              Frame-level binding. Element hotspot binding is not reported by this artifact yet.
            </p>
          </div>
        </details>
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
