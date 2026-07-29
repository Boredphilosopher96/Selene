export const minimumArtifactDimension = 24;
export const maximumArtifactDimension = 4096;
export const artifactResizeSnap = 8;

/** Keeps an ephemeral resize truthful to the same bounded values accepted by the host. */
export function constrainedArtifactDimension(value: number, snap: boolean): number {
  if (!Number.isFinite(value)) return minimumArtifactDimension;
  const bounded = Math.min(maximumArtifactDimension, Math.max(minimumArtifactDimension, value));
  const adjusted = snap ? Math.round(bounded / artifactResizeSnap) * artifactResizeSnap : bounded;
  return Math.min(
    maximumArtifactDimension,
    Math.max(minimumArtifactDimension, Math.round(adjusted))
  );
}

export function keyboardArtifactDimension(
  current: number,
  direction: -1 | 1,
  coarse: boolean
): number {
  return constrainedArtifactDimension(
    current + direction * (coarse ? artifactResizeSnap : 1),
    false
  );
}
