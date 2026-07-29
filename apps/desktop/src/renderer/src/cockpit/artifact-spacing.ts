export interface ArtifactSpacingMeasurement {
  readonly axis: 'horizontal' | 'vertical';
  readonly side: 'before' | 'after';
  readonly start: number;
  readonly cross: number;
  readonly length: number;
}

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function finiteBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function overlapCenter(startA: number, sizeA: number, startB: number, sizeB: number) {
  const start = Math.max(startA, startB);
  const end = Math.min(startA + sizeA, startB + sizeB);
  return end > start ? start + (end - start) / 2 : undefined;
}

/**
 * Returns only the nearest visible peer on each side. Geometry is already
 * authenticated and bounded by the preview channel; this function remains
 * renderer-only and never infers source hierarchy or mutation legality.
 */
export function artifactSpacing(
  element: Bounds,
  targets: readonly Bounds[]
): readonly ArtifactSpacingMeasurement[] {
  if (!finiteBounds(element)) return [];
  const right = element.left + element.width;
  const bottom = element.top + element.height;
  const nearest = new Map<string, ArtifactSpacingMeasurement>();
  const consider = (measurement: ArtifactSpacingMeasurement) => {
    if (!Number.isFinite(measurement.length) || measurement.length < 0) return;
    const key = `${measurement.axis}:${measurement.side}`;
    const current = nearest.get(key);
    if (!current || measurement.length < current.length) nearest.set(key, measurement);
  };

  for (const target of targets.slice(0, 64)) {
    if (!finiteBounds(target)) continue;
    const targetRight = target.left + target.width;
    const targetBottom = target.top + target.height;
    const horizontalCross = overlapCenter(element.top, element.height, target.top, target.height);
    if (horizontalCross !== undefined && targetRight <= element.left)
      consider({
        axis: 'horizontal',
        side: 'before',
        start: targetRight,
        cross: horizontalCross,
        length: element.left - targetRight
      });
    if (horizontalCross !== undefined && target.left >= right)
      consider({
        axis: 'horizontal',
        side: 'after',
        start: right,
        cross: horizontalCross,
        length: target.left - right
      });

    const verticalCross = overlapCenter(element.left, element.width, target.left, target.width);
    if (verticalCross !== undefined && targetBottom <= element.top)
      consider({
        axis: 'vertical',
        side: 'before',
        start: targetBottom,
        cross: verticalCross,
        length: element.top - targetBottom
      });
    if (verticalCross !== undefined && target.top >= bottom)
      consider({
        axis: 'vertical',
        side: 'after',
        start: bottom,
        cross: verticalCross,
        length: target.top - bottom
      });
  }
  return [...nearest.values()];
}
