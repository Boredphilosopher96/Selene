/**
 * A deferred effect from an earlier snapshot may run after a newer iframe
 * selection has been host-confirmed. Only clear telemetry when both snapshots
 * still agree that there is no durable selection.
 */
export function shouldClearPreviewTelemetry(
  observedSelectedNodeId: string | undefined,
  currentSelectedNodeId: string | undefined
): boolean {
  return observedSelectedNodeId === undefined && currentSelectedNodeId === undefined;
}

/** A renderer selection can act only after both independent authority fences settle. */
export function isPreviewSelectionAuthorized(
  hostConfirmed: boolean,
  hasSelectionProof: boolean
): boolean {
  return hostConfirmed && hasSelectionProof;
}

/** Preserve richer inspected display data while either authority fence settles. */
export function retainCurrentPreviewSelectionValues<T>(
  current:
    | Readonly<{ readonly nodeId: string; readonly revisionId: string; readonly values: T }>
    | undefined,
  nodeId: string,
  revisionId: string,
  fallback: T
): T {
  return current?.nodeId === nodeId && current.revisionId === revisionId
    ? current.values
    : fallback;
}
