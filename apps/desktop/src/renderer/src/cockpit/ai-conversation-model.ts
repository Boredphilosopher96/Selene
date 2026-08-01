import type {
  AIChangeRequest,
  AIChangeRequestInput,
  ArtifactSelectionReceipt,
  ArtifactSelectionReceiptRequest,
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
  currentSelectionReceipt?: ArtifactSelectionReceipt
): AIChangeRequestInput | undefined {
  if (request.target !== undefined) {
    if (currentSelectionReceipt === undefined) return undefined;
    return {
      kind: 'authenticated-element',
      agentId: request.agentId,
      instruction: request.instruction,
      selectionReceipt: currentSelectionReceipt
    };
  }
  return { kind: 'general', agentId: request.agentId, instruction: request.instruction };
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
  target?: Pick<SpatialTargetInput, 'nodeRef'>
): string {
  return target?.nodeRef === undefined
    ? 'Selected compiler-authenticated React element'
    : `Selected React element: ${target.nodeRef}`;
}

export function composerDisabledReason({
  agentAvailable,
  requestActive,
  instruction,
  selection
}: {
  readonly agentAvailable: boolean;
  readonly requestActive: boolean;
  readonly instruction: string;
  readonly selection: ArtifactSelectionReceiptRequest | undefined;
}): string | undefined {
  if (requestActive)
    return 'Wait for the current AI operation to finish before starting another change.';
  if (!agentAvailable)
    return 'No configured agent is available. Complete agent setup before sending a change.';
  if (!instruction.trim()) return 'Describe the change before sending it.';
  if (selection === undefined)
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
