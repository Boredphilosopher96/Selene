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
  readonly top: number;
  readonly vertical: 'above' | 'below';
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
  const minimumLeft = viewport.left + gutter;
  const maximumLeft = Math.max(minimumLeft, viewport.right - gutter - toolbar.width);
  const preferredLeft = selection.left + selection.width / 2 - toolbar.width / 2;
  const left = Math.min(maximumLeft, Math.max(minimumLeft, preferredLeft));
  const below = selection.bottom + gutter;
  const above = selection.top - gutter - toolbar.height;
  const availableBelow = viewport.bottom - gutter - selection.bottom;
  const availableAbove = selection.top - (viewport.top + gutter);
  const vertical =
    availableBelow >= toolbar.height || availableBelow >= availableAbove ? 'below' : 'above';
  const preferredTop = vertical === 'below' ? below : above;
  const minimumTop = viewport.top + gutter;
  const maximumTop = Math.max(minimumTop, viewport.bottom - gutter - toolbar.height);
  return {
    left,
    top: Math.min(maximumTop, Math.max(minimumTop, preferredTop)),
    vertical
  };
}
