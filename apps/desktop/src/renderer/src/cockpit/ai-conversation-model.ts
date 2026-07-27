import type {
  AIChangeRequest,
  AIChangeRequestInput,
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

export function requestInput(request: AIChangeRequest): AIChangeRequestInput {
  const { x, y, width, height, viewport, nodeRef } = request.target;
  return {
    agentId: request.agentId,
    instruction: request.instruction,
    target: {
      x,
      y,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      viewport: { width: viewport.width, height: viewport.height },
      ...(nodeRef === undefined ? {} : { nodeRef })
    }
  };
}

export function requestOutcome(request: AIChangeRequest): string {
  switch (request.status) {
    case 'queued':
      return 'Waiting for the selected agent.';
    case 'running':
      return 'Agent is preparing and validating this change.';
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
  target: Pick<SpatialTargetInput, 'x' | 'y' | 'width' | 'height'>
): string {
  const isRegion = (target.width ?? 0) > 0 || (target.height ?? 0) > 0;
  const centerX = Math.min(1, target.x + (target.width ?? 0) / 2);
  const centerY = Math.min(1, target.y + (target.height ?? 0) / 2);
  const horizontal = centerX < 1 / 3 ? 'left' : centerX > 2 / 3 ? 'right' : 'center';
  const vertical = centerY < 1 / 3 ? 'top' : centerY > 2 / 3 ? 'bottom' : 'center';
  const location =
    horizontal === 'center' && vertical === 'center' ? 'center' : `${vertical}-${horizontal}`;

  return `${isRegion ? 'Region' : 'Point'} near the ${location}`;
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
  readonly target: SpatialTargetInput | undefined;
}): string | undefined {
  if (requestActive)
    return 'Wait for the current AI operation to finish before starting another change.';
  if (!agentAvailable)
    return 'No configured agent is available. Complete agent setup before sending a change.';
  if (!instruction.trim()) return 'Describe the change before sending it.';
  if (target === undefined) return 'Choose a preview target before sending it.';
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
