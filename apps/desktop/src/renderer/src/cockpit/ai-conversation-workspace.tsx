import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type {
  ArtifactSelectionReceipt,
  ArtifactSelectionReceiptRequest,
  AIChangeRequest,
  AIChangeRequestInput,
  AIChangeUndoInput,
  AIProposalDecisionInput,
  ManualDesignUndoInput,
  DesignerProgress,
  DesignerSnapshot
} from '../../../shared/designer-api';
import { presentDesignerError, safeDesignerNotice } from '../presentation-error';
import {
  canApplyConversationOperation,
  canStartConversationOperation,
  composerDisabledReason,
  isHostRequestActive,
  isConversationBusy,
  isCurrentProjectProgress,
  requestInput,
  requestOutcome,
  targetSummary
} from './ai-conversation-model';

export interface AIConversationWorkspaceActions {
  snapshot(): Promise<DesignerSnapshot>;
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  mintArtifactSelectionReceipt(
    request: ArtifactSelectionReceiptRequest
  ): Promise<ArtifactSelectionReceipt>;
  acceptAIProposal(input: AIProposalDecisionInput): Promise<DesignerSnapshot>;
  rejectAIProposal(input: AIProposalDecisionInput): Promise<DesignerSnapshot>;
  cancelAIChange(requestId: string): Promise<void>;
  undoLastAIChange(input: AIChangeUndoInput): Promise<DesignerSnapshot>;
  undoLatestManualDesignEdit(input: ManualDesignUndoInput): Promise<DesignerSnapshot>;
}

export interface AIConversationWorkspaceProps {
  readonly snapshot: DesignerSnapshot;
  readonly progress?: DesignerProgress;
  readonly target: ArtifactSelectionReceiptRequest | undefined;
  /** Renderer-local display context; it is never sent with the authority-bearing request. */
  readonly targetSummary?: string;
  readonly status: string;
  readonly actions: AIConversationWorkspaceActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onRender: (snapshot: DesignerSnapshot) => Promise<void>;
  readonly onPreviewProposal: (input: AIProposalDecisionInput) => Promise<void>;
  readonly onPrepareProposalRevision: (request: AIChangeRequest) => void;
  readonly onStatusChange: (status: string) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSelectOnCanvas: () => void;
  readonly onTargetClear: () => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isTerminalProgress(progress: DesignerProgress | undefined): boolean {
  return (
    progress?.stage === 'completed' ||
    progress?.stage === 'cancelled' ||
    progress?.stage === 'error'
  );
}

/** Owns the bounded AI conversation journey; canvas selection remains in the cockpit shell. */
export function AIConversationWorkspace({
  snapshot,
  progress,
  target,
  targetSummary: currentTargetSummary,
  status,
  actions,
  onSnapshot,
  onRender,
  onPreviewProposal,
  onPrepareProposalRevision,
  onStatusChange,
  onBusyChange,
  onSelectOnCanvas,
  onTargetClear
}: AIConversationWorkspaceProps) {
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [selectionMinting, setSelectionMinting] = useState(false);
  const [cancellingRequestId, setCancellingRequestId] = useState<string | undefined>(undefined);
  const [undoingRequestId, setUndoingRequestId] = useState<string | undefined>(undefined);
  const [undoStatus, setUndoStatus] = useState<string | undefined>(undefined);
  const [proposalOperation, setProposalOperation] = useState<
    'preview' | 'accept' | 'reject' | 'revise' | undefined
  >(undefined);
  const [visibleRequestCount, setVisibleRequestCount] = useState(12);
  const aiSubmittingRef = useRef(false);
  const selectionMintingRef = useRef(false);
  const operationToken = useRef(0);
  const projectIdRef = useRef(snapshot.source.projectId);
  const mountedProjectId = useRef(snapshot.source.projectId);
  const localSubmissionProjectId = useRef<string | undefined>(undefined);
  const cancellingRequestRef = useRef<string | undefined>(undefined);
  const cancelSettlingRef = useRef(false);
  const undoSubmittingRef = useRef(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const undoStatusRef = useRef<HTMLParagraphElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const historyExpansionAnchor = useRef<number | undefined>(undefined);
  projectIdRef.current = snapshot.source.projectId;

  const selectedAgent = snapshot.agents.find((agent) => agent.id === snapshot.selectedAgentId);
  const latestApplied = [...snapshot.aiChangeRequests]
    .reverse()
    .find((request) => request.status === 'applied');
  const persistedActive = snapshot.aiChangeRequests.find(
    (request) => request.status === 'queued' || request.status === 'running'
  );
  const progressBelongsToCurrentProject = isCurrentProjectProgress({
    progress,
    currentRequestIds: snapshot.aiChangeRequests.map((request) => request.id),
    localSubmissionProjectId: aiSubmittingRef.current
      ? localSubmissionProjectId.current
      : undefined,
    currentProjectId: snapshot.source.projectId
  });
  const progressRequestId =
    progressBelongsToCurrentProject && isHostRequestActive(progress)
      ? progress?.requestId
      : undefined;
  const activeRequestId = persistedActive?.id ?? progressRequestId;
  const requestActive =
    aiSubmitting ||
    selectionMinting ||
    persistedActive !== undefined ||
    progressRequestId !== undefined;
  const conversationBusy = isConversationBusy({
    requestActive,
    undoActive:
      undoSubmittingRef.current || undoingRequestId !== undefined || proposalOperation !== undefined
  });
  const canStartOperation =
    snapshot.pendingAIProposal === undefined &&
    canStartConversationOperation({
      requestActive,
      undoActive:
        undoSubmittingRef.current ||
        undoingRequestId !== undefined ||
        proposalOperation !== undefined
    });
  const disabledReason =
    snapshot.pendingAIProposal === undefined
      ? composerDisabledReason({
          agentAvailable: selectedAgent !== undefined,
          requestActive: conversationBusy,
          instruction,
          selection: target
        })
      : 'Accept, reject, or revise the staged proposal before sending another request.';
  const visibleActivity = snapshot.designActivity.slice(-visibleRequestCount);
  const hiddenActivityCount = snapshot.designActivity.length - visibleActivity.length;
  const focusStatus = () => requestAnimationFrame(() => statusRef.current?.focus());
  const isCurrent = (token: number, projectId: string) =>
    canApplyConversationOperation({
      token,
      currentToken: operationToken.current,
      projectId,
      currentProjectId: projectIdRef.current
    });
  const clearCancellation = (requestId?: string) => {
    if (requestId !== undefined && cancellingRequestRef.current !== requestId) return;
    cancellingRequestRef.current = undefined;
    setCancellingRequestId(undefined);
  };

  useEffect(() => {
    const anchor = historyExpansionAnchor.current;
    const history = historyRef.current;
    if (anchor === undefined || history === null) return;
    history.scrollTop = Math.max(0, history.scrollHeight - anchor);
    historyExpansionAnchor.current = undefined;
  }, [visibleRequestCount]);

  useEffect(() => {
    if (mountedProjectId.current === snapshot.source.projectId) return;
    mountedProjectId.current = snapshot.source.projectId;
    operationToken.current += 1;
    aiSubmittingRef.current = false;
    selectionMintingRef.current = false;
    localSubmissionProjectId.current = undefined;
    setAiSubmitting(false);
    setSelectionMinting(false);
    undoSubmittingRef.current = false;
    setUndoingRequestId(undefined);
    setUndoStatus(undefined);
    setProposalOperation(undefined);
    setVisibleRequestCount(12);
    historyExpansionAnchor.current = undefined;
    cancelSettlingRef.current = false;
    onBusyChange(false);
    clearCancellation();
    onStatusChange(
      'Select a compiler-authenticated rendered React element when this change needs context.'
    );
  }, [onBusyChange, onStatusChange, snapshot.source.projectId]);

  useEffect(() => {
    const requestId = cancellingRequestRef.current;
    if (
      requestId === undefined ||
      aiSubmittingRef.current ||
      cancelSettlingRef.current ||
      !progressBelongsToCurrentProject ||
      progress?.requestId !== requestId ||
      !isTerminalProgress(progress)
    )
      return;
    cancelSettlingRef.current = true;
    const projectId = projectIdRef.current;
    void actions
      .snapshot()
      .then((next) => {
        if (projectIdRef.current === projectId && cancellingRequestRef.current === requestId)
          onSnapshot(next);
      })
      .catch(() => {
        if (projectIdRef.current === projectId && cancellingRequestRef.current === requestId)
          onStatusChange(
            'Cancellation finished, but the latest request history could not be refreshed.'
          );
      })
      .finally(() => {
        if (projectIdRef.current === projectId && cancellingRequestRef.current === requestId) {
          cancelSettlingRef.current = false;
          clearCancellation(requestId);
          focusStatus();
        }
      });
  }, [actions, onSnapshot, onStatusChange, progress, progressBelongsToCurrentProject]);

  const submit = (input: AIChangeRequestInput, source: 'composer' | 'retry') => {
    if (aiSubmittingRef.current || undoSubmittingRef.current || !canStartOperation) return;
    const token = operationToken.current + 1;
    operationToken.current = token;
    const projectId = snapshot.source.projectId;
    aiSubmittingRef.current = true;
    localSubmissionProjectId.current = projectId;
    setAiSubmitting(true);
    onBusyChange(true);
    onStatusChange(
      source === 'retry' ? 'Retrying the saved AI request…' : 'Sending targeted AI change…'
    );
    void (async () => {
      try {
        const next = await actions.requestAIChange(input);
        if (!isCurrent(token, projectId)) return;
        onSnapshot(next);
        if (source === 'composer') onTargetClear();
        const pending = next.pendingAIProposal;
        if (pending !== undefined) {
          onStatusChange(`Compiled proposal ${pending.candidateRevisionId} is ready for review.`);
          await onPreviewProposal({
            projectId,
            requestId: pending.requestId,
            candidateRevisionId: pending.candidateRevisionId
          });
          if (isCurrent(token, projectId))
            onStatusChange('Previewing the staged AI proposal. Accept or reject it to continue.');
          return;
        }
        onStatusChange(`Saved ${next.source.revision.id}. Refreshing its compiled preview…`);
        try {
          await onRender(next);
          if (isCurrent(token, projectId))
            onStatusChange(
              `Applied ${next.source.revision.id} and refreshed the compiled preview.`
            );
        } catch (error) {
          if (isCurrent(token, projectId))
            onStatusChange(
              `AI change was saved, but the compiled preview could not refresh. ${presentDesignerError(error, 'preview')}`
            );
        }
      } catch (error) {
        if (!isCurrent(token, projectId)) return;
        try {
          const terminal = await actions.snapshot();
          if (isCurrent(token, projectId)) onSnapshot(terminal);
        } catch {
          // The original host failure remains the truthful status when terminal reconciliation fails.
        }
        if (isCurrent(token, projectId))
          onStatusChange(
            cancellingRequestRef.current !== undefined || isAbort(error)
              ? 'AI request cancelled before a source revision was applied.'
              : presentDesignerError(error, 'agent')
          );
      } finally {
        if (token === operationToken.current) {
          aiSubmittingRef.current = false;
          localSubmissionProjectId.current = undefined;
          setAiSubmitting(false);
          onBusyChange(false);
          if (projectId === projectIdRef.current) {
            clearCancellation();
            focusStatus();
          }
        }
      }
    })();
  };
  const decideProposal = (operation: 'accept' | 'reject', input: AIProposalDecisionInput): void => {
    if (conversationBusy || proposalOperation !== undefined) return;
    const token = operationToken.current + 1;
    operationToken.current = token;
    const projectId = snapshot.source.projectId;
    setProposalOperation(operation);
    onBusyChange(true);
    onStatusChange(operation === 'accept' ? 'Accepting proposal…' : 'Rejecting proposal…');
    void (async () => {
      try {
        const next =
          operation === 'accept'
            ? await actions.acceptAIProposal(input)
            : await actions.rejectAIProposal(input);
        if (!isCurrent(token, projectId)) return;
        onSnapshot(next);
        await onRender(next);
        if (isCurrent(token, projectId))
          onStatusChange(
            operation === 'accept'
              ? `Accepted ${next.source.revision.id} and refreshed the canonical preview.`
              : 'Rejected the proposal and restored the current design.'
          );
      } catch (error) {
        if (isCurrent(token, projectId)) onStatusChange(presentDesignerError(error, 'agent'));
      } finally {
        if (isCurrent(token, projectId)) {
          setProposalOperation(undefined);
          onBusyChange(false);
          focusStatus();
        }
      }
    })();
  };
  const previewProposal = (input: AIProposalDecisionInput): void => {
    if (conversationBusy || proposalOperation !== undefined) return;
    const projectId = snapshot.source.projectId;
    setProposalOperation('preview');
    onBusyChange(true);
    onStatusChange('Opening the compiled proposal preview…');
    void onPreviewProposal(input)
      .then(() => {
        if (projectIdRef.current === projectId)
          onStatusChange('Previewing the staged AI proposal. Accept or reject it to continue.');
      })
      .catch((error: unknown) => {
        if (projectIdRef.current === projectId)
          onStatusChange(presentDesignerError(error, 'preview'));
      })
      .finally(() => {
        if (projectIdRef.current === projectId) {
          setProposalOperation(undefined);
          onBusyChange(false);
          focusStatus();
        }
      });
  };
  const reviseProposal = (request: AIChangeRequest, input: AIProposalDecisionInput): void => {
    if (conversationBusy || proposalOperation !== undefined) return;
    const token = operationToken.current + 1;
    operationToken.current = token;
    const projectId = snapshot.source.projectId;
    setProposalOperation('revise');
    onBusyChange(true);
    onStatusChange('Returning to the current design and preparing a revised request…');
    void (async () => {
      try {
        const next = await actions.rejectAIProposal(input);
        if (!isCurrent(token, projectId)) return;
        onSnapshot(next);
        await onRender(next);
        if (!isCurrent(token, projectId)) return;
        setInstruction(request.instruction);
        onPrepareProposalRevision(request);
        onStatusChange(
          'Proposal rejected. Edit the saved instruction, then send it as a new request.'
        );
      } catch (error) {
        if (isCurrent(token, projectId)) onStatusChange(presentDesignerError(error, 'agent'));
      } finally {
        if (isCurrent(token, projectId)) {
          setProposalOperation(undefined);
          onBusyChange(false);
          focusStatus();
        }
      }
    })();
  };

  const submitWithCurrentSelection = (source: 'composer' | 'retry', request?: AIChangeRequest) => {
    if (
      target === undefined ||
      selectionMintingRef.current ||
      (source === 'composer' && (selectedAgent === undefined || disabledReason !== undefined))
    )
      return;
    selectionMintingRef.current = true;
    setSelectionMinting(true);
    void actions
      .mintArtifactSelectionReceipt(target)
      .then((selectionReceipt) => {
        const input =
          source === 'composer'
            ? {
                kind: 'authenticated-element' as const,
                agentId: snapshot.selectedAgentId,
                instruction: instruction.trim(),
                selectionReceipt
              }
            : request === undefined
              ? undefined
              : requestInput(request, selectionReceipt);
        if (input === undefined)
          throw new Error('The saved request no longer accepts the current selection.');
        submit(input, source);
      })
      .catch((error: unknown) => onStatusChange(presentDesignerError(error, 'preview')))
      .finally(() => {
        selectionMintingRef.current = false;
        setSelectionMinting(false);
      });
  };
  const requestTargetedChange = () => submitWithCurrentSelection('composer');
  const retry = (request: AIChangeRequest) => {
    if (
      (request.status !== 'failed' && request.status !== 'cancelled') ||
      !snapshot.agents.some((agent) => agent.id === request.agentId)
    )
      return;
    if (undoSubmittingRef.current || !canStartOperation) return;
    if (target === undefined) {
      onStatusChange(
        'This saved targeted request needs a current compiler-authenticated selection. Select an element on the canvas, then retry.'
      );
      return;
    }
    submitWithCurrentSelection('retry', request);
  };
  const cancel = (requestId: string) => {
    if (
      activeRequestId !== requestId ||
      cancellingRequestRef.current !== undefined ||
      !requestActive
    )
      return;
    const projectId = snapshot.source.projectId;
    cancellingRequestRef.current = requestId;
    setCancellingRequestId(requestId);
    onStatusChange('Requesting cancellation from the selected agent…');
    void actions.cancelAIChange(requestId).then(
      () => {
        if (projectIdRef.current === projectId && cancellingRequestRef.current === requestId)
          onStatusChange('Cancellation requested. Waiting for the agent to stop safely…');
      },
      (error: unknown) => {
        if (projectIdRef.current === projectId && cancellingRequestRef.current === requestId) {
          clearCancellation(requestId);
          onStatusChange(presentDesignerError(error, 'agent'));
          focusStatus();
        }
      }
    );
  };
  const undo = (requestId: string) => {
    if (
      !canStartOperation ||
      undoSubmittingRef.current ||
      undoingRequestId !== undefined ||
      latestApplied?.id !== requestId ||
      latestApplied.resultingRevisionId !== snapshot.source.revision.id
    )
      return;
    const token = operationToken.current + 1;
    operationToken.current = token;
    const projectId = snapshot.source.projectId;
    undoSubmittingRef.current = true;
    setUndoingRequestId(requestId);
    onBusyChange(true);
    setUndoStatus('Creating a compensating revision…');
    void (async () => {
      try {
        const next = await actions.undoLastAIChange({ projectId, requestId });
        if (!isCurrent(token, projectId)) return;
        onSnapshot(next);
        setUndoStatus(
          `Saved compensating revision ${next.source.revision.id}. Waiting for its compiled preview receipt…`
        );
        try {
          await onRender(next);
          if (isCurrent(token, projectId))
            setUndoStatus('AI change undone and compiled preview refreshed.');
        } catch (error) {
          if (isCurrent(token, projectId))
            setUndoStatus(
              `AI undo was saved, but the compiled preview could not refresh. ${presentDesignerError(error, 'preview')}`
            );
        }
      } catch (error) {
        if (isCurrent(token, projectId)) setUndoStatus(presentDesignerError(error, 'agent'));
      } finally {
        if (isCurrent(token, projectId)) {
          undoSubmittingRef.current = false;
          setUndoingRequestId(undefined);
          onBusyChange(false);
          requestAnimationFrame(() => undoStatusRef.current?.focus());
        }
      }
    })();
  };
  const undoManual = (input: ManualDesignUndoInput, activityId: string): void => {
    if (undoSubmittingRef.current || !input.projectId || conversationBusy) return;
    const token = operationToken.current + 1;
    operationToken.current = token;
    const projectId = snapshot.source.projectId;
    undoSubmittingRef.current = true;
    setUndoingRequestId(activityId);
    setUndoStatus('Compiling a compensating manual revision…');
    onBusyChange(true);
    void (async () => {
      try {
        const next = await actions.undoLatestManualDesignEdit(input);
        if (!isCurrent(token, projectId)) return;
        onSnapshot(next);
        setUndoStatus('Manual change undone. Refreshing the compiled preview…');
        try {
          await onRender(next);
          if (isCurrent(token, projectId))
            setUndoStatus('Manual change undone and compiled preview refreshed.');
        } catch (error) {
          if (isCurrent(token, projectId))
            setUndoStatus(
              `Manual undo was saved, but the preview could not refresh. ${presentDesignerError(error, 'preview')}`
            );
        }
      } catch (error) {
        if (isCurrent(token, projectId)) setUndoStatus(presentDesignerError(error, 'canvas'));
      } finally {
        if (isCurrent(token, projectId)) {
          undoSubmittingRef.current = false;
          setUndoingRequestId(undefined);
          onBusyChange(false);
          requestAnimationFrame(() => undoStatusRef.current?.focus());
        }
      }
    })();
  };
  const onInstructionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing &&
      (event.metaKey || event.ctrlKey) &&
      event.key === 'Enter' &&
      disabledReason === undefined
    ) {
      event.preventDefault();
      requestTargetedChange();
    }
  };

  return (
    <>
      <section
        className="conversation-history"
        aria-label="Design activity and AI conversation history"
        aria-description="Use Tab to focus the conversation history, then use Arrow keys or Page Up and Page Down to scroll it."
        ref={historyRef}
        role="region"
        tabIndex={0}
      >
        <header className="conversation-history__header">
          <span className="agent-orb" aria-hidden="true" />
          <div>
            <p className="conversation-history__eyebrow">Local copilot</p>
            <h2>Design activity</h2>
            <p>
              {snapshot.agents.length === 0
                ? 'Agent setup is offline or incomplete'
                : `${snapshot.agents.length} configured ${snapshot.agents.length === 1 ? 'agent' : 'agents'} · ${selectedAgent?.label ?? 'No agent selected'}`}
            </p>
          </div>
        </header>
        {snapshot.agents.length === 0 ? (
          <section
            className="conversation-state conversation-state--offline"
            aria-label="Agent unavailable"
          >
            <strong>Agent unavailable</strong>
            <p>
              Finish trusted agent setup before sending a design change. Previous conversation
              remains local.
            </p>
          </section>
        ) : null}
        {snapshot.designActivity.length === 0 ? (
          <section className="conversation-state conversation-state--empty">
            <strong>Start with a request</strong>
            <p>Make a direct canvas edit or describe a change for a configured local agent.</p>
          </section>
        ) : (
          <>
            {hiddenActivityCount > 0 ? (
              <div className="conversation-history__earlier">
                <p className="conversation-history__summary">
                  Showing the latest {visibleActivity.length} of {snapshot.designActivity.length}{' '}
                  design changes.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const history = historyRef.current;
                    if (history)
                      historyExpansionAnchor.current = history.scrollHeight - history.scrollTop;
                    setVisibleRequestCount((current) =>
                      Math.min(snapshot.designActivity.length, current + 12)
                    );
                  }}
                >
                  Show {Math.min(12, hiddenActivityCount)} earlier
                </button>
              </div>
            ) : null}
            <ol className="conversation-history__requests">
              {visibleActivity.map((activity) => {
                if (activity.origin === 'manual') {
                  const manualUndo = activity.undo;
                  const undoEligible = !conversationBusy && manualUndo?.available === true;
                  const manualUndoDisabledReason = conversationBusy
                    ? 'Finish the current design operation before undoing this change.'
                    : manualUndo?.disabledReason === 'ALREADY_UNDONE'
                      ? 'This manual change has already been undone.'
                      : manualUndo?.disabledReason === 'NOT_LATEST'
                        ? 'Only the latest manual change can be undone.'
                        : 'The source has changed since this manual edit was applied.';
                  return (
                    <li
                      className="conversation-history__item conversation-history__item--manual"
                      data-status={activity.status}
                      key={activity.id}
                    >
                      <article className="conversation-message conversation-message--manual">
                        <p className="conversation-message__speaker">
                          <span aria-hidden="true">✦</span> {activity.actorLabel}{' '}
                          <strong>{activity.status}</strong>
                        </p>
                        <p>{activity.label}</p>
                        <div className="conversation-context" aria-label="Manual edit context">
                          <span>{activity.kind}</span>
                          <span>{new Date(activity.createdAt).toLocaleString()}</span>
                        </div>
                        {manualUndo ? (
                          <div
                            className="conversation-message__actions"
                            role="group"
                            aria-label="Manual edit actions"
                          >
                            <button
                              type="button"
                              disabled={!undoEligible}
                              onClick={() =>
                                undoManual(
                                  {
                                    projectId: snapshot.source.projectId,
                                    undoId: manualUndo.undoId,
                                    targetRevisionId: manualUndo.targetRevisionId
                                  },
                                  activity.id
                                )
                              }
                            >
                              {undoingRequestId === activity.id ? 'Undoing…' : 'Undo manual change'}
                            </button>
                            {!undoEligible ? (
                              <p className="conversation-message__disabled-reason">
                                {manualUndoDisabledReason}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    </li>
                  );
                }
                const request = snapshot.aiChangeRequests.find(
                  (candidate) => candidate.id === activity.referenceId
                );
                if (request === undefined) return null;
                const requestTarget = request.target;
                const scenario = snapshot.scenarios.find(
                  (item) => item.id === requestTarget?.scenarioId
                );
                const requestAgent = snapshot.agents.find((agent) => agent.id === request.agentId);
                const undoEligible =
                  !conversationBusy &&
                  undoingRequestId === undefined &&
                  latestApplied?.id === request.id &&
                  request.resultingRevisionId === snapshot.source.revision.id;
                const undoDisabledReason = undoEligible
                  ? undefined
                  : conversationBusy
                    ? 'Finish the current AI operation before undoing a request.'
                    : latestApplied?.id !== request.id
                      ? 'Only the latest applied AI change can be undone.'
                      : 'The source has changed since this AI result was applied.';
                const retryEligible =
                  !conversationBusy &&
                  (request.status === 'failed' || request.status === 'cancelled') &&
                  snapshot.agents.some((agent) => agent.id === request.agentId);
                const retryDisabledReason = retryEligible
                  ? undefined
                  : conversationBusy
                    ? 'Finish the current AI operation before retrying this request.'
                    : 'The original configured agent is no longer available.';
                const cancelEligible =
                  (request.status === 'queued' || request.status === 'running') &&
                  activeRequestId === request.id &&
                  cancellingRequestId === undefined;
                const pendingProposal =
                  snapshot.pendingAIProposal?.requestId === request.id
                    ? snapshot.pendingAIProposal
                    : undefined;
                const proposalInput =
                  pendingProposal === undefined
                    ? undefined
                    : {
                        projectId: snapshot.source.projectId,
                        requestId: pendingProposal.requestId,
                        candidateRevisionId: pendingProposal.candidateRevisionId
                      };
                return (
                  <li
                    className="conversation-history__item"
                    data-status={request.status}
                    key={request.id}
                  >
                    <article>
                      <section className="conversation-message conversation-message--user">
                        <p className="conversation-message__speaker">You</p>
                        <p>{request.instruction}</p>
                        <div className="conversation-context" aria-label="Request context">
                          {requestTarget === undefined ? (
                            <span>General workspace request</span>
                          ) : (
                            <>
                              <span>{targetSummary(requestTarget)}</span>
                              <span>{scenario?.title ?? requestTarget.scenarioId}</span>
                              <span>{requestTarget.revisionId}</span>
                            </>
                          )}
                        </div>
                      </section>
                      <section className="conversation-message conversation-message--agent">
                        <p className="conversation-message__speaker">
                          <span aria-hidden="true">AI</span>{' '}
                          {requestAgent?.label ?? request.agentId} <strong>{request.status}</strong>
                        </p>
                        <p>{requestOutcome(request)}</p>
                        <div
                          className="conversation-message__actions"
                          role="group"
                          aria-label="Request actions"
                        >
                          {request.status === 'applied' ? (
                            <>
                              <button
                                type="button"
                                disabled={!undoEligible}
                                aria-label={`Undo applied AI change: ${request.instruction}`}
                                onClick={() => undo(request.id)}
                              >
                                {undoingRequestId === request.id
                                  ? 'Undoing…'
                                  : 'Undo applied change'}
                              </button>
                              {undoDisabledReason ? (
                                <p className="conversation-message__disabled-reason">
                                  {undoDisabledReason}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                          {request.status === 'reviewing' && proposalInput !== undefined ? (
                            <>
                              <button
                                type="button"
                                disabled={conversationBusy}
                                aria-label={`Preview AI proposal: ${request.instruction}`}
                                onClick={() => previewProposal(proposalInput)}
                              >
                                {proposalOperation === 'preview'
                                  ? 'Opening preview…'
                                  : 'Preview proposal'}
                              </button>
                              <button
                                type="button"
                                disabled={conversationBusy}
                                aria-label={`Accept AI proposal: ${request.instruction}`}
                                onClick={() => decideProposal('accept', proposalInput)}
                              >
                                {proposalOperation === 'accept' ? 'Accepting…' : 'Accept proposal'}
                              </button>
                              <button
                                type="button"
                                disabled={conversationBusy}
                                aria-label={`Reject AI proposal: ${request.instruction}`}
                                onClick={() => decideProposal('reject', proposalInput)}
                              >
                                {proposalOperation === 'reject' ? 'Rejecting…' : 'Reject proposal'}
                              </button>
                              <button
                                type="button"
                                disabled={conversationBusy}
                                aria-label={`Reject and revise AI proposal: ${request.instruction}`}
                                onClick={() => reviseProposal(request, proposalInput)}
                              >
                                {proposalOperation === 'revise'
                                  ? 'Preparing revision…'
                                  : 'Reject and revise'}
                              </button>
                            </>
                          ) : null}
                          {request.status === 'failed' || request.status === 'cancelled' ? (
                            <>
                              <button
                                type="button"
                                disabled={!retryEligible}
                                aria-label={`Retry AI change: ${request.instruction}`}
                                onClick={() => retry(request)}
                              >
                                Retry request
                              </button>
                              {retryDisabledReason ? (
                                <p className="conversation-message__disabled-reason">
                                  {retryDisabledReason}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                          {request.status === 'queued' || request.status === 'running' ? (
                            <button
                              type="button"
                              disabled={!cancelEligible}
                              aria-label={`Cancel AI change: ${request.instruction}`}
                              onClick={() => cancel(request.id)}
                            >
                              {cancellingRequestId === request.id
                                ? 'Cancelling…'
                                : 'Cancel request'}
                            </button>
                          ) : null}
                        </div>
                      </section>
                    </article>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {undoStatus ? (
          <p className="request-history__status" ref={undoStatusRef} role="status" tabIndex={-1}>
            {safeDesignerNotice(undoStatus, 'AI undo status is unavailable. Try the change again.')}
          </p>
        ) : null}
        {progress && progressBelongsToCurrentProject ? (
          <p className="conversation-progress" aria-live="polite">
            AI update in progress…
          </p>
        ) : null}
      </section>
      <section
        aria-busy={conversationBusy || undefined}
        aria-label="AI change composer"
        className="conversation-composer"
      >
        <header className="conversation-composer__header">
          <p className="conversation-history__eyebrow">Design with AI</p>
          <h2>Create an AI design change</h2>
          <p>
            Choose an agent, describe the update, then select a current compiler-authenticated
            rendered React element.
          </p>
        </header>
        <label>
          Configured agent
          <select
            aria-label="Configured agent"
            disabled={conversationBusy || snapshot.agents.length === 0}
            value={snapshot.selectedAgentId}
            onChange={(event) =>
              void actions
                .selectAgent(event.currentTarget.value)
                .then((next) => {
                  onSnapshot(next);
                  onStatusChange(
                    `Selected ${next.agents.find((agent) => agent.id === next.selectedAgentId)?.label ?? 'configured agent'}.`
                  );
                })
                .catch((error: unknown) => onStatusChange(presentDesignerError(error, 'agent')))
            }
          >
            {snapshot.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Instruction
          <textarea
            aria-describedby="conversation-composer-reason"
            aria-label="AI change instruction"
            disabled={conversationBusy}
            value={instruction}
            onChange={(event) => setInstruction(event.currentTarget.value)}
            onKeyDown={onInstructionKeyDown}
          />
        </label>
        <p className="conversation-composer__target-summary">
          {target
            ? `${currentTargetSummary ?? 'Selected compiler-authenticated React element'} is ready for this change.`
            : 'No compiler-authenticated rendered React element is selected yet.'}
        </p>
        <div aria-label="AI change actions" className="conversation-composer__actions" role="group">
          <button
            className="conversation-composer__target"
            type="button"
            disabled={conversationBusy || selectedAgent === undefined}
            onClick={onSelectOnCanvas}
          >
            Select rendered element
          </button>
          {target ? (
            <button type="button" disabled={conversationBusy} onClick={onTargetClear}>
              Clear selected element
            </button>
          ) : null}
          {activeRequestId ? (
            <button
              className="conversation-composer__cancel"
              type="button"
              disabled={cancellingRequestId !== undefined}
              onClick={() => cancel(activeRequestId)}
            >
              {cancellingRequestId === activeRequestId ? 'Cancelling…' : 'Cancel active change'}
            </button>
          ) : null}
          <button
            className="conversation-composer__send"
            type="button"
            aria-describedby="conversation-composer-reason"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={disabledReason !== undefined}
            onClick={requestTargetedChange}
          >
            {aiSubmitting ? 'Applying change…' : 'Send AI change'}
          </button>
        </div>
        <p className="shortcut-hint">
          ⌘/Ctrl + Enter sends; Enter adds a line; Escape clears the selected element.
        </p>
        <p className="conversation-composer__reason" id="conversation-composer-reason">
          {disabledReason ?? 'Ready to send this AI change for the selected element.'}
        </p>
        <p className="conversation-composer__status" ref={statusRef} role="status" tabIndex={-1}>
          {safeDesignerNotice(status, 'AI status is unavailable. Try the change again.')}
        </p>
      </section>
    </>
  );
}
