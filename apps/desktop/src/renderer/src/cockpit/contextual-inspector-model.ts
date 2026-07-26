import type { DesignerSnapshot, SpatialTargetInput } from '../../../shared/designer-api';

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
