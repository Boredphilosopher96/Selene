import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type {
  DesignerSnapshot,
  DesignSystemComponentInsertApplyRequest,
  DesignSystemComponentInsertCapability,
  DesignSystemComponentInsertCapabilityRequest,
  DesignSystemComponentInsertUnavailable,
  DesignSystemComponentReplaceApplyRequest,
  DesignSystemComponentReplaceCapability,
  DesignSystemComponentReplaceCapabilityRequest,
  DesignSystemComponentReplaceUnavailable,
  DesignSystemComponentPropertyEditApplyRequest,
  DesignSystemComponentPropertyEditCapability,
  DesignSystemComponentPropertyEditCapabilityRequest,
  DesignSystemComponentPropertyEditUnavailable,
  DesignSystemComponentPropertyValue,
  ManualAppearanceEditApplyRequest,
  ManualAppearanceEditCapability,
  ManualAppearanceEditCapabilityRequest,
  ManualAppearanceEditUnavailable,
  ManualPositionEditApplyRequest,
  ManualPositionEditCapability,
  ManualPositionEditCapabilityRequest,
  ManualPositionEditUnavailable,
  ManualStructureEditApplyRequest,
  ManualStructureEditCapability,
  ManualStructureEditCapabilityRequest,
  ManualStructureEditUnavailable,
  ManualAppearanceProperty,
  ManualAppearanceValue,
  ManualLayoutEditApplyRequest,
  ManualLayoutEditCapability,
  ManualLayoutEditCapabilityRequest,
  ManualLayoutEditUnavailable,
  ManualLayoutProperty,
  ManualLayoutValue,
  ManualTextEditApplyRequest,
  ManualTextEditCapability,
  ManualTextEditCapabilityRequest,
  ManualTextEditUnavailable,
  SpatialTargetInput
} from '../../../shared/designer-api';
import type { DesignEditResult } from '@selene/core';
import {
  computedCssSnippet,
  devModeAiClipboard,
  deriveInspectorSelection,
  isInspectorSearchMatch,
  normalizedPercent,
  reactSourceReference,
  safeInspectorValue,
  withheldInspectorValue
} from './contextual-inspector-model';
import type { CanvasPrototypeConnectionSelection } from './canvas-workspace';
import type { PreviewElementTelemetrySelection } from '../../../shared/preview-channel';

type HandoffMode = 'ai';

export interface ContextualInspectorProps {
  readonly snapshot: DesignerSnapshot;
  readonly selectedArtifactPinId: string | undefined;
  readonly aiTarget: SpatialTargetInput | undefined;
  readonly aiBusy: boolean;
  readonly selectedGraphNodeId?: string;
  readonly hideSnapshotSelection?: boolean;
  readonly selectedPreviewTelemetry?: PreviewElementTelemetrySelection;
  readonly prototypeConnection?: CanvasPrototypeConnectionSelection;
  readonly onSelectNode: (nodeId: string) => void;
  /**
   * Adopts the durable host snapshot immediately, then refreshes the compiled
   * preview through the renderer's sole presentation coordinator.
   */
  readonly onArtifactApplied: (snapshot: DesignerSnapshot, status: string) => Promise<void>;
  readonly manualTextEditor: ManualTextEditorPort;
  readonly onHandoff: (
    mode: HandoffMode,
    target: SpatialTargetInput,
    invoking: HTMLButtonElement
  ) => void;
}

/** Narrow host capability consumed by the reusable inspector UI. */
export interface ManualTextEditorPort {
  requestManualTextEditCapability(
    input: ManualTextEditCapabilityRequest
  ): Promise<ManualTextEditCapability | ManualTextEditUnavailable>;
  applyManualTextEdit(input: ManualTextEditApplyRequest): Promise<DesignEditResult>;
  requestManualLayoutEditCapability(
    input: ManualLayoutEditCapabilityRequest
  ): Promise<ManualLayoutEditCapability | ManualLayoutEditUnavailable>;
  applyManualLayoutEdit(input: ManualLayoutEditApplyRequest): Promise<DesignEditResult>;
  requestManualAppearanceEditCapability(
    input: ManualAppearanceEditCapabilityRequest
  ): Promise<ManualAppearanceEditCapability | ManualAppearanceEditUnavailable>;
  applyManualAppearanceEdit(input: ManualAppearanceEditApplyRequest): Promise<DesignEditResult>;
  requestManualPositionEditCapability(
    input: ManualPositionEditCapabilityRequest
  ): Promise<ManualPositionEditCapability | ManualPositionEditUnavailable>;
  applyManualPositionEdit(input: ManualPositionEditApplyRequest): Promise<DesignEditResult>;
  requestManualStructureEditCapability?(
    input: ManualStructureEditCapabilityRequest
  ): Promise<ManualStructureEditCapability | ManualStructureEditUnavailable>;
  applyManualStructureEdit?(input: ManualStructureEditApplyRequest): Promise<DesignEditResult>;
  requestDesignSystemComponentInsertCapability?(
    input: DesignSystemComponentInsertCapabilityRequest
  ): Promise<DesignSystemComponentInsertCapability | DesignSystemComponentInsertUnavailable>;
  applyDesignSystemComponentInsert?(
    input: DesignSystemComponentInsertApplyRequest
  ): Promise<DesignEditResult>;
  requestDesignSystemComponentReplaceCapability?(
    input: DesignSystemComponentReplaceCapabilityRequest
  ): Promise<DesignSystemComponentReplaceCapability | DesignSystemComponentReplaceUnavailable>;
  applyDesignSystemComponentReplace?(
    input: DesignSystemComponentReplaceApplyRequest
  ): Promise<DesignEditResult>;
  requestDesignSystemComponentPropertyEditCapability(
    input: DesignSystemComponentPropertyEditCapabilityRequest
  ): Promise<
    DesignSystemComponentPropertyEditCapability | DesignSystemComponentPropertyEditUnavailable
  >;
  applyDesignSystemComponentPropertyEdit(
    input: DesignSystemComponentPropertyEditApplyRequest
  ): Promise<DesignEditResult>;
  snapshot(): Promise<DesignerSnapshot>;
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  const safeValue = safeInspectorValue(value);
  return (
    <div className="review-thread-row">
      <dt>{label}</dt>
      <dd>{safeValue ?? withheldInspectorValue}</dd>
    </div>
  );
}

function Unreported({ label }: { readonly label: string }) {
  return <DetailRow label={label} value="Not reported by preview" />;
}

const manualLayoutGroups = [
  {
    label: 'Frame',
    properties: ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight']
  },
  {
    label: 'Auto layout',
    properties: ['display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'order']
  }
] as const satisfies readonly {
  readonly label: string;
  readonly properties: readonly ManualLayoutProperty[];
}[];

function manualLayoutLabel(property: ManualLayoutProperty): string {
  const labels: Record<ManualLayoutProperty, string> = {
    display: 'Display',
    flexDirection: 'Direction',
    justifyContent: 'Distribute',
    alignItems: 'Align',
    gap: 'Gap',
    order: 'Order',
    width: 'Width',
    height: 'Height',
    minWidth: 'Min W',
    minHeight: 'Min H',
    maxWidth: 'Max W',
    maxHeight: 'Max H'
  };
  return labels[property];
}

function manualLayoutChoices(property: ManualLayoutProperty): readonly string[] | undefined {
  if (property === 'display')
    return ['block', 'flex', 'grid', 'inline-flex', 'inline-grid', 'none'];
  if (property === 'flexDirection') return ['row', 'column', 'row-reverse', 'column-reverse'];
  if (property === 'justifyContent')
    return ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'];
  if (property === 'alignItems') return ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'];
  return undefined;
}

function manualLayoutDrafts(
  telemetry: PreviewElementTelemetrySelection['values'] | undefined
): Record<ManualLayoutProperty, string> {
  const choice = (property: ManualLayoutProperty, value: string | undefined) =>
    value !== undefined && manualLayoutChoices(property)?.includes(value) ? value : '';
  return {
    display: choice('display', telemetry?.display),
    flexDirection: choice('flexDirection', telemetry?.flexDirection),
    justifyContent: choice('justifyContent', telemetry?.justifyContent),
    alignItems: choice('alignItems', telemetry?.alignItems),
    gap:
      telemetry &&
      /^(?:auto|fit-content|min-content|max-content|0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%|vw|vh))$/u.test(
        telemetry.gap
      )
        ? telemetry.gap
        : '0',
    order: '0',
    width: telemetry ? `${Math.round(telemetry.width * 100) / 100}px` : '',
    height: telemetry ? `${Math.round(telemetry.height * 100) / 100}px` : '',
    minWidth: '',
    minHeight: '',
    maxWidth: '',
    maxHeight: ''
  };
}

const manualAppearanceGroups = [
  {
    label: 'Fill & surface',
    hint: 'Color, radius, and visibility',
    properties: ['color', 'backgroundColor', 'borderRadius', 'opacity']
  },
  {
    label: 'Typography',
    hint: 'Type family, rhythm, and alignment',
    properties: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign']
  },
  {
    label: 'Spacing',
    hint: 'One to four safe CSS values',
    properties: ['padding', 'margin']
  }
] as const satisfies readonly {
  readonly label: string;
  readonly hint: string;
  readonly properties: readonly ManualAppearanceProperty[];
}[];

function manualAppearanceLabel(property: ManualAppearanceProperty): string {
  const labels: Record<ManualAppearanceProperty, string> = {
    color: 'Text',
    backgroundColor: 'Fill',
    fontFamily: 'Family',
    fontSize: 'Size',
    fontWeight: 'Weight',
    lineHeight: 'Line height',
    letterSpacing: 'Tracking',
    textAlign: 'Align',
    borderRadius: 'Radius',
    opacity: 'Opacity',
    padding: 'Padding',
    margin: 'Margin'
  };
  return labels[property];
}

function designTokenSummary(
  capability: ManualAppearanceEditCapability | ManualAppearanceEditUnavailable | undefined
): string {
  if (capability?.kind !== 'available') return 'Unavailable — no token provenance reported';
  const authored = Object.entries(capability.currentValues).filter(
    (entry): entry is [ManualAppearanceProperty, string] =>
      typeof entry[1] === 'string' && /^var\(--[a-z][a-z0-9_-]{0,63}\)$/iu.test(entry[1])
  );
  if (authored.length === 0) return 'No authored design token on this element';
  return authored
    .map(([property, value]) => {
      const token = capability.tokens.find(
        (candidate) =>
          candidate.value === value &&
          candidate.properties.some((supported) => supported === property)
      );
      return token === undefined
        ? `${manualAppearanceLabel(property)} · unresolved ${value}`
        : `${manualAppearanceLabel(property)} · ${token.label} · ${token.packageName}@${token.version}`;
    })
    .join(' · ');
}

function manualAppearanceChoices(
  property: ManualAppearanceProperty
): readonly string[] | undefined {
  if (property === 'fontWeight')
    return ['normal', '100', '200', '300', '400', '500', '600', '700', '800', '900', 'bold'];
  if (property === 'textAlign') return ['start', 'left', 'center', 'right', 'end', 'justify'];
  return undefined;
}

function rgbToHex(value: string): string | undefined {
  const match =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/iu.exec(
      value
    );
  if (!match) return undefined;
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return undefined;
  if (match[4] !== undefined && Number(match[4]) === 0) return 'transparent';
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function manualAppearanceDrafts(
  telemetry: PreviewElementTelemetrySelection['values'] | undefined
): Record<ManualAppearanceProperty, string> {
  return {
    color: telemetry ? (rgbToHex(telemetry.color) ?? '') : '',
    backgroundColor: telemetry ? (rgbToHex(telemetry.backgroundColor) ?? '') : '',
    fontFamily: telemetry?.fontFamily ?? '',
    fontSize: telemetry?.fontSize ?? '',
    fontWeight: telemetry?.fontWeight ?? '',
    lineHeight: telemetry?.lineHeight === 'normal' ? '' : (telemetry?.lineHeight ?? ''),
    letterSpacing: telemetry?.letterSpacing === 'normal' ? '' : (telemetry?.letterSpacing ?? ''),
    textAlign: telemetry?.textAlign ?? '',
    borderRadius: telemetry?.borderRadius ?? '',
    opacity: telemetry?.opacity ?? '1',
    padding: telemetry?.padding ?? '',
    margin: telemetry?.margin ?? ''
  };
}

function appearanceSwatch(value: string): string | undefined {
  return /^(?:#[a-f0-9]{3,8}|transparent|currentColor|var\(--[a-z][a-z0-9_-]{0,63}\))$/iu.test(
    value
  )
    ? value
    : undefined;
}

/** Read-only renderer context composed from the host snapshot and current trusted spatial selections. */
export function ContextualInspector({
  snapshot,
  selectedArtifactPinId,
  aiTarget,
  aiBusy,
  selectedGraphNodeId,
  hideSnapshotSelection = false,
  selectedPreviewTelemetry,
  prototypeConnection,
  onSelectNode,
  onArtifactApplied,
  manualTextEditor,
  onHandoff
}: ContextualInspectorProps) {
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<'source' | 'css' | 'ai' | 'unavailable'>();
  const [textCapability, setTextCapability] = useState<
    ManualTextEditCapability | ManualTextEditUnavailable | undefined
  >();
  const [textDraft, setTextDraft] = useState('');
  const [textEditStatus, setTextEditStatus] = useState<string>();
  const [textEditBusy, setTextEditBusy] = useState(false);
  const [layoutCapability, setLayoutCapability] = useState<
    ManualLayoutEditCapability | ManualLayoutEditUnavailable | undefined
  >();
  const [layoutDrafts, setLayoutDrafts] = useState<Record<ManualLayoutProperty, string>>(() =>
    manualLayoutDrafts(undefined)
  );
  const [layoutEditStatus, setLayoutEditStatus] = useState<string>();
  const [layoutEditBusy, setLayoutEditBusy] = useState<ManualLayoutProperty>();
  const [appearanceCapability, setAppearanceCapability] = useState<
    ManualAppearanceEditCapability | ManualAppearanceEditUnavailable | undefined
  >();
  const [appearanceDrafts, setAppearanceDrafts] = useState<
    Record<ManualAppearanceProperty, string>
  >(() => manualAppearanceDrafts(undefined));
  const [appearanceTokenIds, setAppearanceTokenIds] = useState<
    Partial<Record<ManualAppearanceProperty, string>>
  >({});
  const [appearanceEditStatus, setAppearanceEditStatus] = useState<string>();
  const [appearanceEditBusy, setAppearanceEditBusy] = useState<ManualAppearanceProperty>();
  const [componentPropertyCapability, setComponentPropertyCapability] = useState<
    | DesignSystemComponentPropertyEditCapability
    | DesignSystemComponentPropertyEditUnavailable
    | undefined
  >();
  const [componentPropertyDrafts, setComponentPropertyDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [componentPropertyEditStatus, setComponentPropertyEditStatus] = useState<string>();
  const [componentPropertyEditBusy, setComponentPropertyEditBusy] = useState<string>();
  const componentPropertyStatusFence = useRef<
    | Readonly<{
        projectId: string;
        nodeId: string;
        revisionId: string;
      }>
    | undefined
  >(undefined);
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
        aiTarget
      }),
    [selectionSnapshot, selectedArtifactPinId, aiTarget]
  );
  const scenario = snapshot.scenarios.find((item) => item.id === snapshot.selectedScenarioId);
  const graphNode = snapshot.editablePrototype.graph.nodes.find(
    (node) => node.id === selectedGraphNodeId
  );
  const sourceNode = selection.node;
  const unmappedTelemetry =
    selectedPreviewTelemetry?.provenance === 'authenticated-preview-unmapped' &&
    snapshot.source.revision.id === selectedPreviewTelemetry.revisionId
      ? selectedPreviewTelemetry.values
      : undefined;
  const mappedTelemetry =
    selectedPreviewTelemetry?.provenance === 'authenticated-preview-node' &&
    sourceNode?.nodeId === selectedPreviewTelemetry.nodeId &&
    snapshot.source.revision.id === selectedPreviewTelemetry.revisionId
      ? selectedPreviewTelemetry.values
      : undefined;
  const authenticatedEditNode =
    selectedPreviewTelemetry?.provenance === 'authenticated-preview-node' &&
    snapshot.source.revision.id === selectedPreviewTelemetry.revisionId
      ? snapshot.nodes.find((node) => node.nodeId === selectedPreviewTelemetry.nodeId)
      : selectedPreviewTelemetry === undefined && snapshot.selectedNodeId !== undefined
        ? snapshot.nodes.find((node) => node.nodeId === snapshot.selectedNodeId)
        : undefined;
  const authenticatedEditTelemetry =
    authenticatedEditNode !== undefined &&
    selectedPreviewTelemetry?.provenance === 'authenticated-preview-node'
      ? selectedPreviewTelemetry.values
      : undefined;
  const telemetry = mappedTelemetry ?? unmappedTelemetry;
  const hasDeveloperSelection =
    sourceNode !== undefined || graphNode !== undefined || unmappedTelemetry !== undefined;
  const selectedName =
    sourceNode?.exportName ??
    (unmappedTelemetry ? `Unmapped ${unmappedTelemetry.semanticTag} element` : undefined) ??
    selection.target?.nodeRef ??
    graphNode?.label;
  const selectedNameForDisplay = safeInspectorValue(selectedName) ?? 'Selected layer';
  const sourceReference = reactSourceReference(sourceNode);
  const computedCss = telemetry ? computedCssSnippet(telemetry) : undefined;
  const sourceNodes = useMemo(
    () => new Map(snapshot.nodes.map((node) => [node.nodeId, node] as const)),
    [snapshot.nodes]
  );
  const renderedHierarchy =
    mappedTelemetry?.hierarchy.map((entry) => {
      const mapped = sourceNodes.get(entry.nodeId);
      return {
        ...entry,
        label: safeInspectorValue(mapped?.exportName) ?? entry.semanticTag,
        sourcePath: safeInspectorValue(mapped?.path)
      };
    }) ?? [];
  const implementationContext =
    sourceReference ??
    'React source reference unavailable: the current selection has no safe host-confirmed mapping.';
  const aiContext = devModeAiClipboard({
    selectionLabel: selectedNameForDisplay,
    sourceReference,
    revisionId:
      telemetry && selectedPreviewTelemetry ? selectedPreviewTelemetry.revisionId : undefined,
    computedCss
  });
  const copy = async (kind: 'source' | 'css' | 'ai', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied('unavailable');
    }
  };
  const selectionName =
    selection.node?.exportName ??
    (unmappedTelemetry ? `Unmapped ${unmappedTelemetry.semanticTag} element` : undefined) ??
    (selection.target ? 'Spatial selection' : 'No selection');
  const hasMatch = (values: readonly (string | undefined)[]) =>
    isInspectorSearchMatch(query, values);
  const selectionMatches = hasMatch([
    selectionName,
    selection.node?.path,
    selection.target?.nodeRef,
    selection.targetOrigin,
    ...renderedHierarchy.flatMap((entry) => [
      entry.nodeId,
      entry.semanticTag,
      entry.label,
      entry.sourcePath
    ])
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
    hasMatch([
      entry.component,
      entry.href,
      ...(entry.slots ?? []).flatMap((slot) => [
        slot.id,
        slot.label,
        ...(slot.accepts ?? []).map((accepted) => accepted.exportName)
      ])
    ])
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
    if (!unmappedTelemetry && selection.target)
      onHandoff(mode, selection.target, event.currentTarget);
  };

  const textCapabilityNodeId = authenticatedEditNode?.nodeId;
  useEffect(() => {
    let cancelled = false;
    setTextCapability(undefined);
    setTextDraft('');
    setTextEditStatus(undefined);
    if (textCapabilityNodeId === undefined)
      return () => {
        cancelled = true;
      };
    void manualTextEditor
      .requestManualTextEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: textCapabilityNodeId,
        revisionId: snapshot.source.revision.id
      })
      .then((capability) => {
        if (cancelled) return;
        setTextCapability(capability);
        if (capability.kind === 'available') setTextDraft(capability.currentContent);
      })
      .catch(() => {
        if (!cancelled) setTextCapability({ kind: 'unavailable', code: 'MANUAL_EDIT_UNAVAILABLE' });
      });
    return () => {
      cancelled = true;
    };
  }, [
    manualTextEditor,
    snapshot.source.projectId,
    snapshot.source.revision.id,
    textCapabilityNodeId
  ]);

  useEffect(() => {
    let cancelled = false;
    setLayoutCapability(undefined);
    setLayoutEditStatus(undefined);
    setLayoutDrafts(manualLayoutDrafts(authenticatedEditTelemetry));
    if (textCapabilityNodeId === undefined)
      return () => {
        cancelled = true;
      };
    void manualTextEditor
      .requestManualLayoutEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: textCapabilityNodeId,
        revisionId: snapshot.source.revision.id
      })
      .then((capability) => {
        if (cancelled) return;
        setLayoutCapability(capability);
        if (capability.kind === 'available')
          setLayoutDrafts((current) => {
            const next = { ...current };
            for (const property of capability.properties) {
              const value = capability.currentValues[property];
              if (value !== undefined) next[property] = String(value);
            }
            return next;
          });
      })
      .catch(() => {
        if (!cancelled)
          setLayoutCapability({ kind: 'unavailable', code: 'MANUAL_EDIT_UNAVAILABLE' });
      });
    return () => {
      cancelled = true;
    };
  }, [
    manualTextEditor,
    authenticatedEditTelemetry,
    snapshot.source.projectId,
    snapshot.source.revision.id,
    textCapabilityNodeId
  ]);

  useEffect(() => {
    let cancelled = false;
    setAppearanceCapability(undefined);
    setAppearanceEditStatus(undefined);
    setAppearanceTokenIds({});
    setAppearanceDrafts(manualAppearanceDrafts(authenticatedEditTelemetry));
    if (textCapabilityNodeId === undefined)
      return () => {
        cancelled = true;
      };
    void manualTextEditor
      .requestManualAppearanceEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: textCapabilityNodeId,
        revisionId: snapshot.source.revision.id
      })
      .then((capability) => {
        if (cancelled) return;
        setAppearanceCapability(capability);
        if (capability.kind === 'available')
          setAppearanceDrafts((current) => {
            const next = { ...current };
            for (const property of capability.properties) {
              const value = capability.currentValues[property];
              if (value !== undefined) next[property] = String(value);
            }
            return next;
          });
        if (capability.kind === 'available')
          setAppearanceTokenIds(() => {
            const selected: Partial<Record<ManualAppearanceProperty, string>> = {};
            for (const property of capability.properties) {
              const value = capability.currentValues[property];
              if (typeof value !== 'string') continue;
              const matches = capability.tokens.filter(
                (token) =>
                  token.value === value &&
                  token.properties.some((supported) => supported === property)
              );
              if (matches.length === 1) selected[property] = matches[0]!.tokenId;
            }
            return selected;
          });
      })
      .catch(() => {
        if (!cancelled)
          setAppearanceCapability({ kind: 'unavailable', code: 'MANUAL_EDIT_UNAVAILABLE' });
      });
    return () => {
      cancelled = true;
    };
  }, [
    manualTextEditor,
    authenticatedEditTelemetry,
    snapshot.source.projectId,
    snapshot.source.revision.id,
    textCapabilityNodeId
  ]);

  useEffect(() => {
    let cancelled = false;
    setComponentPropertyCapability(undefined);
    setComponentPropertyDrafts({});
    const statusFence = componentPropertyStatusFence.current;
    const preserveStatus =
      statusFence !== undefined &&
      statusFence.projectId === snapshot.source.projectId &&
      statusFence.nodeId === textCapabilityNodeId &&
      statusFence.revisionId === snapshot.source.revision.id;
    if (!preserveStatus) setComponentPropertyEditStatus(undefined);
    if (textCapabilityNodeId === undefined)
      return () => {
        cancelled = true;
      };
    void manualTextEditor
      .requestDesignSystemComponentPropertyEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: textCapabilityNodeId,
        revisionId: snapshot.source.revision.id
      })
      .then((capability) => {
        if (cancelled) return;
        setComponentPropertyCapability(capability);
        if (capability.kind === 'available') {
          const drafts: Record<string, string> = {};
          for (const property of capability.properties) {
            const value =
              capability.currentValues[property.name] ??
              property.defaultValue ??
              (property.control === 'boolean'
                ? false
                : property.control === 'number'
                  ? 0
                  : property.control === 'select'
                    ? property.values?.[0]
                    : '');
            if (value !== undefined) drafts[property.name] = String(value);
          }
          setComponentPropertyDrafts(Object.freeze(drafts));
        }
      })
      .catch(() => {
        if (!cancelled)
          setComponentPropertyCapability({
            kind: 'unavailable',
            code: 'MANUAL_EDIT_UNAVAILABLE'
          });
      });
    return () => {
      cancelled = true;
    };
  }, [
    manualTextEditor,
    snapshot.source.projectId,
    snapshot.source.revision.id,
    textCapabilityNodeId
  ]);

  const applyTextEdit = async () => {
    if (textCapability?.kind !== 'available' || textEditBusy) return;
    setTextEditBusy(true);
    setTextEditStatus(undefined);
    try {
      const result = await manualTextEditor.applyManualTextEdit({
        format: 'selene-desktop-manual-text-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: textCapability.capabilityId,
        content: textDraft
      });
      if (result.kind === 'applied' || result.kind === 'replayed') {
        const successStatus =
          result.kind === 'applied'
            ? 'Text updated in the React artifact.'
            : 'Text update replayed.';
        setTextEditStatus(successStatus);
        const next = await manualTextEditor.snapshot();
        try {
          await onArtifactApplied(next, successStatus);
        } catch {
          setTextEditStatus('Text was saved, but the compiled preview could not refresh.');
        }
      } else {
        setTextEditStatus(`Text was not updated: ${result.diagnostics[0]?.code ?? 'unavailable'}.`);
      }
    } catch {
      setTextEditStatus('Text update is unavailable. Refresh the selection and try again.');
    } finally {
      setTextEditBusy(false);
    }
  };

  const applyLayoutEdit = async (property: ManualLayoutProperty) => {
    if (layoutCapability?.kind !== 'available' || layoutEditBusy !== undefined) return;
    setLayoutEditBusy(property);
    setLayoutEditStatus(undefined);
    try {
      const result = await manualTextEditor.applyManualLayoutEdit({
        format: 'selene-desktop-manual-layout-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: layoutCapability.capabilityId,
        property,
        value: (property === 'order'
          ? Number(layoutDrafts[property])
          : layoutDrafts[property]) satisfies ManualLayoutValue
      });
      if (result.kind === 'applied' || result.kind === 'replayed') {
        const successStatus =
          result.kind === 'applied'
            ? `${property} updated in the React artifact.`
            : `${property} update replayed.`;
        setLayoutEditStatus(successStatus);
        const next = await manualTextEditor.snapshot();
        try {
          await onArtifactApplied(next, successStatus);
        } catch {
          setLayoutEditStatus(`${property} was saved, but the compiled preview could not refresh.`);
        }
      } else {
        setLayoutEditStatus(
          `Layout was not updated: ${result.diagnostics[0]?.code ?? 'unavailable'}.`
        );
      }
    } catch {
      setLayoutEditStatus('Layout editing is unavailable. Refresh the selection and try again.');
    } finally {
      setLayoutEditBusy(undefined);
    }
  };

  const applyAppearanceEdit = async (property: ManualAppearanceProperty) => {
    if (appearanceCapability?.kind !== 'available' || appearanceEditBusy !== undefined) return;
    setAppearanceEditBusy(property);
    setAppearanceEditStatus(undefined);
    try {
      const value = (
        property === 'opacity' || property === 'fontWeight'
          ? Number(appearanceDrafts[property])
          : appearanceDrafts[property]
      ) satisfies ManualAppearanceValue;
      const result = await manualTextEditor.applyManualAppearanceEdit({
        format: 'selene-desktop-manual-appearance-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: appearanceCapability.capabilityId,
        property,
        value,
        ...(appearanceTokenIds[property] === undefined
          ? {}
          : { tokenId: appearanceTokenIds[property] })
      });
      if (result.kind === 'applied' || result.kind === 'replayed') {
        const label = manualAppearanceLabel(property);
        const successStatus =
          result.kind === 'applied'
            ? `${label} updated in the React artifact.`
            : `${label} update replayed.`;
        setAppearanceEditStatus(successStatus);
        const next = await manualTextEditor.snapshot();
        try {
          await onArtifactApplied(next, successStatus);
        } catch {
          setAppearanceEditStatus(
            `${label} was saved, but the compiled preview could not refresh.`
          );
        }
      } else {
        setAppearanceEditStatus(
          `Appearance was not updated: ${result.diagnostics[0]?.code ?? 'unavailable'}.`
        );
      }
    } catch {
      setAppearanceEditStatus(
        'Appearance editing is unavailable. Refresh the selection and try again.'
      );
    } finally {
      setAppearanceEditBusy(undefined);
    }
  };

  const applyComponentPropertyEdit = async (propertyName: string) => {
    if (
      componentPropertyCapability?.kind !== 'available' ||
      componentPropertyEditBusy !== undefined
    )
      return;
    const property = componentPropertyCapability.properties.find(
      (candidate) => candidate.name === propertyName
    );
    const draft = componentPropertyDrafts[propertyName];
    if (property === undefined || draft === undefined) return;
    const value: DesignSystemComponentPropertyValue =
      property.control === 'boolean'
        ? draft === 'true'
        : property.control === 'number'
          ? Number(draft)
          : property.control === 'select'
            ? (property.values?.find((candidate) => String(candidate) === draft) ?? draft)
            : draft;
    setComponentPropertyEditBusy(propertyName);
    setComponentPropertyEditStatus(undefined);
    try {
      const result = await manualTextEditor.applyDesignSystemComponentPropertyEdit({
        format: 'selene-desktop-design-system-component-property-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: componentPropertyCapability.capabilityId,
        property: propertyName,
        value
      });
      if (result.kind === 'applied' || result.kind === 'replayed') {
        const successStatus =
          result.kind === 'applied'
            ? `${property.label} updated in the React artifact.`
            : `${property.label} update replayed.`;
        setComponentPropertyEditStatus(successStatus);
        const next = await manualTextEditor.snapshot();
        componentPropertyStatusFence.current = Object.freeze({
          projectId: next.source.projectId,
          nodeId: componentPropertyCapability.nodeId,
          revisionId: next.source.revision.id
        });
        try {
          await onArtifactApplied(next, successStatus);
        } catch {
          setComponentPropertyEditStatus(
            `${property.label} was saved, but the compiled preview could not refresh.`
          );
        }
      } else {
        setComponentPropertyEditStatus(
          `Component property was not updated: ${result.diagnostics[0]?.code ?? 'unavailable'}.`
        );
      }
    } catch {
      setComponentPropertyEditStatus(
        'Component property editing is unavailable. Refresh the selection and try again.'
      );
    } finally {
      setComponentPropertyEditBusy(undefined);
    }
  };

  return (
    <section
      id="inspector-inspect"
      role="tabpanel"
      aria-labelledby="inspector-tab-inspect"
      className="contextual-inspector guided-setup review-panel review-handoff-panel"
    >
      <header className="review-panel__header">
        <p className="conversation-history__eyebrow">Design · Inspect</p>
        <h2>{selectedNameForDisplay}</h2>
        <p>Edit supported properties, inspect computed values, and hand off React context.</p>
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
                <strong>{selectedNameForDisplay}</strong>
                <small>
                  {sourceNode
                    ? (safeInspectorValue(`${sourceNode.path} · ${sourceNode.nodeId}`) ??
                      'Source reference withheld')
                    : graphNode
                      ? (safeInspectorValue(`${graphNode.kind} frame · ${graphNode.id}`) ??
                        'Frame reference withheld')
                      : 'Selected layer'}
                </small>
              </div>
              <span className="dev-inspector__status">
                {unmappedTelemetry
                  ? 'Rendered DOM'
                  : telemetry
                    ? 'Frame-verified rendered DOM'
                    : 'Frame context'}
              </span>
            </div>
            {renderedHierarchy.length > 0 ? (
              <nav className="dev-inspector__hierarchy" aria-label="Rendered React hierarchy">
                <span className="dev-inspector__hierarchy-project">
                  {safeInspectorValue(snapshot.source.projectId) ?? 'Project'}
                </span>
                <ol>
                  {renderedHierarchy.map((entry, index) => {
                    const current = entry.nodeId === sourceNode?.nodeId;
                    return (
                      <li key={`${entry.nodeId}:${index}`}>
                        <span aria-hidden="true">›</span>
                        <button
                          type="button"
                          aria-current={current ? 'true' : undefined}
                          disabled={current}
                          title={
                            entry.sourcePath
                              ? `${entry.sourcePath} · ${entry.nodeId}`
                              : `${entry.semanticTag} · ${entry.nodeId}`
                          }
                          onClick={() => onSelectNode(entry.nodeId)}
                        >
                          <strong>{entry.label}</strong>
                          <small>
                            {entry.semanticTag} · {entry.nodeId}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>
            ) : (
              <div className="dev-inspector__breadcrumb" aria-label="Source selection">
                <span>{safeInspectorValue(snapshot.source.projectId) ?? 'Project'}</span>
                <b aria-hidden="true">›</b>
                <strong>
                  {safeInspectorValue(sourceNode?.path ?? graphNode?.label) ??
                    selectedNameForDisplay}
                </strong>
              </div>
            )}
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
                <DetailRow label="Design tokens" value={designTokenSummary(appearanceCapability)} />
              </dl>
            </details>
            {mappedTelemetry ? (
              <details open>
                <summary>Accessibility</summary>
                <dl className="dev-inspector__grid">
                  <DetailRow
                    label="Semantic HTML tag"
                    value={telemetry?.semanticTag ?? 'Not reported by authenticated preview'}
                  />
                  <DetailRow
                    label="Explicit ARIA role"
                    value={mappedTelemetry.explicitAriaRole || 'No explicit role attribute'}
                  />
                  <DetailRow
                    label="Computed accessible name"
                    value="Unavailable — browser accessibility tree is not exposed to this preview"
                  />
                  <DetailRow
                    label="Explicit ARIA label"
                    value={mappedTelemetry.ariaLabel || 'No explicit aria-label attribute'}
                  />
                  <DetailRow
                    label="Explicit description"
                    value={
                      mappedTelemetry.accessibleDescription ||
                      'No aria-description or title attribute'
                    }
                  />
                  <DetailRow
                    label="ARIA states"
                    value={
                      [
                        ['disabled', mappedTelemetry.ariaDisabled],
                        ['expanded', mappedTelemetry.ariaExpanded],
                        ['pressed', mappedTelemetry.ariaPressed],
                        ['checked', mappedTelemetry.ariaChecked],
                        ['selected', mappedTelemetry.ariaSelected],
                        ['hidden', mappedTelemetry.ariaHidden]
                      ]
                        .filter((entry) => entry[1])
                        .map((entry) => `${entry[0]}=${entry[1]}`)
                        .join(' · ') || 'No explicit ARIA state attributes'
                    }
                  />
                  <DetailRow label="Tab index" value={String(mappedTelemetry.tabIndex)} />
                </dl>
              </details>
            ) : null}
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
                    unmappedTelemetry
                      ? 'Unavailable — unmapped preview elements cannot resolve catalog provenance'
                      : selection.catalogEntry
                        ? `${selection.catalogEntry.component} · ${selection.catalogEntry.href}`
                        : 'Unavailable — no catalog match'
                  }
                />
                <DetailRow
                  label="Telemetry provenance"
                  value={
                    unmappedTelemetry
                      ? 'Frame-verified rendered DOM · ephemeral unmapped element'
                      : selectedPreviewTelemetry && telemetry
                        ? `Frame-verified rendered DOM · ${selectedPreviewTelemetry.revisionId}`
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
            {layoutCapability?.kind === 'available' ? (
              <section
                className="dev-inspector__manual-text dev-inspector__manual-layout"
                aria-label="Manual React layout edit"
              >
                <div>
                  <p className="conversation-history__eyebrow">Design controls</p>
                  <strong>Frame & auto layout</strong>
                  <small>
                    Tune the mapped React element without leaving the canvas. Every value is
                    compiled, versioned, and reversible—not patched into the preview DOM.
                  </small>
                </div>
                {manualLayoutGroups.map((group) => (
                  <section className="dev-inspector__layout-group" key={group.label}>
                    <header>
                      <span>{group.label}</span>
                      <small>
                        {group.label === 'Frame'
                          ? 'CSS units or auto'
                          : 'Flex, grid, alignment, and order'}
                      </small>
                    </header>
                    <div className="dev-inspector__layout-grid">
                      {group.properties
                        .filter((property) => layoutCapability.properties.includes(property))
                        .map((property) => {
                          const choices = manualLayoutChoices(property);
                          return (
                            <form
                              key={property}
                              onSubmit={(event) => {
                                event.preventDefault();
                                void applyLayoutEdit(property);
                              }}
                            >
                              <label>
                                <span>{manualLayoutLabel(property)}</span>
                                {choices ? (
                                  <select
                                    value={layoutDrafts[property]}
                                    aria-describedby={`manual-layout-hint-${property}`}
                                    onChange={(event) =>
                                      setLayoutDrafts((current) => ({
                                        ...current,
                                        [property]: event.target.value
                                      }))
                                    }
                                  >
                                    <option value="">Choose…</option>
                                    {choices.map((value) => (
                                      <option value={value} key={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    value={layoutDrafts[property]}
                                    maxLength={128}
                                    inputMode={property === 'order' ? 'numeric' : 'text'}
                                    spellCheck={false}
                                    aria-describedby={`manual-layout-hint-${property}`}
                                    onChange={(event) =>
                                      setLayoutDrafts((current) => ({
                                        ...current,
                                        [property]: event.target.value
                                      }))
                                    }
                                  />
                                )}
                              </label>
                              <button
                                type="submit"
                                disabled={
                                  layoutEditBusy !== undefined ||
                                  layoutDrafts[property].length === 0
                                }
                                aria-label={`Apply ${property}`}
                              >
                                {layoutEditBusy === property ? 'Applying…' : 'Apply'}
                              </button>
                              <small id={`manual-layout-hint-${property}`}>
                                {choices
                                  ? 'Authored inline style'
                                  : property === 'order'
                                    ? '0–1000'
                                    : 'px, rem, %, vw, vh, or auto'}
                              </small>
                            </form>
                          );
                        })}
                    </div>
                  </section>
                ))}
                {layoutEditStatus ? <output role="status">{layoutEditStatus}</output> : null}
              </section>
            ) : layoutCapability?.kind === 'unavailable' && textCapabilityNodeId ? (
              <p className="dev-inspector__manual-text-unavailable" role="status">
                Direct layout controls are unavailable for this mapped element.
              </p>
            ) : null}
            {componentPropertyCapability?.kind === 'available' ? (
              <section
                className="dev-inspector__manual-text dev-inspector__component-properties"
                aria-label="Design-system component properties"
              >
                <div>
                  <p className="conversation-history__eyebrow">Component</p>
                  <strong>{componentPropertyCapability.componentName}</strong>
                  <small>
                    {componentPropertyCapability.component.packageName}@
                    {componentPropertyCapability.component.version} · declared package controls
                  </small>
                </div>
                <div className="dev-inspector__layout-grid">
                  {componentPropertyCapability.properties.map((property) => {
                    const draft = componentPropertyDrafts[property.name] ?? '';
                    const choices =
                      property.control === 'boolean'
                        ? (['true', 'false'] as const)
                        : property.control === 'select'
                          ? (property.values ?? []).map(String)
                          : undefined;
                    return (
                      <form
                        key={property.name}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void applyComponentPropertyEdit(property.name);
                        }}
                      >
                        <label>
                          <span>{property.label}</span>
                          {choices ? (
                            <select
                              value={draft}
                              aria-label={property.label}
                              aria-describedby={`component-property-hint-${property.name}`}
                              onChange={(event) =>
                                setComponentPropertyDrafts((current) =>
                                  Object.freeze({
                                    ...current,
                                    [property.name]: event.target.value
                                  })
                                )
                              }
                            >
                              {choices.map((choice) => (
                                <option value={choice} key={choice}>
                                  {choice}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              value={draft}
                              aria-label={property.label}
                              type={property.control === 'number' ? 'number' : 'text'}
                              maxLength={property.control === 'text' ? 256 : undefined}
                              required={property.required === true}
                              onChange={(event) =>
                                setComponentPropertyDrafts((current) =>
                                  Object.freeze({
                                    ...current,
                                    [property.name]: event.target.value
                                  })
                                )
                              }
                            />
                          )}
                        </label>
                        <button
                          type="submit"
                          disabled={
                            componentPropertyEditBusy !== undefined ||
                            (property.required === true && draft.length === 0)
                          }
                          aria-label={`Apply ${property.label}`}
                        >
                          {componentPropertyEditBusy === property.name ? 'Applying…' : 'Apply'}
                        </button>
                        <small id={`component-property-hint-${property.name}`}>
                          {property.required === true ? 'Required' : 'Optional'}
                          {property.defaultValue === undefined
                            ? ''
                            : ` · default ${String(property.defaultValue)}`}
                        </small>
                      </form>
                    );
                  })}
                </div>
                {componentPropertyEditStatus ? (
                  <output className="dev-inspector__edit-status" role="status">
                    {componentPropertyEditStatus}
                  </output>
                ) : null}
              </section>
            ) : null}
            {appearanceCapability?.kind === 'available' ? (
              <section
                className="dev-inspector__manual-text dev-inspector__manual-appearance"
                aria-label="Manual React appearance edit"
              >
                <div>
                  <p className="conversation-history__eyebrow">Appearance</p>
                  <strong>Fill, type & spacing</strong>
                  <small>
                    Edit approved visual properties on the selected React layer. Values flow through
                    the source compiler and design revision history.
                  </small>
                </div>
                {manualAppearanceGroups.map((group) => (
                  <section className="dev-inspector__layout-group" key={group.label}>
                    <header>
                      <span>{group.label}</span>
                      <small>{group.hint}</small>
                    </header>
                    <div className="dev-inspector__layout-grid">
                      {group.properties
                        .filter((property) => appearanceCapability.properties.includes(property))
                        .map((property) => {
                          const choices = manualAppearanceChoices(property);
                          const isColor = property === 'color' || property === 'backgroundColor';
                          const color = isColor
                            ? appearanceSwatch(appearanceDrafts[property])
                            : undefined;
                          const tokens = appearanceCapability.tokens.filter((token) =>
                            token.properties.some((supported) => supported === property)
                          );
                          return (
                            <form
                              key={property}
                              onSubmit={(event) => {
                                event.preventDefault();
                                void applyAppearanceEdit(property);
                              }}
                            >
                              <label>
                                <span>{manualAppearanceLabel(property)}</span>
                                {tokens.length > 0 ? (
                                  <select
                                    aria-label={`Design token for ${manualAppearanceLabel(property)}`}
                                    value={appearanceTokenIds[property] ?? ''}
                                    onChange={(event) => {
                                      const token = tokens.find(
                                        (candidate) => candidate.tokenId === event.target.value
                                      );
                                      setAppearanceTokenIds((current) => {
                                        const next = { ...current };
                                        if (token === undefined) delete next[property];
                                        else next[property] = token.tokenId;
                                        return next;
                                      });
                                      setAppearanceDrafts((current) => ({
                                        ...current,
                                        [property]: token?.value ?? ''
                                      }));
                                    }}
                                  >
                                    <option value="">Custom value</option>
                                    {tokens.map((token) => (
                                      <option value={token.tokenId} key={token.tokenId}>
                                        {token.label} · {token.packageName}@{token.version}
                                      </option>
                                    ))}
                                  </select>
                                ) : null}
                                {choices ? (
                                  <select
                                    value={appearanceDrafts[property]}
                                    aria-describedby={`manual-appearance-hint-${property}`}
                                    onChange={(event) => {
                                      setAppearanceTokenIds((current) => {
                                        const next = { ...current };
                                        delete next[property];
                                        return next;
                                      });
                                      setAppearanceDrafts((current) => ({
                                        ...current,
                                        [property]: event.target.value
                                      }));
                                    }}
                                  >
                                    <option value="">Choose…</option>
                                    {choices.map((value) => (
                                      <option value={value} key={value}>
                                        {value}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span
                                    className="dev-inspector__appearance-input"
                                    data-color={
                                      isColor && appearanceTokenIds[property] === undefined
                                        ? 'true'
                                        : undefined
                                    }
                                  >
                                    {isColor && appearanceTokenIds[property] === undefined ? (
                                      <input
                                        className="dev-inspector__color-picker"
                                        type="color"
                                        aria-label={`Choose ${manualAppearanceLabel(property).toLowerCase()} color`}
                                        value={
                                          /^#[a-f0-9]{6}$/iu.test(color ?? '') ? color : '#000000'
                                        }
                                        onChange={(event) => {
                                          setAppearanceTokenIds((current) => {
                                            const next = { ...current };
                                            delete next[property];
                                            return next;
                                          });
                                          setAppearanceDrafts((current) => ({
                                            ...current,
                                            [property]: event.target.value
                                          }));
                                        }}
                                      />
                                    ) : null}
                                    <input
                                      value={appearanceDrafts[property]}
                                      maxLength={128}
                                      type={property === 'opacity' ? 'number' : 'text'}
                                      min={property === 'opacity' ? 0 : undefined}
                                      max={property === 'opacity' ? 1 : undefined}
                                      step={property === 'opacity' ? 0.05 : undefined}
                                      spellCheck={false}
                                      aria-describedby={`manual-appearance-hint-${property}`}
                                      onChange={(event) => {
                                        setAppearanceTokenIds((current) => {
                                          const next = { ...current };
                                          delete next[property];
                                          return next;
                                        });
                                        setAppearanceDrafts((current) => ({
                                          ...current,
                                          [property]: event.target.value
                                        }));
                                      }}
                                    />
                                  </span>
                                )}
                              </label>
                              <button
                                type="submit"
                                disabled={
                                  appearanceEditBusy !== undefined ||
                                  appearanceDrafts[property].length === 0
                                }
                                aria-label={`Apply ${property}`}
                              >
                                {appearanceEditBusy === property ? 'Applying…' : 'Apply'}
                              </button>
                              <small id={`manual-appearance-hint-${property}`}>
                                {isColor
                                  ? 'Hex, currentColor, transparent, or design token'
                                  : property === 'padding' || property === 'margin'
                                    ? 'px, rem, em, %, auto, or design token'
                                    : property === 'fontFamily'
                                      ? 'Font stack'
                                      : property === 'opacity'
                                        ? '0–1'
                                        : choices
                                          ? 'Source-backed value'
                                          : 'px, rem, em, unitless, or design token'}
                              </small>
                            </form>
                          );
                        })}
                    </div>
                  </section>
                ))}
                {appearanceEditStatus ? (
                  <output className="dev-inspector__edit-status" role="status">
                    {appearanceEditStatus}
                  </output>
                ) : null}
              </section>
            ) : appearanceCapability?.kind === 'unavailable' && textCapabilityNodeId ? (
              <p className="dev-inspector__manual-text-unavailable" role="status">
                Direct appearance controls are unavailable for this mapped element.
              </p>
            ) : null}
            {textCapability?.kind === 'available' ? (
              <section className="dev-inspector__manual-text" aria-label="Manual React text edit">
                <div>
                  <p className="conversation-history__eyebrow">Direct text</p>
                  <strong>Update this mapped JSX text node</strong>
                  <small>
                    Changes are compiled and committed atomically before the preview updates.
                  </small>
                </div>
                <label>
                  <span>Rendered text</span>
                  <textarea
                    value={textDraft}
                    maxLength={textCapability.maxLength}
                    rows={3}
                    onChange={(event) => setTextDraft(event.target.value)}
                  />
                </label>
                <div className="dev-inspector__manual-text-actions">
                  <button
                    type="button"
                    disabled={textEditBusy || textDraft === textCapability.currentContent}
                    onClick={() => void applyTextEdit()}
                  >
                    {textEditBusy ? 'Applying…' : 'Apply text'}
                  </button>
                  <small>Expires {new Date(textCapability.expiresAt).toLocaleTimeString()}.</small>
                </div>
                {textEditStatus ? <output role="status">{textEditStatus}</output> : null}
              </section>
            ) : textCapability?.kind === 'unavailable' && textCapabilityNodeId ? (
              <p className="dev-inspector__manual-text-unavailable" role="status">
                Direct text editing is unavailable for this mapped element. JSX expressions and
                nested content remain read-only.
              </p>
            ) : null}
            <div
              className="dev-inspector__copy"
              role="group"
              aria-label="Copy developer handoff values"
            >
              <button
                type="button"
                disabled={sourceReference === undefined}
                onClick={() => void copy('source', implementationContext)}
              >
                Copy React reference
              </button>
              <button
                type="button"
                disabled={computedCss === undefined}
                onClick={() => computedCss && void copy('css', computedCss)}
              >
                Copy computed CSS
              </button>
              <button type="button" onClick={() => void copy('ai', aiContext)}>
                Copy for AI
              </button>
              <output className="dev-inspector__provenance" role="status">
                {unmappedTelemetry
                  ? 'Frame-verified rendered DOM · no source mapping or edit authority.'
                  : telemetry && selectedPreviewTelemetry
                    ? `Frame-verified rendered DOM · revision ${safeInspectorValue(selectedPreviewTelemetry.revisionId) ?? 'withheld'}`
                    : 'No authenticated rendered selection is available to copy.'}
              </output>
              {copied ? (
                <output role="status">
                  {copied === 'unavailable'
                    ? 'Clipboard unavailable in this renderer session'
                    : copied === 'ai'
                      ? 'AI context copied'
                      : copied === 'css'
                        ? 'Computed CSS copied'
                        : 'React reference copied'}
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
            {selection.node || selection.target || unmappedTelemetry ? (
              <dl className="review-thread-list">
                <DetailRow label="Identity" value={selectionName} />
                {unmappedTelemetry ? (
                  <DetailRow
                    label="Source mapping"
                    value="Unavailable — this rendered element has no authored Selene marker"
                  />
                ) : null}
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
                    {(entry.slots ?? []).map((slot) => (
                      <small key={slot.id}>
                        Slot: {slot.label} · {slot.minItems ?? 0}–{slot.maxItems ?? 'many'} ·{' '}
                        {slot.accepts?.map((accepted) => accepted.exportName).join(', ') ??
                          'any mapped component'}
                      </small>
                    ))}
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
                disabled={unmappedTelemetry !== undefined || !selection.target || aiBusy}
                onClick={(event) => handoff('ai', event)}
              >
                Use in AI edit
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
