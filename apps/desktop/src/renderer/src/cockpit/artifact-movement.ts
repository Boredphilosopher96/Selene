export const artifactMoveGrid = 8;
export const artifactAlignmentTolerance = 6;
export const maximumArtifactMove = 100_000;

export type ArtifactAlignmentKind = 'start' | 'center' | 'end';

export interface ArtifactMoveAlignment {
  readonly vertical?: {
    readonly kind: ArtifactAlignmentKind;
    readonly position: number;
  };
  readonly horizontal?: {
    readonly kind: ArtifactAlignmentKind;
    readonly position: number;
  };
}

export interface ArtifactMoveResult {
  readonly offset: {
    readonly left: number;
    readonly top: number;
  };
  readonly alignment: ArtifactMoveAlignment;
}

interface ArtifactMoveInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly precise: boolean;
  readonly element: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly artboard: {
    readonly width: number;
    readonly height: number;
  };
}

interface AxisAlignment {
  readonly kind: ArtifactAlignmentKind;
  readonly offset: number;
  readonly position: number;
}

function finiteBoundedMove(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maximumArtifactMove, Math.min(maximumArtifactMove, value));
}

function nearestAxisAlignment(
  offset: number,
  start: number,
  size: number,
  artboardSize: number
): AxisAlignment | undefined {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(size) ||
    !Number.isFinite(artboardSize) ||
    size <= 0 ||
    artboardSize <= 0
  )
    return undefined;

  const candidates: readonly AxisAlignment[] = [
    {
      kind: 'center',
      offset: artboardSize / 2 - (start + size / 2),
      position: artboardSize / 2
    },
    { kind: 'start', offset: -start, position: 0 },
    { kind: 'end', offset: artboardSize - (start + size), position: artboardSize }
  ];
  return candidates.reduce<AxisAlignment | undefined>((nearest, candidate) => {
    const distance = Math.abs(candidate.offset - offset);
    if (distance > artifactAlignmentTolerance) return nearest;
    if (!nearest || distance < Math.abs(nearest.offset - offset)) return candidate;
    return nearest;
  }, undefined);
}

/**
 * Converts physical drag intent into bounded artifact-space movement. Option
 * precision uses whole pixels only; normal movement snaps to the 8px grid and
 * then to a nearby artboard edge or centerline when that is more useful.
 */
export function artifactMove(input: ArtifactMoveInput): ArtifactMoveResult {
  const grid = input.precise ? 1 : artifactMoveGrid;
  const gridOffset = {
    left: Math.round(finiteBoundedMove(input.deltaX) / grid) * grid,
    top: Math.round(finiteBoundedMove(input.deltaY) / grid) * grid
  };
  if (input.precise) return { offset: gridOffset, alignment: {} };

  const vertical = nearestAxisAlignment(
    gridOffset.left,
    input.element.left,
    input.element.width,
    input.artboard.width
  );
  const horizontal = nearestAxisAlignment(
    gridOffset.top,
    input.element.top,
    input.element.height,
    input.artboard.height
  );
  return {
    offset: {
      left: finiteBoundedMove(vertical?.offset ?? gridOffset.left),
      top: finiteBoundedMove(horizontal?.offset ?? gridOffset.top)
    },
    alignment: {
      ...(vertical
        ? { vertical: { kind: vertical.kind, position: vertical.position } }
        : undefined),
      ...(horizontal
        ? { horizontal: { kind: horizontal.kind, position: horizontal.position } }
        : undefined)
    }
  };
}
