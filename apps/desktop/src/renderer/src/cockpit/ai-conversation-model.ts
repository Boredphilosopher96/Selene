import type {
  AIChangeRequest,
  AIChangeRequestInput,
  AuthenticatedArtifactElementTarget,
  DesignerProgress,
  SpatialTargetInput
} from '../../../shared/designer-api';
import { safeDesignerNotice } from '../presentation-error';

export function isHostRequestActive(progress: DesignerProgress | undefined): boolean {
  return (
    progress?.stage === 'started' ||
    progress?.stage === 'thinking' ||
    progress?.stage === 'applying'
  );
}

export function isCurrentProjectProgress({
  progress,
  currentRequestIds,
  localSubmissionProjectId,
  currentProjectId
}: {
  readonly progress: DesignerProgress | undefined;
  readonly currentRequestIds: readonly string[];
  readonly localSubmissionProjectId: string | undefined;
  readonly currentProjectId: string;
}): boolean {
  if (progress === undefined) return false;
  return (
    currentRequestIds.includes(progress.requestId) || localSubmissionProjectId === currentProjectId
  );
}

export function canApplyConversationOperation({
  token,
  currentToken,
  projectId,
  currentProjectId
}: {
  readonly token: number;
  readonly currentToken: number;
  readonly projectId: string;
  readonly currentProjectId: string;
}): boolean {
  return token === currentToken && projectId === currentProjectId;
}

export function isCurrentProjectOwner(
  ownerProjectId: string | undefined,
  currentProjectId: string
): boolean {
  return ownerProjectId === currentProjectId;
}

/** Historical targets are display-only; retries require a newly minted current target. */
export function requestInput(
  request: AIChangeRequest,
  currentTarget?: AuthenticatedArtifactElementTarget
): AIChangeRequestInput | undefined {
  if (request.target !== undefined) {
    if (currentTarget === undefined) return undefined;
    return {
      kind: 'authenticated-element',
      agentId: request.agentId,
      instruction: request.instruction,
      target: currentTarget
    };
  }
  return { kind: 'general', agentId: request.agentId, instruction: request.instruction };
}

/** A renderer target is useful only when it carries the current host-issued preview binding. */
export function mintAuthenticatedAiTarget({
  anchor,
  projectId,
  revisionId,
  bindingId
}: {
  readonly anchor: SpatialTargetInput;
  readonly projectId: string;
  readonly revisionId: string;
  readonly bindingId: string | undefined;
}):
  | { readonly kind: 'available'; readonly target: AuthenticatedArtifactElementTarget }
  | { readonly kind: 'unavailable'; readonly message: string } {
  if (bindingId === undefined)
    return {
      kind: 'unavailable',
      message: 'The current preview build is unavailable. Refresh the preview, then reselect the element.'
    };
  if (anchor.nodeRef === undefined)
    return {
      kind: 'unavailable',
      message:
        'This selection is not compiler-mapped. Reselect a current rendered element before asking AI.'
    };
  return {
    kind: 'available',
    target: {
      format: 'selene-authenticated-artifact-element-target/v1',
      projectId,
      nodeRef: anchor.nodeRef,
      revisionId,
      bindingId,
      anchor
    }
  };
}

export function requestOutcome(request: AIChangeRequest): string {
  switch (request.status) {
    case 'queued':
      return 'Waiting for the selected agent.';
    case 'running':
      return 'Agent is preparing and validating this change.';
    case 'reviewing':
      return 'Compiled proposal is ready to preview, accept, or reject.';
    case 'applied':
      return request.resultingRevisionId
        ? `Applied as ${request.resultingRevisionId}.`
        : 'Applied as a new source revision.';
    case 'undone':
      return request.resultingRevisionId
        ? `Compensated by ${request.resultingRevisionId}.`
        : 'Compensated by a newer source revision.';
    case 'cancelled':
      return 'Cancelled before a source revision was applied.';
    case 'failed':
      return safeDesignerNotice(
        request.error,
        'The AI change did not finish. Try again, or choose another configured agent.'
      );
  }
}

export function targetSummary(
  _target: Pick<SpatialTargetInput, 'x' | 'y' | 'width' | 'height'>
): string {
  return 'Current compiler-authenticated React element';
}

export function composerDisabledReason({
  agentAvailable,
  requestActive,
  instruction,
  target
}: {
  readonly agentAvailable: boolean;
  readonly requestActive: boolean;
  readonly instruction: string;
  readonly target: AuthenticatedArtifactElementTarget | undefined;
}): string | undefined {
  if (requestActive)
    return 'Wait for the current AI operation to finish before starting another change.';
  if (!agentAvailable)
    return 'No configured agent is available. Complete agent setup before sending a change.';
  if (!instruction.trim()) return 'Describe the change before sending it.';
  if (target === undefined)
    return 'Select a current compiler-authenticated rendered React element before sending it.';
  return undefined;
}

export function isConversationBusy({
  requestActive,
  undoActive
}: {
  readonly requestActive: boolean;
  readonly undoActive: boolean;
}): boolean {
  return requestActive || undoActive;
}

export function canStartConversationOperation(input: {
  readonly requestActive: boolean;
  readonly undoActive: boolean;
}): boolean {
  return !isConversationBusy(input);
}
