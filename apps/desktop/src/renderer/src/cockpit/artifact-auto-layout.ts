export const maximumArtifactGap = 512;
export const artifactGapStep = 1;
export const artifactGapCoarseStep = 8;

export type ArtifactAutoLayoutProperty = 'gap' | 'alignItems' | 'justifyContent';

export const artifactAlignItemsValues = [
  'stretch',
  'flex-start',
  'center',
  'flex-end',
  'baseline'
] as const;

export const artifactJustifyContentValues = [
  'flex-start',
  'center',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly'
] as const;

/** Direct auto-layout controls are deliberately limited to actual layout containers. */
export function supportsArtifactAutoLayout(display: string): boolean {
  return (
    display === 'flex' ||
    display === 'inline-flex' ||
    display === 'grid' ||
    display === 'inline-grid'
  );
}

/**
 * A pointer/stepper can only preserve a single authored pixel gap truthfully.
 * Multi-axis, relative, token, inherited, and computed `normal` values stay in
 * the richer Inspector/AI path instead of being silently flattened.
 */
export function artifactGapPixels(value: string): number | undefined {
  const match = /^(?:0|(\d+(?:\.\d+)?)px)$/u.exec(value.trim());
  const parsed = match?.[1] === undefined ? (match ? 0 : undefined) : Number(match[1]);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0 || parsed > maximumArtifactGap)
    return undefined;
  return Math.round(parsed * 100) / 100;
}

/** React numeric inline styles are pixels; every string must be one explicit pixel gap. */
export function sourceBackedArtifactGapPixels(
  value: number | string | undefined
): number | undefined {
  if (typeof value === 'string') return artifactGapPixels(value);
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > maximumArtifactGap)
    return undefined;
  return Math.round(value * 100) / 100;
}

export function nextArtifactGap(
  current: string,
  direction: -1 | 1,
  coarse: boolean
): string | undefined {
  const value = artifactGapPixels(current);
  if (value === undefined) return undefined;
  const step = coarse ? artifactGapCoarseStep : artifactGapStep;
  const next = Math.min(maximumArtifactGap, Math.max(0, value + direction * step));
  return `${next}px`;
}
