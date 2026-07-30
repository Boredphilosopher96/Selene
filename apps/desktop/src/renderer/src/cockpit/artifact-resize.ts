export const minimumArtifactDimension = 24;
export const maximumArtifactDimension = 4096;
export const artifactResizeSnap = 8;

export interface ArtifactDimensionConstraints {
  /** Authenticated computed minimum for this axis, if CSS supplies one. */
  readonly minimum?: number;
  /** Authenticated computed maximum for this axis, if CSS supplies one. */
  readonly maximum?: number;
  /** The selected element cannot outgrow its rendered parent while manipulated. */
  readonly parent?: number;
}

function boundedConstraint(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(maximumArtifactDimension, value)
    : undefined;
}

/** Keeps an ephemeral resize truthful to the same bounded values accepted by the host. */
export function constrainedArtifactDimension(
  value: number,
  snap: boolean,
  constraints: ArtifactDimensionConstraints = {}
): number {
  const minimum = Math.max(minimumArtifactDimension, boundedConstraint(constraints.minimum) ?? 0);
  const maximum = Math.min(
    maximumArtifactDimension,
    boundedConstraint(constraints.maximum) ?? maximumArtifactDimension,
    boundedConstraint(constraints.parent) ?? maximumArtifactDimension
  );
  const lower = Math.min(minimum, maximum);
  if (!Number.isFinite(value)) return lower;
  const bounded = Math.min(maximum, Math.max(lower, value));
  const adjusted = snap ? Math.round(bounded / artifactResizeSnap) * artifactResizeSnap : bounded;
  return Math.min(maximum, Math.max(lower, Math.round(adjusted)));
}

export function keyboardArtifactDimension(
  current: number,
  direction: -1 | 1,
  coarse: boolean,
  constraints: ArtifactDimensionConstraints = {}
): number {
  return constrainedArtifactDimension(
    current + direction * (coarse ? artifactResizeSnap : 1),
    false,
    constraints
  );
}
