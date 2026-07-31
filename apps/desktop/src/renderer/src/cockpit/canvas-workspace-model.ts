import type { PreviewCanvasGesture } from '../../../shared/preview-channel';
import type {
  DesignSystemComponentProperty,
  DesignSystemComponentPropertyValue
} from '../../../shared/designer-api';

export type CanvasShortcutAction =
  'fit-all' | 'reset-viewport' | 'fit-selection' | 'hand-on' | 'hand-off' | 'clear' | undefined;

/** Keyboard behavior shared by the live canvas and its focused controls. */
export function canvasShortcutAction(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}): CanvasShortcutAction {
  if (input.shiftKey && input.key === '1') return 'fit-all';
  if (input.shiftKey && input.key === '0') return 'reset-viewport';
  if (input.shiftKey && input.key === '2') return 'fit-selection';
  if (input.key === 'Escape') return 'clear';
  if (!input.shiftKey && input.key.toLowerCase() === 'h')
    return input.repeat ? undefined : 'hand-on';
  if (!input.shiftKey && input.key.toLowerCase() === 'v')
    return input.repeat ? undefined : 'hand-off';
  return undefined;
}

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CanvasBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CatalogInsertIntent {
  readonly origin: 'project' | 'design-system';
  readonly packageName?: string;
  readonly version?: string;
  readonly entrypoint?: string;
  readonly exportName?: string;
  readonly artifactDigest?: string;
  readonly properties?: readonly DesignSystemComponentProperty[];
}

export type CatalogInsertTarget =
  | {
      readonly kind: 'compatible';
      readonly nodeId: string;
      readonly layout: 'flex' | 'grid';
    }
  | {
      readonly kind: 'incompatible';
      readonly nodeId: string;
    };

/**
 * Derives renderer-only drop guidance from host-proven current source targets.
 * Main independently re-authorizes the exact target again before mutation.
 */
export function catalogInsertTarget(
  selectedNodeId: string | undefined,
  sourceTarget: Readonly<{ nodeId: string; layout: 'flex' | 'grid' }> | undefined
): CatalogInsertTarget | undefined {
  if (selectedNodeId === undefined) return undefined;
  return sourceTarget?.nodeId === selectedNodeId
    ? { kind: 'compatible', nodeId: selectedNodeId, layout: sourceTarget.layout }
    : { kind: 'incompatible', nodeId: selectedNodeId };
}

export type CatalogInsertAvailability =
  | 'ready'
  | 'project-component'
  | 'provenance-required'
  | 'configuration-required'
  | 'host-unavailable'
  | 'target-required';

/** Renderer UX only. Main independently re-authorizes identity, props, revision and target. */
export function catalogInsertAvailability(
  entry: CatalogInsertIntent,
  values: Readonly<Record<string, DesignSystemComponentPropertyValue>>,
  context: Readonly<{ hostAvailable: boolean; targetAvailable: boolean }>
): CatalogInsertAvailability {
  if (entry.origin !== 'design-system') return 'project-component';
  if (
    entry.packageName === undefined ||
    entry.version === undefined ||
    entry.entrypoint === undefined ||
    entry.exportName === undefined ||
    entry.artifactDigest === undefined
  )
    return 'provenance-required';
  if (
    entry.properties?.some(
      (property) => property.required === true && values[property.name] === undefined
    )
  )
    return 'configuration-required';
  if (!context.hostAvailable) return 'host-unavailable';
  if (!context.targetAvailable) return 'target-required';
  return 'ready';
}

export function catalogEntryCanDrag(
  entry: CatalogInsertIntent,
  values: Readonly<Record<string, DesignSystemComponentPropertyValue>>,
  hostAvailable: boolean
): boolean {
  const availability = catalogInsertAvailability(entry, values, {
    hostAvailable,
    targetAvailable: true
  });
  return availability === 'ready';
}

/**
 * Applies preview-local trackpad input to the outer infinite canvas. Ordinary
 * two-finger motion pans; Chromium-marked pinch zoom stays pointer-anchored.
 */
export function applyCanvasPreviewGesture(
  viewport: CanvasViewport,
  gesture: PreviewCanvasGesture,
  flowBounds: CanvasBounds,
  previewBounds: CanvasBounds,
  limits: Readonly<{ minimumZoom: number; maximumZoom: number }>
): CanvasViewport {
  if (
    flowBounds.width <= 0 ||
    flowBounds.height <= 0 ||
    previewBounds.width <= 0 ||
    previewBounds.height <= 0
  )
    return viewport;
  if (gesture.gesture === 'pan')
    return {
      x: viewport.x - gesture.deltaX,
      y: viewport.y - gesture.deltaY,
      zoom: viewport.zoom
    };
  const nextZoom = Math.min(
    limits.maximumZoom,
    Math.max(limits.minimumZoom, viewport.zoom * Math.exp(-gesture.deltaY * 0.002))
  );
  const pointerX = previewBounds.left + gesture.x * previewBounds.width - flowBounds.left;
  const pointerY = previewBounds.top + gesture.y * previewBounds.height - flowBounds.top;
  const worldX = (pointerX - viewport.x) / viewport.zoom;
  const worldY = (pointerY - viewport.y) / viewport.zoom;
  return {
    x: pointerX - worldX * nextZoom,
    y: pointerY - worldY * nextZoom,
    zoom: nextZoom
  };
}
