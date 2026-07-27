import type { PreviewCanvasGesture } from '../../../shared/preview-channel';

export type CanvasShortcutAction =
  'fit-all' | 'fit-selection' | 'hand-on' | 'hand-off' | 'clear' | undefined;

export type PreviewInteractionFailure = 'select-node' | 'trigger-action';

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

export function previewInteractionFailureNotice(operation: PreviewInteractionFailure): string {
  return operation === 'select-node'
    ? 'Could not select that preview element. Try again or refresh the preview.'
    : 'Could not run that prototype action. Try again or refresh the preview.';
}

function containsPrivateHostDetails(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
  });
  return (
    value.length === 0 ||
    value.includes(String.fromCharCode(27)) ||
    hasControlCharacter ||
    value.includes(String.fromCharCode(127)) ||
    /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/u.test(value) ||
    /(?:node_modules|(?:https?|file|ssh|git|wss?):\/\/|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|(?:[a-z0-9-]+\.)+[a-z]{2,})/iu.test(
      value
    ) ||
    /\b(?:host|provider|hostname|endpoint|api[ _-]?key|access[ _-]?token|model[ _-]?id|openai|anthropic|bedrock|vertex|azure)\b/iu.test(
      value
    ) ||
    /\b(?:ENOENT|EPERM|EACCES|ECONNREFUSED|spawn|exit code)\b/iu.test(value) ||
    /\bat\s+(?:\S+\s+\()?[^)\s]+:\d+:\d+\)?/u.test(value)
  );
}

export function plainCanvasStatus(
  value: string,
  fallback = 'Try the canvas action again.'
): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (containsPrivateHostDetails(value) || containsPrivateHostDetails(compact)) {
    const compactFallback = fallback.replace(/\s+/gu, ' ').trim();
    return !containsPrivateHostDetails(fallback) &&
      !containsPrivateHostDetails(compactFallback) &&
      compactFallback.length <= 180
      ? compactFallback
      : 'Try the canvas action again.';
  }
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
