import type { DesignerSnapshot, SpatialTargetInput } from '../../../shared/designer-api';
import type {
  PreviewElementTelemetry,
  PreviewUnmappedElementTelemetry
} from '../../../shared/preview-channel';

const withheldInspectorValue = 'Unavailable — unsafe preview value was withheld';

/**
 * Preview telemetry is trustworthy only for selection identity, not for arbitrary
 * display strings. Keep developer-facing values data-only: no paths, URLs,
 * control sequences, executable CSS, or provider/host details can cross this
 * boundary into the inspector or clipboard.
 */
export function safeInspectorValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const compact = value.replace(/\s+/gu, ' ').trim();
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    compact.length === 0 ||
    compact.length > 512 ||
    hasControlCharacter ||
    /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|\\\\)/u.test(compact) ||
    /(?:https?|file|ssh|git|wss?):\/\//iu.test(compact) ||
    /\b(?:api[ _-]?key|access[ _-]?token|authorization|provider|endpoint|model[ _-]?id)\b/iu.test(
      compact
    ) ||
    /(?:url\s*\(|@import|expression\s*\(|javascript:|[;{}]|<\/)/iu.test(compact)
  )
    return undefined;
  return compact;
}

/** Bounded computed CSS is useful handoff evidence, never authored source. */
export function computedCssSnippet(
  values: PreviewElementTelemetry | PreviewUnmappedElementTelemetry
): string | undefined {
  const pixels = (value: number): string | undefined =>
    Number.isFinite(value) && value >= 0 && value <= 100_000
      ? `${Math.round(value * 100) / 100}px`
      : undefined;
  const width = pixels(values.width);
  const height = pixels(values.height);
  if (width === undefined || height === undefined) return undefined;
  const declarations: readonly [string, string][] = [
    ['width', width],
    ['height', height],
    ['display', values.display],
    ['position', values.position],
    ['box-sizing', values.boxSizing],
    ['margin', values.margin],
    ['padding', values.padding],
    ['gap', values.gap],
    ['flex-direction', values.flexDirection],
    ['align-items', values.alignItems],
    ['justify-content', values.justifyContent],
    ['grid-template-columns', values.gridTemplateColumns],
    ['grid-template-rows', values.gridTemplateRows],
    ['font-family', values.fontFamily],
    ['font-size', values.fontSize],
    ['font-weight', values.fontWeight],
    ['line-height', values.lineHeight],
    ['letter-spacing', values.letterSpacing],
    ['color', values.color],
    ['background-color', values.backgroundColor],
    ['border', values.border],
    ['border-radius', values.borderRadius],
    ['box-shadow', values.boxShadow],
    ['opacity', values.opacity]
  ];
  const safe = declarations.map(([property, value]) => {
    const inspected = safeInspectorValue(value);
    return inspected === undefined ? undefined : `  ${property}: ${inspected};`;
  });
  if (safe.some((value) => value === undefined)) return undefined;
  return `/* Computed from the authenticated rendered selection; not authored source. */\n.selected-element {\n${safe.join(
    '\n'
  )}\n}`;
}

/** Only a project-relative source identity may be copied as a React handoff reference. */
export function reactSourceReference(
  node: DesignerSnapshot['nodes'][number] | undefined
): string | undefined {
  if (node === undefined) return undefined;
  const path = safeInspectorValue(node.path);
  const exportName = safeInspectorValue(node.exportName);
  if (
    path === undefined ||
    exportName === undefined ||
    !/^(?:apps|packages|src)\/[A-Za-z0-9@._/-]+\.(?:[cm]?[jt]sx?)$/u.test(path) ||
    path.includes('..') ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exportName)
  )
    return undefined;
  return `// Host-confirmed React reference\n// Component: ${exportName}\n// Source: ${path}`;
}

/**
 * The AI clipboard carries only selection-bound handoff evidence. It deliberately
 * omits review anchors, baseline records, catalog URLs, runtime state, and host
 * status because those are not needed to describe a rendered element safely.
 */
export function devModeAiClipboard({
  selectionLabel,
  sourceReference,
  revisionId,
  computedCss
}: {
  readonly selectionLabel: string;
  readonly sourceReference: string | undefined;
  readonly revisionId: string | undefined;
  readonly computedCss: string | undefined;
}): string {
  const label = safeInspectorValue(selectionLabel) ?? withheldInspectorValue;
  const revision = safeInspectorValue(revisionId);
  const safeReference =
    sourceReference !== undefined &&
    /^\/\/ Host-confirmed React reference\n\/\/ Component: [A-Za-z_$][A-Za-z0-9_$]*\n\/\/ Source: (?:apps|packages|src)\/[A-Za-z0-9@._/-]+\.(?:[cm]?[jt]sx?)$/u.test(
      sourceReference
    )
      ? sourceReference
      : undefined;
  const safeCss =
    computedCss !== undefined &&
    computedCss.startsWith(
      '/* Computed from the authenticated rendered selection; not authored source. */\n.selected-element {\n'
    ) &&
    computedCss.endsWith('\n}') &&
    computedCss.length <= 4_000 &&
    !Array.from(computedCss).some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 31 && code !== 10) || code === 127;
    }) &&
    !/(?:url\s*\(|@import|expression\s*\(|javascript:|(?:https?|file|ssh|git|wss?):\/\/)/iu.test(
      computedCss
    )
      ? computedCss
      : undefined;
  return JSON.stringify(
    {
      kind: 'selene-dev-mode-selection/v1',
      selection: {
        label,
        reactReference: safeReference ?? 'Unavailable — no safe host-confirmed React mapping'
      },
      preview:
        safeCss === undefined || revision === undefined
          ? 'Unavailable — no safe authenticated computed preview evidence'
          : {
              provenance: 'authenticated-preview',
              revisionId: revision,
              computedCss: safeCss
            }
    },
    null,
    2
  );
}

export { withheldInspectorValue };

export interface InspectorSelection {
  readonly node?: DesignerSnapshot['nodes'][number];
  readonly target?: SpatialTargetInput;
  readonly targetOrigin?: 'review pin' | 'AI target' | 'review target';
  readonly catalogEntry?: DesignerSnapshot['componentCatalog']['entries'][number];
}

export function deriveInspectorSelection({
  snapshot,
  selectedArtifactPinId,
  aiTarget,
  reviewTarget
}: {
  readonly snapshot: DesignerSnapshot;
  readonly selectedArtifactPinId: string | undefined;
  readonly aiTarget: SpatialTargetInput | undefined;
  readonly reviewTarget: SpatialTargetInput | undefined;
}): InspectorSelection {
  const pin = snapshot.artifactPins.find((item) => item.id === selectedArtifactPinId);
  const target = pin?.anchor ?? aiTarget ?? reviewTarget;
  const targetOrigin = pin
    ? ('review pin' as const)
    : aiTarget
      ? ('AI target' as const)
      : reviewTarget
        ? ('review target' as const)
        : undefined;
  const nodeId = target === undefined ? snapshot.selectedNodeId : target.nodeRef;
  const node = snapshot.nodes.find((item) => item.nodeId === nodeId);
  const catalogEntry = node
    ? snapshot.componentCatalog.entries.find(
        (entry) => entry.component.toLocaleLowerCase() === node.exportName.toLocaleLowerCase()
      )
    : undefined;

  return {
    ...(node === undefined ? {} : { node }),
    ...(target === undefined ? {} : { target }),
    ...(targetOrigin === undefined ? {} : { targetOrigin }),
    ...(catalogEntry === undefined ? {} : { catalogEntry })
  };
}

export function normalizedPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function isInspectorSearchMatch(
  query: string,
  values: readonly (string | undefined)[]
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    values.some((value) => value?.toLocaleLowerCase().includes(normalized) === true)
  );
}
