import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type {
  AIChangeRequest,
  AIChangeRequestInput,
  AIChangeUndoInput,
  DesignerProgress,
  DesignerSnapshot,
  SpatialTargetInput
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
  cancelAIChange(requestId: string): Promise<void>;
  undoLastAIChange(input: AIChangeUndoInput): Promise<DesignerSnapshot>;
}

export interface AIConversationWorkspaceProps {
  readonly snapshot: DesignerSnapshot;
  readonly progress?: DesignerProgress;
  readonly target: SpatialTargetInput | undefined;
  readonly targetMode: 'idle' | 'ai' | 'review';
  readonly status: string;
  readonly actions: AIConversationWorkspaceActions;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onRender: (snapshot: DesignerSnapshot) => Promise<void>;
  readonly onStatusChange: (status: string) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onTargetModeChange: (mode: 'ai', invoking: HTMLButtonElement) => void;
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
  targetMode,
  status,
  actions,
  onSnapshot,
  onRender,
  onStatusChange,
  onBusyChange,
  onTargetModeChange,
  onTargetClear
}: AIConversationWorkspaceProps) {
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [cancellingRequestId, setCancellingRequestId] = useState<string | undefined>(undefined);
  const [undoingRequestId, setUndoingRequestId] = useState<string | undefined>(undefined);
  const [undoStatus, setUndoStatus] = useState<string | undefined>(undefined);
  const [visibleRequestCount, setVisibleRequestCount] = useState(12);
  const aiSubmittingRef = useRef(false);
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
    aiSubmitting || persistedActive !== undefined || progressRequestId !== undefined;
  const conversationBusy = isConversationBusy({
    requestActive,
    undoActive: undoSubmittingRef.current || undoingRequestId !== undefined
  });
  const canStartOperation = canStartConversationOperation({
    requestActive,
    undoActive: undoSubmittingRef.current || undoingRequestId !== undefined
  });
  const disabledReason = composerDisabledReason({
    agentAvailable: selectedAgent !== undefined,
    requestActive: conversationBusy,
    instruction,
    target
  });
  const visibleRequests = snapshot.aiChangeRequests.slice(-visibleRequestCount);
  const hiddenRequestCount = snapshot.aiChangeRequests.length - visibleRequests.length;
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
    localSubmissionProjectId.current = undefined;
    setAiSubmitting(false);
    undoSubmittingRef.current = false;
    setUndoingRequestId(undefined);
    setUndoStatus(undefined);
    setVisibleRequestCount(12);
    historyExpansionAnchor.current = undefined;
    cancelSettlingRef.current = false;
    onBusyChange(false);
    clearCancellation();
    onStatusChange('Choose a target when this change needs spatial context.');
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
        onStatusChange(
          `Saved ${next.source.revision.id}. Waiting for its compiled preview receipt…`
        );
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

  const requestTargetedChange = () => {
    if (target === undefined || selectedAgent === undefined || disabledReason !== undefined) return;
    submit(
      { agentId: snapshot.selectedAgentId, instruction: instruction.trim(), target },
      'composer'
    );
  };
  const retry = (request: AIChangeRequest) => {
    if (
      (request.status !== 'failed' && request.status !== 'cancelled') ||
      !snapshot.agents.some((agent) => agent.id === request.agentId)
    )
      return;
    if (undoSubmittingRef.current || !canStartOperation) return;
    submit(requestInput(request), 'retry');
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
        aria-label="AI conversation history"
        aria-description="Use Tab to focus the conversation history, then use Arrow keys or Page Up and Page Down to scroll it."
        ref={historyRef}
        role="region"
        tabIndex={0}
      >
        <header className="conversation-history__header">
          <span className="agent-orb" aria-hidden="true" />
          <div>
            <p className="conversation-history__eyebrow">Local copilot</p>
            <h2>Conversation</h2>
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
        ) : snapshot.aiChangeRequests.length === 0 ? (
          <section className="conversation-state conversation-state--empty">
            <strong>Start with a request</strong>
            <p>
              Describe the change, choose a preview target, then send it to the selected local
              agent.
            </p>
          </section>
        ) : (
          <>
            {hiddenRequestCount > 0 ? (
              <div className="conversation-history__earlier">
                <p className="conversation-history__summary">
                  Showing the latest {visibleRequests.length} of {snapshot.aiChangeRequests.length}{' '}
                  requests.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const history = historyRef.current;
                    if (history)
                      historyExpansionAnchor.current = history.scrollHeight - history.scrollTop;
                    setVisibleRequestCount((current) =>
                      Math.min(snapshot.aiChangeRequests.length, current + 12)
                    );
                  }}
                >
                  Show {Math.min(12, hiddenRequestCount)} earlier
                </button>
              </div>
            ) : null}
            <ol className="conversation-history__requests">
              {visibleRequests.map((request) => {
                const scenario = snapshot.scenarios.find(
                  (item) => item.id === request.target.scenarioId
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
                          <span>{targetSummary(request.target)}</span>
                          <span>{scenario?.title ?? request.target.scenarioId}</span>
                          <span>{request.target.revisionId}</span>
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
          <h2>Target a design change</h2>
          <p>Choose an agent, describe the update, then target the relevant preview region.</p>
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
          {target ? `AI target: ${targetSummary(target)}.` : 'No preview target selected yet.'}
        </p>
        <div
          aria-label="Targeted change actions"
          className="conversation-composer__actions"
          role="group"
        >
          <button
            className="conversation-composer__target"
            type="button"
            aria-pressed={targetMode === 'ai'}
            disabled={conversationBusy || selectedAgent === undefined}
            onClick={(event) => {
              onTargetModeChange('ai', event.currentTarget);
              onStatusChange(
                targetMode === 'ai'
                  ? 'AI target selection cancelled. Your draft and saved target remain available.'
                  : 'Choose a free point or region in the preview. Press Escape to cancel.'
              );
            }}
          >
            {targetMode === 'ai' ? 'Cancel AI target' : 'Target AI change'}
          </button>
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
            {aiSubmitting ? 'Applying change…' : 'Send targeted change'}
          </button>
        </div>
        <p className="shortcut-hint">
          ⌘/Ctrl + Enter sends; Enter adds a line; Escape cancels target selection.
        </p>
        <p className="conversation-composer__reason" id="conversation-composer-reason">
          {disabledReason ?? 'Ready to send this targeted change.'}
        </p>
        <p className="conversation-composer__status" ref={statusRef} role="status" tabIndex={-1}>
          {safeDesignerNotice(status, 'AI status is unavailable. Try the change again.')}
        </p>
      </section>
    </>
  );
}
