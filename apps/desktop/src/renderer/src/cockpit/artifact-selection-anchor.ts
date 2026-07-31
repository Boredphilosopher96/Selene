import type { SpatialTargetInput } from '../../../shared/designer-api';
import type { PreviewMappedElementTelemetrySelection } from '../../../shared/preview-channel';

export interface ArtifactViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Converts trusted frame-local geometry into the one normalized spatial target
 * shared by review comments and AI requests. Geometry is clipped to the exact
 * preview viewport so partially off-canvas selections stay bounded.
 */
export function artifactSelectionAnchor(
  selection: PreviewMappedElementTelemetrySelection,
  viewport: ArtifactViewport
): SpatialTargetInput | undefined {
  const { left, top, width, height } = selection.values;
  if (
    left === undefined ||
    top === undefined ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return undefined;

  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp(left / viewport.width);
  const y = clamp(top / viewport.height);
  const right = clamp((left + width) / viewport.width);
  const bottom = clamp((top + height) / viewport.height);
  const normalizedWidth = Math.max(0, right - x);
  const normalizedHeight = Math.max(0, bottom - y);

  return {
    x,
    y,
    width: normalizedWidth,
    height: normalizedHeight,
    viewport,
    nodeRef: selection.nodeId
  };
}
