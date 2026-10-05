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
  gutter = 8,
  preference: 'side' | 'below' = 'below',
  avoid: readonly ArtifactToolbarScreenRect[] = []
): ArtifactToolbarScreenPosition {
  const minimumTop = viewport.top + gutter;
  const minimumLeft = viewport.left + gutter;
  const maximumTop = Math.max(minimumTop, viewport.bottom - gutter - toolbar.height);
  const maximumLeft = Math.max(minimumLeft, viewport.right - gutter - toolbar.width);
  const centeredLeft = selection.left + selection.width / 2 - toolbar.width / 2;
  const centeredTop = selection.top + selection.height / 2 - toolbar.height / 2;
  const above = {
    placement: 'above' as const,
    left: centeredLeft,
    top: selection.top - gutter - toolbar.height
  };
  const below = { placement: 'below' as const, left: centeredLeft, top: selection.bottom + gutter };
  const sides = [
    { placement: 'right' as const, left: selection.right + gutter, top: centeredTop },
    { placement: 'left' as const, left: selection.left - gutter - toolbar.width, top: centeredTop }
  ];
  // A side lane leaves both the preceding and following editable text exposed.
  // Comment composers retain their existing below-first policy.
  const candidates = preference === 'side' ? [...sides, above, below] : [below, above, ...sides];
  const overlaps = (candidate: (typeof candidates)[number], rect: ArtifactToolbarScreenRect) =>
    Math.max(
      0,
      Math.min(candidate.left + toolbar.width, rect.right) - Math.max(candidate.left, rect.left)
    ) *
    Math.max(
      0,
      Math.min(candidate.top + toolbar.height, rect.bottom) - Math.max(candidate.top, rect.top)
    );
  const contains = (candidate: (typeof candidates)[number]) =>
    candidate.left >= minimumLeft &&
    candidate.top >= minimumTop &&
    candidate.left + toolbar.width <= viewport.right - gutter &&
    candidate.top + toolbar.height <= viewport.bottom - gutter &&
    avoid.every((rect) => overlaps(candidate, rect) === 0);
  const clamp = (candidate: (typeof candidates)[number]) => ({
    ...candidate,
    left: Math.min(maximumLeft, Math.max(minimumLeft, candidate.left)),
    top: Math.min(maximumTop, Math.max(minimumTop, candidate.top))
  });
  const intersectionArea = (candidate: ReturnType<typeof clamp>) => {
    if (preference === 'below') return overlaps(candidate, selection);
    const rectangles = [selection, ...avoid];
    const coveredCenters = rectangles.filter((rect) => {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return (
        x >= candidate.left &&
        x <= candidate.left + toolbar.width &&
        y >= candidate.top &&
        y <= candidate.top + toolbar.height
      );
    }).length;
    return (
      coveredCenters * (viewport.width * viewport.height + 1) +
      rectangles.reduce((total, rect) => total + overlaps(candidate, rect), 0)
    );
  };
  const contained = candidates.find(contains);
  if (contained) return contained;
  return candidates
    .map(clamp)
    .reduce((best, candidate) =>
      intersectionArea(candidate) < intersectionArea(best) ? candidate : best
    );
}
