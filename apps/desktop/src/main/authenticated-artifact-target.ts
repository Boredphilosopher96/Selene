import type { SpatialTargetInput } from '../shared/designer-api';

/** Host-only compiler binding retained behind an opaque artifact selection receipt. */
export interface AuthenticatedArtifactElementTarget {
  readonly format: 'selene-authenticated-artifact-element-target/v1';
  readonly anchor: SpatialTargetInput;
  readonly projectId: string;
  readonly nodeRef: string;
  readonly revisionId: string;
  readonly bindingId: string;
}
