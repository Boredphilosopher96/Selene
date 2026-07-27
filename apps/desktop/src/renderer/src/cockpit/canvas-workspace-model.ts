import type { PreviewCanvasGesture } from '../../../shared/preview-channel';

export type CanvasShortcutAction =
  'fit-all' | 'fit-selection' | 'hand-on' | 'hand-off' | 'clear' | undefined;

/** Keyboard behavior shared by the live canvas and its focused controls. */
export function canvasShortcutAction(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}): CanvasShortcutAction {
  if (input.shiftKey && input.key === '1') return 'fit-all';
  if (input.shiftKey && input.key === '2') return 'fit-selection';
  if (input.key === 'Escape') return 'clear';
  if (!input.shiftKey && input.key.toLowerCase() === 'h')
    return input.repeat ? undefined : 'hand-on';
  if (!input.shiftKey && input.key.toLowerCase() === 'v')
    return input.repeat ? undefined : 'hand-off';
  return undefined;
}

export function plainCanvasStatus(
  value: string,
  fallback = 'Try the canvas action again.'
): string {
  const escape = String.fromCharCode(27);
  let plain = '';
  let inEscape = false;
  for (const character of value) {
    if (character === escape) {
      inEscape = true;
      continue;
    }
    if (inEscape) {
      if (character >= '@' && character <= '~') inEscape = false;
      continue;
    }
    plain += character;
  }
  const compact = plain.replace(/\s+/gu, ' ').trim();
  if (
    compact.length === 0 ||
    compact.includes('/Users/') ||
    compact.includes('node_modules') ||
    /\b(?:ENOENT|EPERM|EACCES|spawn|exit code)\b/iu.test(compact)
  )
    return fallback;
  return compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact;
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

/**
 * Applies preview-local trackpad input to the outer infinite canvas while
 * keeping pinch zoom anchored beneath the pointer.
 */
export function applyCanvasPreviewGesture(
  viewport: CanvasViewport,
  gesture: PreviewCanvasGesture,
  flowBounds: CanvasBounds,
  previewBounds: CanvasBounds,
  limits: Readonly<{ minimumZoom: number; maximumZoom: number }>
): CanvasViewport {
  if (gesture.gesture === 'pan')
    return {
      x: viewport.x - gesture.deltaX,
      y: viewport.y - gesture.deltaY,
      zoom: viewport.zoom
    };
  if (
    flowBounds.width <= 0 ||
    flowBounds.height <= 0 ||
    previewBounds.width <= 0 ||
    previewBounds.height <= 0
  )
    return viewport;
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
