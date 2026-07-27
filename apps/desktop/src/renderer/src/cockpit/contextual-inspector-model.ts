import type { DesignerSnapshot, SpatialTargetInput } from '../../../shared/designer-api';
import type { PreviewElementTelemetry } from '../../../shared/preview-channel';

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
export function computedCssSnippet(values: PreviewElementTelemetry): string | undefined {
  const declarations: readonly [string, string][] = [
    ['display', values.display],
    ['position', values.position],
    ['box-sizing', values.boxSizing],
    ['margin', values.margin],
    ['padding', values.padding],
    ['gap', values.gap],
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
