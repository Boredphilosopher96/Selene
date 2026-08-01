export interface ArtifactToolbarScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface ArtifactToolbarScreenPosition {
  readonly left: number;
  readonly placement: 'above' | 'below' | 'left' | 'right';
  readonly top: number;
}

/**
 * Places a screen-space toolbar next to its selected artifact while clamping
 * the complete surface into the visible canvas.
 */
export function artifactToolbarScreenPosition(
  selection: ArtifactToolbarScreenRect,
  toolbar: Readonly<Pick<ArtifactToolbarScreenRect, 'width' | 'height'>>,
  viewport: ArtifactToolbarScreenRect,
  gutter = 8
): ArtifactToolbarScreenPosition {
  const minimumTop = viewport.top + gutter;
  const minimumLeft = viewport.left + gutter;
  const maximumTop = Math.max(minimumTop, viewport.bottom - gutter - toolbar.height);
  const maximumLeft = Math.max(minimumLeft, viewport.right - gutter - toolbar.width);
  const centeredLeft = selection.left + selection.width / 2 - toolbar.width / 2;
  const centeredTop = selection.top + selection.height / 2 - toolbar.height / 2;
  const candidates = [
    { placement: 'below' as const, left: centeredLeft, top: selection.bottom + gutter },
    {
      placement: 'above' as const,
      left: centeredLeft,
      top: selection.top - gutter - toolbar.height
    },
    { placement: 'right' as const, left: selection.right + gutter, top: centeredTop },
    { placement: 'left' as const, left: selection.left - gutter - toolbar.width, top: centeredTop }
  ];
  const contains = (candidate: (typeof candidates)[number]) =>
    candidate.left >= minimumLeft &&
    candidate.top >= minimumTop &&
    candidate.left + toolbar.width <= viewport.right - gutter &&
    candidate.top + toolbar.height <= viewport.bottom - gutter;
  const clamp = (candidate: (typeof candidates)[number]) => ({
    ...candidate,
    left: Math.min(maximumLeft, Math.max(minimumLeft, candidate.left)),
    top: Math.min(maximumTop, Math.max(minimumTop, candidate.top))
  });
  const intersectionArea = (candidate: ReturnType<typeof clamp>) => {
    const width = Math.max(
      0,
      Math.min(candidate.left + toolbar.width, selection.right) -
        Math.max(candidate.left, selection.left)
    );
    const height = Math.max(
      0,
      Math.min(candidate.top + toolbar.height, selection.bottom) -
        Math.max(candidate.top, selection.top)
    );
    return width * height;
  };
  const contained = candidates.find(contains);
  if (contained) return contained;
  return candidates
    .map(clamp)
    .reduce((best, candidate) =>
      intersectionArea(candidate) < intersectionArea(best) ? candidate : best
    );
}
