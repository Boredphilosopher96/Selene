import {
  validateHostedReviewBinding,
  type HostedReviewBinding,
  type HostedReviewProviderState
} from '@selene/collaboration/hosted-review';

/**
 * Static review deployments intentionally use the browser-local adapter. This
 * is an explicit offline provider state, not a simulated hosted connection.
 */
export const browserLocalHostedReviewState: HostedReviewProviderState = Object.freeze({
  provider: 'browser-local',
  identity: 'local-only',
  sync: 'offline'
});

export function browserLocalHostedReviewBinding(input: {
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly baselineId: string;
}): HostedReviewBinding {
  const binding: HostedReviewBinding = {
    tenantId: 'northstar',
    projectId: input.projectId,
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    baselineId: input.baselineId,
    version: 1
  };
  validateHostedReviewBinding(binding);
  return Object.freeze(binding);
}
