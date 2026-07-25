import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject
} from 'react';

import { PrototypeFlowCanvas } from '@selene/ui/prototype';

import type {
  AIChangeRequestInput,
  DesignerProgress,
  DesignerSnapshot,
  DeveloperAnnotationInput,
  ReviewThreadInput,
  ReviewThreadReplyInput,
  ReviewThreadResolutionInput,
  SpatialTargetInput,
  WorkspaceCockpitPreferences
} from '../../../shared/designer-api';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { PreviewSurface, type PreviewBuild } from './preview-surface';

export const inspectorTabs = ['inspect', 'flow', 'reviews', 'handoff', 'setup'] as const;
export type InspectorTab = (typeof inspectorTabs)[number];
const paneMinimum = 220;
const paneMaximum = 520;
const initialReplyDraft = 'Acknowledged; follow-up recorded.';
function clampPane(value: number): number {
  return Math.min(paneMaximum, Math.max(paneMinimum, Math.round(value)));
}

export interface DesktopCockpitActions {
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  addReviewThread(input: ReviewThreadInput): Promise<DesignerSnapshot>;
  resolveReviewThread(input: ReviewThreadResolutionInput): Promise<DesignerSnapshot>;
  replyToReviewThread(input: ReviewThreadReplyInput): Promise<DesignerSnapshot>;
  addDeveloperAnnotation(input: DeveloperAnnotationInput): Promise<DesignerSnapshot>;
  savePrototypeGraph(
    graph: DesignerSnapshot['editablePrototype']['graph']
  ): Promise<DesignerSnapshot>;
  retryPrototypeGraphHydration(): Promise<DesignerSnapshot>;
  recoverPrototypeGraphFromFixture(): Promise<DesignerSnapshot>;
  setPrototypeMode(mode: 'edit' | 'run'): Promise<DesignerSnapshot>;
  resetPrototypeRun(): Promise<DesignerSnapshot>;
}

export interface DesktopCockpitProps {
  readonly snapshot: DesignerSnapshot;
  readonly build?: PreviewBuild;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: () => void;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onRender: (snapshot: DesignerSnapshot) => Promise<void>;
  readonly actions: DesktopCockpitActions;
  readonly guidedActions: GuidedSetupActions;
  readonly progress?: DesignerProgress;
  readonly preferences?: WorkspaceCockpitPreferences;
  readonly onPreferencesChange?: (preferences: WorkspaceCockpitPreferences) => void;
  readonly initialSelectedThreadId?: string;
}

function targetAt(
  element: HTMLElement,
  clientX: number,
  clientY: number
): SpatialTargetInput | undefined {
  const box = element.getBoundingClientRect();
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  )
    return undefined;
  return {
    x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    viewport: { width: Math.round(box.width), height: Math.round(box.height) }
  };
}

/** The production renderer cockpit. Host authority arrives only through typed actions. */
export function DesktopCockpit({
  snapshot,
  build,
  frame,
  onFrameLoad,
  onSnapshot,
  onRender,
  actions,
  guidedActions,
  progress,
  preferences,
  onPreferencesChange,
  initialSelectedThreadId
}: DesktopCockpitProps) {
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [annotation, setAnnotation] = useState('Preserve keyboard focus after this change.');
  const [aiTarget, setAiTarget] = useState<SpatialTargetInput>();
  const [reviewTarget, setReviewTarget] = useState<SpatialTargetInput>();
  const [targetMode, setTargetMode] = useState<'idle' | 'ai' | 'review'>('idle');
  const [selectedArtifactPinId, setSelectedArtifactPinId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    initialSelectedThreadId
  );
  const [reviewBody, setReviewBody] = useState('Verify this spatial region.');
  const [replyDrafts, setReplyDrafts] = useState<Readonly<Record<string, string>>>({});
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');
  const [aiStatus, setAiStatus] = useState(
    'Choose a target when this change needs spatial context.'
  );
  const [reviewStatus, setReviewStatus] = useState(
    'Choose a preview location before creating a stakeholder thread.'
  );
  const [threadStatus, setThreadStatus] = useState<{
    readonly threadId: string;
    readonly message: string;
  }>();
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [threadAction, setThreadAction] = useState<'idle' | 'replying' | 'resolving'>('idle');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspect');
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(340);
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);
  const resizing = useRef<'left' | 'right' | undefined>(undefined);
  const aiSubmittingRef = useRef(false);
  const reviewSubmittingRef = useRef(false);
  const threadActionRef = useRef<'idle' | 'replying' | 'resolving'>('idle');
  const targetInvokingControl = useRef<HTMLElement | null>(null);
  const threadInvokingControl = useRef<HTMLElement | null>(null);
  const inspectorTabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const paneWidths = useRef({ left: leftWidth, right: rightWidth });
  const selectedScenario = snapshot.scenarios.find(
    (item) => item.id === snapshot.selectedScenarioId
  );
  const selectedAgent = snapshot.agents.find((agent) => agent.id === snapshot.selectedAgentId);
  const configuredAgentCount = snapshot.agents.length;
  const agentAvailability =
    configuredAgentCount === 0
      ? 'No configured agents'
      : `${configuredAgentCount} configured ${
          configuredAgentCount === 1 ? 'agent' : 'agents'
        } · ${selectedAgent?.label ?? 'No agent selected'}`;
  const selectedThread = snapshot.reviewThreads.find((thread) => thread.id === selectedThreadId);
  const replyBody = selectedThread ? (replyDrafts[selectedThread.id] ?? initialReplyDraft) : '';
  const restoreFocus = (control: HTMLElement | null) =>
    requestAnimationFrame(() => control?.focus());
  const cancelTargetSelection = () => {
    if (targetMode === 'idle') return false;
    const cancelled = targetMode;
    setTargetMode('idle');
    if (cancelled === 'ai')
      setAiStatus('AI target selection cancelled. Your draft and saved target remain available.');
    else
      setReviewStatus(
        'Review location selection cancelled. Your draft and saved location remain available.'
      );
    restoreFocus(targetInvokingControl.current);
    return true;
  };
  const closeSelectedThread = () => {
    setThreadStatus(undefined);
    setSelectedThreadId(undefined);
    restoreFocus(threadInvokingControl.current);
  };
  const toggleTargetMode = (mode: 'ai' | 'review', invoking: HTMLElement) => {
    if (targetMode === mode) {
      cancelTargetSelection();
      return;
    }
    targetInvokingControl.current = invoking;
    setTargetMode(mode);
    if (mode === 'ai')
      setAiStatus('Choose a free point or region in the preview. Press Escape to cancel.');
    else
      setReviewStatus(
        'Choose a stakeholder discussion location in the preview. Press Escape to cancel.'
      );
  };
  const completeTargetSelection = (target: SpatialTargetInput) => {
    if (targetMode === 'ai') setAiTarget(target);
    if (targetMode === 'review') setReviewTarget(target);
    setTargetMode('idle');
    requestAnimationFrame(() => targetInvokingControl.current?.focus());
  };
  const persistPreferences = (change: Partial<WorkspaceCockpitPreferences>) =>
    onPreferencesChange?.({
      format: 'selene-workspace-cockpit-preferences/v1',
      leftRailWidth: change.leftRailWidth ?? leftWidth,
      rightRailWidth: change.rightRailWidth ?? rightWidth,
      leftRailCollapsed: change.leftRailCollapsed ?? leftCollapsed,
      rightRailCollapsed: change.rightRailCollapsed ?? rightCollapsed,
      inspectorTab: change.inspectorTab ?? inspectorTab
    });
  useEffect(() => {
    if (!preferences) return;
    paneWidths.current = { left: preferences.leftRailWidth, right: preferences.rightRailWidth };
    setLeftWidth(preferences.leftRailWidth);
    setRightWidth(preferences.rightRailWidth);
    setLeftCollapsed(preferences.leftRailCollapsed);
    setRightCollapsed(preferences.rightRailCollapsed);
    setInspectorTab(preferences.inspectorTab);
  }, [preferences]);
  useEffect(() => {
    const retained = new Set(snapshot.reviewThreads.map((thread) => thread.id));
    setReplyDrafts((current) => {
      const removed = Object.keys(current).filter((id) => !retained.has(id));
      if (removed.length === 0) return current;
      const next = { ...current };
      for (const id of removed) delete next[id];
      return next;
    });
  }, [snapshot.reviewThreads]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
      if (targetMode !== 'idle') {
        event.preventDefault();
        setTargetMode('idle');
        if (targetMode === 'ai')
          setAiStatus(
            'AI target selection cancelled. Your draft and saved target remain available.'
          );
        else
          setReviewStatus(
            'Review location selection cancelled. Your draft and saved location remain available.'
          );
        requestAnimationFrame(() => targetInvokingControl.current?.focus());
        return;
      }
      if (selectedThreadId !== undefined) {
        event.preventDefault();
        setThreadStatus(undefined);
        setSelectedThreadId(undefined);
        requestAnimationFrame(() => threadInvokingControl.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [targetMode, selectedThreadId]);
  const selectArtifactPin = (id: string, invoking?: HTMLElement) => {
    setThreadStatus(undefined);
    setSelectedArtifactPinId(id);
    const thread = snapshot.reviewThreads.find((item) => item.id === id);
    if (thread && invoking) threadInvokingControl.current = invoking;
    setSelectedThreadId(thread?.id);
  };
  const selectThread = (id: string, invoking?: HTMLElement) => {
    setThreadStatus(undefined);
    setSelectedThreadId(id);
    if (invoking) threadInvokingControl.current = invoking;
    setSelectedArtifactPinId(snapshot.artifactPins.some((item) => item.id === id) ? id : undefined);
  };
  const createReviewThread = (invoking: HTMLElement) => {
    if (!reviewTarget || reviewSubmittingRef.current) return;
    reviewSubmittingRef.current = true;
    setReviewSubmitting(true);
    setReviewStatus('Saving stakeholder review thread…');
    void actions
      .addReviewThread({ body: reviewBody, anchor: reviewTarget })
      .then((next) => {
        const created = next.reviewThreads.find(
          (thread) => !snapshot.reviewThreads.some((current) => current.id === thread.id)
        );
        onSnapshot(next);
        if (created) {
          threadInvokingControl.current = invoking;
          setSelectedThreadId(created.id);
          setSelectedArtifactPinId(next.artifactPins.find((pin) => pin.id === created.id)?.id);
          setThreadStatus(undefined);
        }
        setReviewTarget(undefined);
        setReviewBody('');
        setReviewStatus(
          created
            ? 'Added and selected the new stakeholder review thread.'
            : 'Saved stakeholder review thread.'
        );
      })
      .catch((error: unknown) =>
        setReviewStatus(
          error instanceof Error ? error.message : 'Could not create stakeholder review thread.'
        )
      )
      .finally(() => {
        reviewSubmittingRef.current = false;
        setReviewSubmitting(false);
      });
  };
  const requestTargetedChange = () => {
    if (!aiTarget || !selectedAgent || !instruction.trim() || aiSubmittingRef.current) return;
    aiSubmittingRef.current = true;
    setAiSubmitting(true);
    setAiStatus('Applying targeted AI change…');
    void actions
      .requestAIChange({ agentId: snapshot.selectedAgentId, instruction, target: aiTarget })
      .then(async (next) => {
        onSnapshot(next);
        await onRender(next);
        setAiTarget(undefined);
        setAiStatus(`Applied ${next.source.revision.id} and refreshed the compiled preview.`);
      })
      .catch((error: unknown) =>
        setAiStatus(error instanceof Error ? error.message : 'AI request failed.')
      )
      .finally(() => {
        aiSubmittingRef.current = false;
        setAiSubmitting(false);
      });
  };
  const replyToSelectedThread = async (id: string, body: string): Promise<void> => {
    if (threadActionRef.current !== 'idle') return;
    threadActionRef.current = 'replying';
    setThreadAction('replying');
    try {
      const next = await actions.replyToReviewThread({ id, body });
      onSnapshot(next);
      setReplyDrafts((current) => ({ ...current, [id]: '' }));
      setThreadStatus({ threadId: id, message: 'Stakeholder reply saved.' });
    } catch (error) {
      setThreadStatus({
        threadId: id,
        message: error instanceof Error ? error.message : 'Could not reply to review thread.'
      });
    } finally {
      threadActionRef.current = 'idle';
      setThreadAction('idle');
    }
  };
  const resolveSelectedThread = async (id: string, resolved: boolean): Promise<void> => {
    if (threadActionRef.current !== 'idle') return;
    threadActionRef.current = 'resolving';
    setThreadAction('resolving');
    try {
      const next = await actions.resolveReviewThread({ id, resolved });
      onSnapshot(next);
      setThreadStatus({
        threadId: id,
        message: resolved ? 'Stakeholder thread resolved.' : 'Stakeholder thread reopened.'
      });
    } catch (error) {
      setThreadStatus({
        threadId: id,
        message: error instanceof Error ? error.message : 'Could not update review thread.'
      });
    } finally {
      threadActionRef.current = 'idle';
      setThreadAction('idle');
    }
  };
  const beginResize = (side: 'left' | 'right') => (event: PointerEvent<HTMLDivElement>) => {
    if ((side === 'left' && leftCollapsed) || (side === 'right' && rightCollapsed)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = side;
  };
  const updateResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizing.current === 'left') {
      const next = clampPane(event.clientX);
      paneWidths.current.left = next;
      setLeftWidth(next);
    }
    if (resizing.current === 'right') {
      const next = clampPane(window.innerWidth - event.clientX);
      paneWidths.current.right = next;
      setRightWidth(next);
    }
  };
  const persistResize = () => {
    if (resizing.current === 'left') persistPreferences({ leftRailWidth: paneWidths.current.left });
    if (resizing.current === 'right')
      persistPreferences({ rightRailWidth: paneWidths.current.right });
    resizing.current = undefined;
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    persistResize();
  };
  const resizeWithKeyboard = (side: 'left' | 'right') => (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
    if (delta === 0) return;
    event.preventDefault();
    if (side === 'left') {
      const next = clampPane(leftWidth + delta);
      paneWidths.current.left = next;
      setLeftWidth(next);
      persistPreferences({ leftRailWidth: next });
    } else {
      const next = clampPane(rightWidth - delta);
      paneWidths.current.right = next;
      setRightWidth(next);
      persistPreferences({ rightRailWidth: next });
    }
  };
  useEffect(
    () => () => {
      resizing.current = undefined;
    },
    []
  );
  const apply = (work: Promise<DesignerSnapshot>, message?: string) =>
    void work
      .then(onSnapshot)
      .then(() => message && setGraphSaveStatus(message))
      .catch((error: unknown) =>
        setGraphSaveStatus(error instanceof Error ? error.message : 'Host operation failed.')
      );
  const saveGraph = (graph: DesignerSnapshot['editablePrototype']['graph']) => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required') return;
    setGraphSaveStatus('Saving graph revision…');
    apply(actions.savePrototypeGraph(graph), 'Saved graph revision.');
  };
  const selectInspectorTab = (tab: InspectorTab, focus = false) => {
    setInspectorTab(tab);
    persistPreferences({ inspectorTab: tab });
    if (focus) requestAnimationFrame(() => inspectorTabRefs.current.get(tab)?.focus());
  };
  const inspectorTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = inspectorTabs.indexOf(inspectorTab);
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % inspectorTabs.length
        : event.key === 'ArrowLeft'
          ? (current + inspectorTabs.length - 1) % inspectorTabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? inspectorTabs.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectInspectorTab(inspectorTabs[next]!, true);
  };
  return (
    <div
      className="workspace-layout"
      style={
        {
          '--workspace-left-rail': `${leftWidth}px`,
          '--workspace-right-rail': `${rightWidth}px`
        } as CSSProperties
      }
      data-left-collapsed={leftCollapsed || undefined}
      data-right-collapsed={rightCollapsed || undefined}
      data-target-mode={targetMode}
    >
      <aside className="conversation-rail" aria-label="AI conversation">
        <button
          className="pane-toggle"
          type="button"
          aria-pressed={leftCollapsed}
          onClick={() => {
            const next = !leftCollapsed;
            setLeftCollapsed(next);
            persistPreferences({ leftRailCollapsed: next });
          }}
        >
          {leftCollapsed ? 'Show AI rail' : 'Hide AI rail'}
        </button>
        {leftCollapsed ? null : (
          <>
            <section className="conversation-history" aria-label="AI conversation history">
              <header className="conversation-history__header">
                <span className="agent-orb" aria-hidden="true" />
                <div>
                  <p className="conversation-history__eyebrow">Local copilot</p>
                  <h2>Conversation</h2>
                  <p>{agentAvailability}</p>
                </div>
              </header>
              <p className="agent-message">
                <span>AI</span>Target the preview region you want the selected agent to change.
              </p>
              {snapshot.aiChangeRequests.length === 0 ? (
                <p className="conversation-history__empty">
                  No AI changes have been requested for this project.
                </p>
              ) : (
                <ol className="conversation-history__requests">
                  {snapshot.aiChangeRequests
                    .slice(-6)
                    .reverse()
                    .map((request) => (
                      <li className="conversation-history__item" key={request.id}>
                        <strong>{request.status}</strong>
                        {request.instruction}
                      </li>
                    ))}
                </ol>
              )}
              {progress ? (
                <p className="conversation-progress" aria-live="polite">
                  {progress.stage}: {progress.message}
                </p>
              ) : null}
            </section>
            <section
              aria-busy={aiSubmitting || undefined}
              aria-label="AI change composer"
              className="conversation-composer"
            >
              <header className="conversation-composer__header">
                <p className="conversation-history__eyebrow">New request</p>
                <h2>Targeted change</h2>
                <p>
                  Choose an agent, describe the update, then target the relevant preview region.
                </p>
              </header>
              <label>
                Configured agent
                <select
                  aria-label="Configured agent"
                  disabled={aiSubmitting || snapshot.agents.length === 0}
                  value={snapshot.selectedAgentId}
                  onChange={(event) =>
                    void actions
                      .selectAgent(event.currentTarget.value)
                      .then((next) => {
                        onSnapshot(next);
                        setAiStatus(
                          `Selected ${next.agents.find((agent) => agent.id === next.selectedAgentId)?.label ?? 'configured agent'}.`
                        );
                      })
                      .catch((error: unknown) =>
                        setAiStatus(
                          error instanceof Error ? error.message : 'Could not select agent.'
                        )
                      )
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
                  aria-label="AI change instruction"
                  disabled={aiSubmitting}
                  value={instruction}
                  onChange={(event) => setInstruction(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (
                      !event.defaultPrevented &&
                      !event.nativeEvent.isComposing &&
                      (event.metaKey || event.ctrlKey) &&
                      event.key === 'Enter' &&
                      aiTarget &&
                      instruction.trim() &&
                      !aiSubmittingRef.current
                    ) {
                      event.preventDefault();
                      requestTargetedChange();
                    }
                  }}
                />
              </label>
              <p>
                {aiTarget
                  ? `Saved AI target: ${(aiTarget.x * 100).toFixed(0)}%, ${(aiTarget.y * 100).toFixed(0)}%`
                  : 'Select AI target mode to create an AI change request.'}
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
                  disabled={aiSubmitting || !selectedAgent}
                  onClick={(event) => toggleTargetMode('ai', event.currentTarget)}
                >
                  {targetMode === 'ai' ? 'Cancel AI target' : 'Target AI change'}
                </button>
                <button
                  className="conversation-composer__send"
                  type="button"
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  disabled={!aiTarget || !instruction.trim() || !selectedAgent || aiSubmitting}
                  onClick={requestTargetedChange}
                >
                  {aiSubmitting ? 'Applying change…' : 'Send targeted change'}
                </button>
              </div>
              <p className="shortcut-hint">
                ⌘/Ctrl + Enter sends; Escape cancels target selection.
              </p>
              <p className="conversation-composer__status" role="status" aria-live="polite">
                {aiStatus}
              </p>
            </section>
          </>
        )}
      </aside>
      <div
        className="workspace-pane-resizer"
        role="separator"
        aria-label="Resize AI conversation rail"
        aria-orientation="vertical"
        aria-valuemin={paneMinimum}
        aria-valuemax={paneMaximum}
        aria-valuenow={leftWidth}
        tabIndex={leftCollapsed ? -1 : 0}
        onPointerDown={beginResize('left')}
        onPointerMove={updateResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={persistResize}
        onKeyDown={resizeWithKeyboard('left')}
      />
      <PreviewSurface
        {...(build === undefined ? {} : { build })}
        revisionId={snapshot.source.revision.id}
        readiness={snapshot.baseline.readiness}
        frame={frame}
        onFrameLoad={onFrameLoad}
        targeting={targetMode !== 'idle'}
        targetMode={targetMode}
        {...(aiTarget === undefined ? {} : { aiTarget })}
        {...(reviewTarget === undefined ? {} : { reviewTarget })}
        onTargetPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          const start = targetAt(event.currentTarget, event.clientX, event.clientY);
          if (!start) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = start;
        }}
        onTargetPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
          const start = dragStart.current;
          const end = targetAt(event.currentTarget, event.clientX, event.clientY);
          dragStart.current = undefined;
          if (!start || !end) {
            cancelTargetSelection();
            return;
          }
          const right = Math.max(start.x, end.x);
          const bottom = Math.max(start.y, end.y);
          const region = {
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: right - Math.min(start.x, end.x),
            height: bottom - Math.min(start.y, end.y),
            viewport: start.viewport
          };
          completeTargetSelection(region.width === 0 && region.height === 0 ? start : region);
        }}
        onTargetPointerCancel={() => {
          dragStart.current = undefined;
          cancelTargetSelection();
        }}
        onTargetClick={(event: PointerEvent<HTMLButtonElement>) => {
          if (event.detail !== 0) return;
          const box = event.currentTarget.getBoundingClientRect();
          const selected = targetAt(
            event.currentTarget,
            box.left + box.width / 2,
            box.top + box.height / 2
          );
          if (selected) completeTargetSelection(selected);
        }}
        pins={snapshot.artifactPins}
        {...(selectedArtifactPinId === undefined ? {} : { selectedPinId: selectedArtifactPinId })}
        onSelectPin={selectArtifactPin}
        {...(selectedThread === undefined ? {} : { selectedThread })}
        replyBody={replyBody}
        threadAction={threadAction}
        threadStatus={
          selectedThread && threadStatus?.threadId === selectedThread.id ? threadStatus.message : ''
        }
        onReplyBodyChange={(body) => {
          if (selectedThread)
            setReplyDrafts((current) => ({ ...current, [selectedThread.id]: body }));
        }}
        onReplyThread={replyToSelectedThread}
        onResolveThread={resolveSelectedThread}
        onCloseThread={closeSelectedThread}
      />
      <div
        className="workspace-pane-resizer"
        role="separator"
        aria-label="Resize inspector rail"
        aria-orientation="vertical"
        aria-valuemin={paneMinimum}
        aria-valuemax={paneMaximum}
        aria-valuenow={rightWidth}
        tabIndex={rightCollapsed ? -1 : 0}
        onPointerDown={beginResize('right')}
        onPointerMove={updateResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={persistResize}
        onKeyDown={resizeWithKeyboard('right')}
      />
      <aside className="inspector" aria-label="Progressive inspector">
        <button
          className="pane-toggle"
          type="button"
          aria-pressed={rightCollapsed}
          onClick={() => {
            const next = !rightCollapsed;
            setRightCollapsed(next);
            persistPreferences({ rightRailCollapsed: next });
          }}
        >
          {rightCollapsed ? 'Show inspector' : 'Hide inspector'}
        </button>
        {rightCollapsed ? null : (
          <>
            <div className="inspector-tabs" role="tablist" aria-label="Workspace inspector">
              {inspectorTabs.map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  type="button"
                  ref={(element) => {
                    if (element) inspectorTabRefs.current.set(tab, element);
                    else inspectorTabRefs.current.delete(tab);
                  }}
                  tabIndex={inspectorTab === tab ? 0 : -1}
                  aria-selected={inspectorTab === tab}
                  aria-controls={`inspector-${tab}`}
                  id={`inspector-tab-${tab}`}
                  onKeyDown={inspectorTabKeyDown}
                  onClick={() => selectInspectorTab(tab)}
                >
                  {tab === 'inspect' ? 'Inspect' : tab[0]!.toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            {inspectorTab === 'inspect' ? (
              <section
                id="inspector-inspect"
                role="tabpanel"
                aria-labelledby="inspector-tab-inspect"
              >
                <h2>Selection</h2>
                <p>
                  {selectedScenario?.title} · {selectedScenario?.state}
                </p>
                <p>{selectedScenario?.navigation.map((step) => step.route).join(' → ')}</p>
                <h2>Design baseline</h2>
                <p>
                  {snapshot.baseline.readiness} / {snapshot.baseline.currency}
                </p>
                <p>
                  {snapshot.baseline.changesSinceBaseline.length} changes since{' '}
                  {snapshot.baseline.baseline?.intent ?? 'design'} baseline
                </p>
                {snapshot.baseline.approvalsStale ? <p>Prior approvals are stale.</p> : null}
                <h2>Component catalog</h2>
                {snapshot.componentCatalog.entries.map((entry) => (
                  <p key={entry.component}>{entry.component}</p>
                ))}
              </section>
            ) : null}
            {inspectorTab === 'flow' ? (
              <section id="inspector-flow" role="tabpanel" aria-labelledby="inspector-tab-flow">
                <h2>Saved prototype flow</h2>
                <p>
                  Revision {snapshot.editablePrototype.revision} is persisted by the local host.
                </p>
                <p aria-live="polite">{graphSaveStatus}</p>
                {snapshot.prototypeGraphHydration.state === 'recovery-required' ? (
                  <section className="workspace-notice" role="alert">
                    <p>{snapshot.prototypeGraphHydration.message}</p>
                    {snapshot.prototypeGraphHydration.recovery ? (
                      <p>
                        Recovery receipt: {snapshot.prototypeGraphHydration.recovery.recoveryId} (
                        {snapshot.prototypeGraphHydration.recovery.capturedBytes ?? 0} bytes
                        preserved).
                      </p>
                    ) : null}
                    <p>
                      Edits are read-only until the saved artifact is retried or explicitly
                      recovered.
                    </p>
                    <button
                      type="button"
                      onClick={() => apply(actions.retryPrototypeGraphHydration())}
                    >
                      Retry saved graph
                    </button>
                    <button
                      type="button"
                      onClick={() => apply(actions.recoverPrototypeGraphFromFixture())}
                    >
                      Recover from fixture
                    </button>
                  </section>
                ) : null}
                <button
                  type="button"
                  disabled={snapshot.prototypeGraphHydration.state === 'recovery-required'}
                  onClick={() =>
                    apply(
                      actions.setPrototypeMode(
                        snapshot.editablePrototype.mode === 'edit' ? 'run' : 'edit'
                      )
                    )
                  }
                >
                  {snapshot.editablePrototype.mode === 'edit'
                    ? 'Run saved flow'
                    : 'Edit saved flow'}
                </button>
                {snapshot.editablePrototype.mode === 'edit' ? (
                  <PrototypeFlowCanvas
                    graph={snapshot.editablePrototype.graph}
                    onGraphChange={
                      snapshot.prototypeGraphHydration.state === 'recovery-required'
                        ? undefined
                        : saveGraph
                    }
                    readOnly={snapshot.prototypeGraphHydration.state === 'recovery-required'}
                  />
                ) : (
                  <div>
                    <p>Run mode is bound to the saved revision and cannot mutate ports or edges.</p>
                    <button type="button" onClick={() => apply(actions.resetPrototypeRun())}>
                      Reset scenario
                    </button>
                    {snapshot.editablePrototype.runtime ? (
                      <PrototypeFlowCanvas
                        graph={snapshot.editablePrototype.graph}
                        activeNodeIds={[snapshot.editablePrototype.runtime.activeNodeId]}
                        activeTransitionIds={
                          snapshot.editablePrototype.runtime.activePathTransitionIds
                        }
                        readOnly
                      />
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
            {inspectorTab === 'reviews' ? (
              <section
                id="inspector-reviews"
                role="tabpanel"
                aria-labelledby="inspector-tab-reviews"
              >
                <h2>Stakeholder review</h2>
                <button
                  className="review-location-action"
                  type="button"
                  aria-pressed={targetMode === 'review'}
                  onClick={(event) => toggleTargetMode('review', event.currentTarget)}
                >
                  {targetMode === 'review' ? 'Cancel review location' : 'Pick review location'}
                </button>
                <p>
                  {reviewTarget
                    ? `Saved review location: ${(reviewTarget.x * 100).toFixed(0)}%, ${(reviewTarget.y * 100).toFixed(0)}%`
                    : 'Choose a free point or region in the preview before creating a thread.'}
                </p>
                <label>
                  Stakeholder thread
                  <textarea
                    aria-label="Stakeholder review thread body"
                    disabled={reviewSubmitting}
                    value={reviewBody}
                    onChange={(event) => setReviewBody(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!reviewTarget || !reviewBody.trim() || reviewSubmitting}
                  onClick={(event) => createReviewThread(event.currentTarget)}
                >
                  {reviewSubmitting ? 'Saving thread…' : 'Add stakeholder thread'}
                </button>
                <p className="shortcut-hint">
                  Escape cancels review location selection; thread reply shortcuts are shown at the
                  selected pin.
                </p>
                <p className="review-status" role="status" aria-live="polite">
                  {reviewStatus}
                </p>
                <p className="review-pin-note">
                  Pins are derived from durable stakeholder threads; standalone pins are not created
                  here.
                </p>
                <h2>Spatial review threads</h2>
                {snapshot.reviewThreads.length === 0 ? (
                  <p className="inspector-empty">
                    No stakeholder threads yet. Pick a preview location to start a durable
                    discussion.
                  </p>
                ) : (
                  snapshot.reviewThreads.map((thread) => (
                    <button
                      className="review-thread-row"
                      key={thread.id}
                      type="button"
                      aria-pressed={selectedThreadId === thread.id}
                      onClick={(event) => selectThread(thread.id, event.currentTarget)}
                    >
                      <strong>{thread.status}</strong>
                      <span>{thread.body}</span>
                      <small>{thread.replies.length} replies</small>
                    </button>
                  ))
                )}
                <h2>Artifact pins</h2>
                {snapshot.artifactPins.length === 0 ? (
                  <p className="inspector-empty">
                    Pins appear here after a stakeholder thread is saved.
                  </p>
                ) : (
                  snapshot.artifactPins.map((pin) => (
                    <button
                      key={pin.id}
                      type="button"
                      aria-pressed={selectedArtifactPinId === pin.id}
                      onClick={(event) => selectArtifactPin(pin.id, event.currentTarget)}
                    >
                      {pin.label}: {Math.round(pin.anchor.x * 100)}%,{' '}
                      {Math.round(pin.anchor.y * 100)}%
                    </button>
                  ))
                )}
              </section>
            ) : null}
            {inspectorTab === 'handoff' ? (
              <section
                id="inspector-handoff"
                role="tabpanel"
                aria-labelledby="inspector-tab-handoff"
              >
                <h2>Developer handoff</h2>
                <label>
                  Add implementation direction
                  <textarea
                    aria-label="Developer annotation"
                    value={annotation}
                    onChange={(event) => setAnnotation(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    apply(
                      actions.addDeveloperAnnotation({
                        category: 'accessibility',
                        body: annotation
                      })
                    )
                  }
                >
                  Add direction
                </button>
                {snapshot.developerAnnotations.length === 0 ? (
                  <p>No handoff annotations yet.</p>
                ) : (
                  snapshot.developerAnnotations.map((item) => (
                    <p key={item.id}>
                      <strong>{item.category}</strong> · {item.body}
                    </p>
                  ))
                )}
                <h2>Request history</h2>
                {snapshot.aiChangeRequests.map((request) => (
                  <p key={request.id}>
                    {request.status}: {request.instruction}
                  </p>
                ))}
              </section>
            ) : null}
            {inspectorTab === 'setup' ? (
              <section id="inspector-setup" role="tabpanel" aria-labelledby="inspector-tab-setup">
                <GuidedSetupPanel
                  snapshot={snapshot}
                  onSnapshot={onSnapshot}
                  actions={guidedActions}
                />
              </section>
            ) : null}
          </>
        )}
      </aside>
    </div>
  );
}
