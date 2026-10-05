/** Screen-space conversation geometry is display-only, never selection authority. */
export interface ThreadCardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ThreadCardPlacement {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly visibleCanvas: ThreadCardRect;
}

/** Return only a finite placement inside the currently visible canvas. */
export function threadCardPlacement(
  card: ThreadCardRect,
  canvas: ThreadCardRect,
  viewport: { readonly width: number; readonly height: number },
  inset = 8
): ThreadCardPlacement | undefined {
  if (
    ![
      card.left,
      card.top,
      card.width,
      card.height,
      canvas.left,
      canvas.top,
      canvas.width,
      canvas.height,
      viewport.width,
      viewport.height,
      inset
    ].every(Number.isFinite) ||
    card.width <= 0 ||
    card.height <= 0 ||
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    inset < 0
  )
    return undefined;
  const left = Math.max(0, canvas.left) + inset;
  const top = Math.max(0, canvas.top) + inset;
  const right = Math.min(viewport.width, canvas.left + canvas.width) - inset;
  const bottom = Math.min(viewport.height, canvas.top + canvas.height) - inset;
  const maxWidth = right - left;
  const maxHeight = bottom - top;
  if (maxWidth <= 0 || maxHeight <= 0) return undefined;
  const width = Math.min(card.width, maxWidth);
  const height = Math.min(card.height, maxHeight);
  return {
    offsetX: Math.max(left, Math.min(card.left, right - width)) - card.left,
    offsetY: Math.max(top, Math.min(card.top, bottom - height)) - card.top,
    maxWidth,
    maxHeight,
    visibleCanvas: { left, top, width: maxWidth, height: maxHeight }
  };
}

/** Snapshot/reply updates do not create a new focus request or steal a draft's caret. */
export function threadCardFocusRequest(
  threadId: string,
  request: number | undefined,
  handledRequest: string | undefined,
  editing: boolean
): { readonly key: string; readonly focus: boolean } {
  const key = JSON.stringify([threadId, request ?? 0]);
  return { key, focus: key !== handledRequest && !editing };
}
