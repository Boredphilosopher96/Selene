export interface ArtifactToolbarScreenSpan {
  readonly left: number;
  readonly right: number;
}

/**
 * Returns the smallest screen-space correction that keeps a selected-element
 * toolbar inside the visible canvas. Oversized surfaces pin to the leading
 * gutter so their primary controls remain reachable.
 */
export function artifactToolbarScreenNudge(
  toolbar: ArtifactToolbarScreenSpan,
  viewport: ArtifactToolbarScreenSpan,
  gutter = 8
): number {
  const minimum = viewport.left + gutter;
  const maximum = viewport.right - gutter;
  const toolbarWidth = toolbar.right - toolbar.left;
  if (toolbarWidth > maximum - minimum) return minimum - toolbar.left;
  if (toolbar.left < minimum) return minimum - toolbar.left;
  if (toolbar.right > maximum) return maximum - toolbar.right;
  return 0;
}
