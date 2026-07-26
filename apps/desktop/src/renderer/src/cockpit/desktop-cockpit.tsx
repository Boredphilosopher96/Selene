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
  AIChangeUndoInput,
  DesignerProgress,
  DesignerSnapshot,
  DeveloperAnnotationInput,
  ReviewThreadInput,
  ReviewThreadReplyInput,
  ReviewThreadResolutionInput,
  SpatialTargetInput,
  PrototypeScenarioStartInput,
  WorkspaceCockpitPreferences
} from '../../../shared/designer-api';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { isCurrentProjectOwner } from './ai-conversation-model';
import { AIConversationWorkspace } from './ai-conversation-workspace';
import { ContextualInspector } from './contextual-inspector';
import {
  compactCockpitMediaQuery,
  desktopCockpitLayoutMode,
  inspectorDrawerAccessibilityState,
  inspectorDrawerBlocksInteraction
} from './desktop-cockpit-layout';
import { PreviewSurface, type PreviewBuild } from './preview-surface';
import { ScenarioNavigator } from './scenario-navigator';
import './desktop-cockpit.css';

export const inspectorTabs = ['inspect', 'flow', 'reviews', 'handoff', 'setup'] as const;
export type InspectorTab = (typeof inspectorTabs)[number];
const paneMinimum = 220;
const paneMaximum = 520;
const initialReplyDraft = 'Acknowledged; follow-up recorded.';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function clampPane(value: number): number {
  return Math.min(paneMaximum, Math.max(paneMinimum, Math.round(value)));
}

export interface DesktopCockpitActions {
  snapshot(): Promise<DesignerSnapshot>;
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  cancelAIChange(requestId: string): Promise<void>;
  undoLastAIChange(input: AIChangeUndoInput): Promise<DesignerSnapshot>;
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
  startPrototypeScenario(request: PrototypeScenarioStartInput): Promise<DesignerSnapshot>;
  resetPrototypeRun(): Promise<DesignerSnapshot>;
}

export interface DesktopCockpitProps {
  readonly snapshot: DesignerSnapshot;
  readonly build?: PreviewBuild;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: (frame: HTMLIFrameElement) => void;
  readonly onFrameError: (frame: HTMLIFrameElement) => void;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onRender: (snapshot: DesignerSnapshot) => Promise<void>;
  readonly actions: DesktopCockpitActions;
  readonly guidedActions: GuidedSetupActions;
  readonly progress?: DesignerProgress;
  readonly preferences?: WorkspaceCockpitPreferences;
  readonly onPreferencesChange?: (preferences: WorkspaceCockpitPreferences) => void;
  readonly initialSelectedThreadId?: string;
  /** Allows embedded fixtures to exercise the same compact drawer behavior deterministically. */
  readonly compactLayout?: boolean;
  readonly initialInspectorDrawerOpen?: boolean;
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

function targetSummary(target: Pick<SpatialTargetInput, 'x' | 'y' | 'width' | 'height'>): string {
  const isRegion = (target.width ?? 0) > 0 || (target.height ?? 0) > 0;
  const centerX = Math.min(1, target.x + (target.width ?? 0) / 2);
  const centerY = Math.min(1, target.y + (target.height ?? 0) / 2);
  const horizontal = centerX < 1 / 3 ? 'left' : centerX > 2 / 3 ? 'right' : 'center';
  const vertical = centerY < 1 / 3 ? 'top' : centerY > 2 / 3 ? 'bottom' : 'center';
  const location =
    horizontal === 'center' && vertical === 'center' ? 'center' : `${vertical}-${horizontal}`;

  return `${isRegion ? 'Region' : 'Point'} near the ${location}`;
}

/**
 * Gives composed control names one, and only one, spoken sentence boundary.
 * Review bodies are user-provided and may already include terminal punctuation.
 */
function accessibleLabel(...parts: readonly string[]): string {
  const sentences = parts
    .map((part) => part.trim().replace(/[.!?]+$/u, ''))
    .filter((part) => part.length > 0);
  return sentences.length === 0 ? '' : `${sentences.join('. ')}.`;
}

/** The production renderer cockpit. Host authority arrives only through typed actions. */
export function DesktopCockpit({
  snapshot,
  build,
  frame,
  onFrameLoad,
  onFrameError,
  onSnapshot,
  onRender,
  actions,
  guidedActions,
  progress,
  preferences,
  onPreferencesChange,
  initialSelectedThreadId,
  compactLayout,
  initialInspectorDrawerOpen = false
}: DesktopCockpitProps) {
  const [annotation, setAnnotation] = useState('Preserve keyboard focus after this change.');
  const [aiTarget, setAiTarget] = useState<SpatialTargetInput>();
  const [aiTargetProjectId, setAiTargetProjectId] = useState<string>();
  const [reviewTarget, setReviewTarget] = useState<SpatialTargetInput>();
  const [reviewTargetProjectId, setReviewTargetProjectId] = useState<string>();
  const [targetMode, setTargetMode] = useState<'idle' | 'ai' | 'review'>('idle');
  const [targetModeProjectId, setTargetModeProjectId] = useState(snapshot.source.projectId);
  const [selectedArtifactPinId, setSelectedArtifactPinId] = useState<string | undefined>(() =>
    initialSelectedThreadId !== undefined &&
    snapshot.artifactPins.some((pin) => pin.id === initialSelectedThreadId)
      ? initialSelectedThreadId
      : undefined
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    initialSelectedThreadId
  );
  const [reviewBody, setReviewBody] = useState('Verify this spatial region.');
  const [replyDrafts, setReplyDrafts] = useState<Readonly<Record<string, string>>>({});
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');
  const [aiStatus, setAiStatus] = useState(
    'Choose a target when this change needs spatial context.'
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [reviewStatus, setReviewStatus] = useState(
    'Choose a preview location before creating a stakeholder thread.'
  );
  const [threadStatus, setThreadStatus] = useState<{
    readonly threadId: string;
    readonly message: string;
  }>();
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [threadAction, setThreadAction] = useState<'idle' | 'replying' | 'resolving'>('idle');
  const [prototypeModeChanging, setPrototypeModeChanging] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(initialInspectorDrawerOpen);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspect');
  const [centerStage, setCenterStage] = useState<'preview' | 'flow'>('preview');
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(340);
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);
  const resizing = useRef<'left' | 'right' | undefined>(undefined);
  const reviewSubmittingRef = useRef(false);
  const threadActionRef = useRef<'idle' | 'replying' | 'resolving'>('idle');
  const prototypeModeChangingRef = useRef(false);
  const targetInvokingControl = useRef<HTMLElement | null>(null);
  const threadInvokingControl = useRef<HTMLElement | null>(null);
  const inspectorTabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const inspectorDrawerRef = useRef<HTMLElement | null>(null);
  const inspectorDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inspectorDrawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const paneWidths = useRef({ left: leftWidth, right: rightWidth });
  const aiBusyRef = useRef(false);
  const targetProject = useRef(snapshot.source.projectId);
  const activeProjectRef = useRef(snapshot.source.projectId);
  const viewportCompactInspector = useMediaQuery(compactCockpitMediaQuery);
  const layoutMode = desktopCockpitLayoutMode({
    compactLayout,
    viewportIsCompact: viewportCompactInspector
  });
  const compactInspector = layoutMode === 'inspector-drawer';
  activeProjectRef.current = snapshot.source.projectId;
  const selectedThread = snapshot.reviewThreads.find((thread) => thread.id === selectedThreadId);
  const selectedScenario = snapshot.scenarios.find(
    (item) => item.id === snapshot.selectedScenarioId
  );
  // The drawer describes the compiled artifact the user can see, not the broader
  // fixture label that happened to select it.
  const inspectorContext =
    selectedScenario?.fixture.heading ?? selectedScenario?.title ?? snapshot.source.projectId;
  const setConversationBusy = (busy: boolean) => {
    aiBusyRef.current = busy;
    setAiBusy(busy);
  };
  const activeTargetMode = isCurrentProjectOwner(targetModeProjectId, snapshot.source.projectId)
    ? targetMode
    : ('idle' as const);
  const currentAiTarget = isCurrentProjectOwner(aiTargetProjectId, snapshot.source.projectId)
    ? aiTarget
    : undefined;
  const currentReviewTarget = isCurrentProjectOwner(
    reviewTargetProjectId,
    snapshot.source.projectId
  )
    ? reviewTarget
    : undefined;
  const replyBody = selectedThread ? (replyDrafts[selectedThread.id] ?? initialReplyDraft) : '';
  const restoreFocus = (control: HTMLElement | null) =>
    requestAnimationFrame(() => control?.focus());
  const cancelTargetSelection = (restoreControl?: HTMLElement) => {
    if (activeTargetMode === 'idle') return false;
    const cancelled = activeTargetMode;
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
    if (cancelled === 'ai')
      setAiStatus('AI target selection cancelled. Your draft and saved target remain available.');
    else
      setReviewStatus(
        'Review location selection cancelled. Your draft and saved location remain available.'
      );
    restoreFocus(restoreControl ?? targetInvokingControl.current);
    return true;
  };
  const closeSelectedThread = () => {
    setThreadStatus(undefined);
    setSelectedThreadId(undefined);
    restoreFocus(threadInvokingControl.current);
  };
  const toggleTargetMode = (mode: 'ai' | 'review', invoking: HTMLElement) => {
    if (mode === 'ai' && aiBusyRef.current) return;
    if (activeTargetMode === mode) {
      cancelTargetSelection();
      return;
    }
    targetInvokingControl.current = invoking;
    setCenterStage('preview');
    setTargetModeProjectId(snapshot.source.projectId);
    setTargetMode(mode);
    if (mode === 'ai')
      setAiStatus('Choose a free point or region in the preview. Press Escape to cancel.');
    else
      setReviewStatus(
        'Choose a stakeholder discussion location in the preview. Press Escape to cancel.'
      );
  };
  const completeTargetSelection = (target: SpatialTargetInput) => {
    if (
      !isCurrentProjectOwner(targetModeProjectId, snapshot.source.projectId) ||
      activeTargetMode === 'idle'
    )
      return;
    if (activeTargetMode === 'ai') {
      setSelectedArtifactPinId(undefined);
      setAiTarget(target);
      setAiTargetProjectId(snapshot.source.projectId);
      setAiStatus(`AI target selected: ${targetSummary(target)}.`);
    }
    if (activeTargetMode === 'review') {
      setSelectedArtifactPinId(undefined);
      setReviewTarget(target);
      setReviewTargetProjectId(snapshot.source.projectId);
    }
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
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
    if (!compactInspector) setInspectorDrawerOpen(false);
  }, [compactInspector]);
  useEffect(() => {
    if (targetProject.current === snapshot.source.projectId) return;
    targetProject.current = snapshot.source.projectId;
    dragStart.current = undefined;
    setAiTarget(undefined);
    setAiTargetProjectId(undefined);
    setReviewTarget(undefined);
    setReviewTargetProjectId(undefined);
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
    setAiStatus('Choose a target when this change needs spatial context.');
    setReviewStatus('Choose a preview location before creating a stakeholder thread.');
  }, [snapshot.source.projectId]);
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
      if (compactInspector && inspectorDrawerOpen) {
        event.preventDefault();
        setInspectorDrawerOpen(false);
        requestAnimationFrame(() => inspectorDrawerTriggerRef.current?.focus());
        return;
      }
      if (activeTargetMode !== 'idle') {
        event.preventDefault();
        setTargetMode('idle');
        setTargetModeProjectId(snapshot.source.projectId);
        if (activeTargetMode === 'ai')
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
  }, [
    activeTargetMode,
    compactInspector,
    inspectorDrawerOpen,
    selectedThreadId,
    snapshot.source.projectId
  ]);
  useEffect(() => {
    if (!compactInspector || !inspectorDrawerOpen) return;
    requestAnimationFrame(() => inspectorDrawerCloseRef.current?.focus());
    const trapFocus = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const drawer = inspectorDrawerRef.current;
      if (!drawer) return;
      const controls = focusableElements(drawer);
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: globalThis.FocusEvent) => {
      const drawer = inspectorDrawerRef.current;
      if (!drawer || drawer.contains(event.target as Node)) return;
      requestAnimationFrame(() => inspectorDrawerCloseRef.current?.focus());
    };
    window.addEventListener('keydown', trapFocus);
    document.addEventListener('focusin', containFocus);
    return () => {
      window.removeEventListener('keydown', trapFocus);
      document.removeEventListener('focusin', containFocus);
    };
  }, [compactInspector, inspectorDrawerOpen]);
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
    if (!currentReviewTarget || !reviewBody.trim() || reviewSubmittingRef.current) return;
    reviewSubmittingRef.current = true;
    setReviewSubmitting(true);
    setReviewStatus('Saving stakeholder review thread…');
    void actions
      .addReviewThread({ body: reviewBody.trim(), anchor: currentReviewTarget })
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
        setReviewTargetProjectId(undefined);
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
  const selectCenterStage = (stage: 'preview' | 'flow') => {
    if (stage === 'flow') cancelTargetSelection();
    setCenterStage(stage);
  };
  const enterPrototypeMode = (mode: 'edit' | 'run') => {
    if (snapshot.editablePrototype.mode === mode) {
      selectCenterStage(mode === 'run' ? 'preview' : 'flow');
      return;
    }
    if (
      prototypeModeChangingRef.current ||
      snapshot.prototypeGraphHydration.state === 'recovery-required'
    )
      return;
    cancelTargetSelection();
    prototypeModeChangingRef.current = true;
    setPrototypeModeChanging(true);
    setGraphSaveStatus(mode === 'run' ? 'Starting saved prototype…' : 'Opening flow editor…');
    void actions
      .setPrototypeMode(mode)
      .then((next) => {
        onSnapshot(next);
        setCenterStage(mode === 'run' ? 'preview' : 'flow');
        setGraphSaveStatus(
          mode === 'run' ? 'Running the saved graph in Preview.' : 'Saved graph is ready to edit.'
        );
      })
      .catch((error: unknown) =>
        setGraphSaveStatus(error instanceof Error ? error.message : 'Host operation failed.')
      )
      .finally(() => {
        prototypeModeChangingRef.current = false;
        setPrototypeModeChanging(false);
      });
  };
  const saveGraph = async (
    graph: DesignerSnapshot['editablePrototype']['graph']
  ): Promise<void> => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required') return;
    setGraphSaveStatus('Saving graph revision…');
    try {
      const next = await actions.savePrototypeGraph(graph);
      onSnapshot(next);
      setGraphSaveStatus(`Saved graph revision ${next.editablePrototype.revision}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Host operation failed.';
      setGraphSaveStatus(message);
      throw error;
    }
  };
  const runCommittedGraph = async (): Promise<void> => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required')
      throw new Error('Recover the saved graph before running it in Preview.');
    if (prototypeModeChangingRef.current) throw new Error('Prototype mode is already changing.');
    prototypeModeChangingRef.current = true;
    setPrototypeModeChanging(true);
    setGraphSaveStatus('Compiling and starting the committed graph in Preview…');
    try {
      const next = await actions.setPrototypeMode('run');
      onSnapshot(next);
      // Presentation receipts come from the mounted sandbox frame. Flow
      // authoring unmounts that frame, so expose Preview before waiting for
      // compilation and its trusted ready/rendered handshake.
      setCenterStage('preview');
      await onRender(next);
      setGraphSaveStatus('Preview is running the committed graph.');
    } catch (error) {
      setCenterStage('flow');
      setGraphSaveStatus(error instanceof Error ? error.message : 'Preview could not start.');
      throw error;
    } finally {
      prototypeModeChangingRef.current = false;
      setPrototypeModeChanging(false);
    }
  };
  const startPrototypeScenario = async (request: PrototypeScenarioStartInput) => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required')
      throw new Error('Recover the saved graph before starting a scenario.');
    cancelTargetSelection();
    setGraphSaveStatus(`Starting saved scenario ${request.scenarioId}…`);
    const next = await actions.startPrototypeScenario(request);
    if (
      activeProjectRef.current !== request.projectId ||
      next.source.projectId !== request.projectId
    )
      return;
    onSnapshot(next);
    setCenterStage('preview');
    setGraphSaveStatus(`Running saved scenario ${request.scenarioId} in Preview.`);
  };
  const selectInspectorTab = (tab: InspectorTab, focus = false) => {
    setInspectorTab(tab);
    persistPreferences({ inspectorTab: tab });
    if (focus) requestAnimationFrame(() => inspectorTabRefs.current.get(tab)?.focus());
  };
  const handoffInspectorTarget = (
    mode: 'ai' | 'review',
    target: SpatialTargetInput,
    invoking: HTMLButtonElement
  ) => {
    if (mode === 'ai' && aiBusyRef.current) return;
    targetInvokingControl.current = invoking;
    setCenterStage('preview');
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
    if (mode === 'ai') {
      setAiTarget(target);
      setAiTargetProjectId(snapshot.source.projectId);
      setAiStatus('Inspect context is ready for the next AI edit request.');
      return;
    }
    setReviewTarget(target);
    setReviewTargetProjectId(snapshot.source.projectId);
    setReviewStatus('Inspect context is ready for a stakeholder review comment.');
    selectInspectorTab('reviews', true);
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
  const openInspectorDrawer = () => setInspectorDrawerOpen(true);
  const closeInspectorDrawer = () => {
    setInspectorDrawerOpen(false);
    requestAnimationFrame(() => inspectorDrawerTriggerRef.current?.focus());
  };
  const drawerBlocksInteraction = inspectorDrawerBlocksInteraction(layoutMode, inspectorDrawerOpen);
  const drawerAccessibility = inspectorDrawerAccessibilityState(layoutMode, inspectorDrawerOpen);
  const drawerIsModal = drawerAccessibility.isModal;
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
      data-target-mode={activeTargetMode}
      data-layout-mode={layoutMode}
      data-center-stage={centerStage}
      data-inspector-drawer-open={drawerBlocksInteraction || undefined}
    >
      <aside
        className="conversation-rail workspace-drawer-background"
        aria-label="AI conversation"
        inert={drawerAccessibility.backgroundIsInert || undefined}
      >
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
        <div className="conversation-rail__body" hidden={leftCollapsed}>
          <AIConversationWorkspace
            snapshot={snapshot}
            {...(progress === undefined ? {} : { progress })}
            target={currentAiTarget}
            targetMode={activeTargetMode}
            status={aiStatus}
            actions={{
              snapshot: actions.snapshot,
              selectAgent: actions.selectAgent,
              requestAIChange: actions.requestAIChange,
              cancelAIChange: actions.cancelAIChange,
              undoLastAIChange: actions.undoLastAIChange
            }}
            onSnapshot={onSnapshot}
            onRender={onRender}
            onStatusChange={setAiStatus}
            onBusyChange={setConversationBusy}
            onTargetModeChange={toggleTargetMode}
            onTargetClear={() => {
              setAiTarget(undefined);
              setAiTargetProjectId(undefined);
            }}
          />
        </div>
      </aside>
      <div
        className="workspace-pane-resizer workspace-drawer-background"
        role="separator"
        aria-label="Resize AI conversation rail"
        aria-orientation="vertical"
        aria-valuemin={paneMinimum}
        aria-valuemax={paneMaximum}
        aria-valuenow={leftWidth}
        tabIndex={leftCollapsed ? -1 : 0}
        inert={drawerAccessibility.backgroundIsInert || undefined}
        onPointerDown={beginResize('left')}
        onPointerMove={updateResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={persistResize}
        onKeyDown={resizeWithKeyboard('left')}
      />
      <section
        className="workspace-center-stage workspace-drawer-background"
        aria-label="Designer stage"
        inert={drawerAccessibility.backgroundIsInert || undefined}
      >
        <div className="workspace-center-stage__switch" role="group" aria-label="Center stage">
          <button
            type="button"
            aria-pressed={centerStage === 'preview'}
            onClick={() => selectCenterStage('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            aria-pressed={centerStage === 'flow'}
            onClick={() => selectCenterStage('flow')}
          >
            Flow
          </button>
          {compactInspector && leftCollapsed ? (
            <button
              className="workspace-ai-rail-trigger"
              type="button"
              onClick={() => {
                setLeftCollapsed(false);
                persistPreferences({ leftRailCollapsed: false });
              }}
            >
              Open AI
            </button>
          ) : null}
          {compactInspector ? (
            <button
              className="workspace-inspector-drawer-trigger"
              type="button"
              aria-controls="workspace-inspector-drawer"
              aria-expanded={inspectorDrawerOpen}
              ref={inspectorDrawerTriggerRef}
              onClick={openInspectorDrawer}
            >
              Show inspector
            </button>
          ) : null}
        </div>
        {centerStage === 'preview' ? (
          <PreviewSurface
            {...(build === undefined ? {} : { build })}
            revisionId={snapshot.source.revision.id}
            readiness={snapshot.baseline.readiness}
            presentationStatus={graphSaveStatus}
            frame={frame}
            onFrameLoad={onFrameLoad}
            onFrameError={onFrameError}
            targeting={activeTargetMode !== 'idle'}
            targetMode={activeTargetMode}
            canTargetAi={
              !aiBusy &&
              snapshot.agents.some((agent) => agent.id === snapshot.selectedAgentId) &&
              !snapshot.aiChangeRequests.some(
                (request) => request.status === 'queued' || request.status === 'running'
              )
            }
            canTargetReview={!reviewSubmitting}
            onSelectTargetTool={(tool, invoking) => toggleTargetMode(tool, invoking)}
            onCancelTargeting={(invoking) => cancelTargetSelection(invoking)}
            {...(currentAiTarget === undefined ? {} : { aiTarget: currentAiTarget })}
            {...(currentReviewTarget === undefined ? {} : { reviewTarget: currentReviewTarget })}
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
            {...(selectedArtifactPinId === undefined
              ? {}
              : { selectedPinId: selectedArtifactPinId })}
            onSelectPin={selectArtifactPin}
            {...(selectedThread === undefined ? {} : { selectedThread })}
            replyBody={replyBody}
            threadAction={threadAction}
            threadStatus={
              selectedThread && threadStatus?.threadId === selectedThread.id
                ? threadStatus.message
                : ''
            }
            onReplyBodyChange={(body) => {
              if (selectedThread)
                setReplyDrafts((current) => ({ ...current, [selectedThread.id]: body }));
            }}
            onReplyThread={replyToSelectedThread}
            onResolveThread={resolveSelectedThread}
            onCloseThread={closeSelectedThread}
          />
        ) : (
          <section className="flow-studio" aria-labelledby="flow-studio-heading">
            <header className="flow-studio__header">
              <div>
                <p className="conversation-history__eyebrow">Prototype authoring</p>
                <h1 id="flow-studio-heading">{snapshot.editablePrototype.graph.name}</h1>
                <p>
                  Saved revision {snapshot.editablePrototype.revision} · {graphSaveStatus}
                </p>
              </div>
              <div className="flow-studio__modes" role="group" aria-label="Prototype mode">
                <button
                  type="button"
                  aria-pressed={snapshot.editablePrototype.mode === 'edit'}
                  disabled={
                    prototypeModeChanging ||
                    snapshot.prototypeGraphHydration.state === 'recovery-required'
                  }
                  onClick={() => enterPrototypeMode('edit')}
                >
                  {prototypeModeChanging && snapshot.editablePrototype.mode !== 'edit'
                    ? 'Opening…'
                    : 'Edit'}
                </button>
                <button
                  type="button"
                  aria-pressed={snapshot.editablePrototype.mode === 'run'}
                  disabled={
                    prototypeModeChanging ||
                    snapshot.prototypeGraphHydration.state === 'recovery-required'
                  }
                  onClick={() => enterPrototypeMode('run')}
                >
                  {prototypeModeChanging && snapshot.editablePrototype.mode !== 'run'
                    ? 'Starting…'
                    : 'Run in Preview'}
                </button>
              </div>
            </header>
            {snapshot.prototypeGraphHydration.state === 'recovery-required' ? (
              <section className="workspace-notice" role="alert">
                <p>{snapshot.prototypeGraphHydration.message}</p>
                <p>Authoring remains read-only until the host recovers the saved graph.</p>
              </section>
            ) : null}
            {snapshot.editablePrototype.mode === 'edit' ? (
              <div className="flow-studio__workspace">
                <details className="flow-studio__scenarios">
                  <summary>Screens and scenarios</summary>
                  <ScenarioNavigator
                    graph={snapshot.editablePrototype.graph}
                    projectId={snapshot.source.projectId}
                    graphRevision={snapshot.editablePrototype.revision}
                    hydration={snapshot.prototypeGraphHydration}
                    runtime={snapshot.editablePrototype.runtime}
                    onStartScenario={startPrototypeScenario}
                  />
                </details>
                <PrototypeFlowCanvas
                  graph={snapshot.editablePrototype.graph}
                  {...(snapshot.prototypeGraphHydration.state === 'recovery-required'
                    ? {}
                    : { onGraphChange: saveGraph, onRunCommitted: runCommittedGraph })}
                  readOnly={snapshot.prototypeGraphHydration.state === 'recovery-required'}
                />
              </div>
            ) : (
              <section className="flow-studio__run" aria-label="Saved prototype run">
                <header>
                  <div>
                    <p className="conversation-history__eyebrow">Run saved flow</p>
                    <h2>Active runtime path</h2>
                    <p>
                      Use Preview to run the compiled React prototype with its local fixture data.
                    </p>
                  </div>
                  <button type="button" onClick={() => apply(actions.resetPrototypeRun())}>
                    Reset scenario
                  </button>
                </header>
                <div className="flow-studio__workspace">
                  <details className="flow-studio__scenarios">
                    <summary>Screens and scenarios</summary>
                    <ScenarioNavigator
                      graph={snapshot.editablePrototype.graph}
                      projectId={snapshot.source.projectId}
                      graphRevision={snapshot.editablePrototype.revision}
                      hydration={snapshot.prototypeGraphHydration}
                      runtime={snapshot.editablePrototype.runtime}
                      onStartScenario={startPrototypeScenario}
                    />
                  </details>
                  {snapshot.editablePrototype.runtime ? (
                    <PrototypeFlowCanvas
                      graph={snapshot.editablePrototype.graph}
                      activeNodeIds={[snapshot.editablePrototype.runtime.activeNodeId]}
                      activeTransitionIds={
                        snapshot.editablePrototype.runtime.activePathTransitionIds
                      }
                      readOnly
                    />
                  ) : (
                    <p className="workspace-notice" role="status">
                      Starting the saved runtime…
                    </p>
                  )}
                </div>
              </section>
            )}
          </section>
        )}
      </section>
      <div
        className="workspace-pane-resizer workspace-drawer-background"
        role="separator"
        aria-label="Resize inspector rail"
        aria-orientation="vertical"
        aria-valuemin={paneMinimum}
        aria-valuemax={paneMaximum}
        aria-valuenow={rightWidth}
        tabIndex={rightCollapsed || compactInspector ? -1 : 0}
        inert={drawerAccessibility.backgroundIsInert || undefined}
        onPointerDown={beginResize('right')}
        onPointerMove={updateResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={persistResize}
        onKeyDown={resizeWithKeyboard('right')}
      />
      {drawerBlocksInteraction ? (
        <button
          className="workspace-inspector-drawer-scrim"
          type="button"
          tabIndex={-1}
          aria-label="Close inspector"
          onClick={closeInspectorDrawer}
        />
      ) : null}
      <aside
        className="inspector workspace-inspector-drawer"
        id="workspace-inspector-drawer"
        ref={inspectorDrawerRef}
        aria-label={drawerIsModal ? 'Compact inspector workspace' : 'Progressive inspector'}
        {...(drawerIsModal ? { role: 'dialog', 'aria-modal': true } : {})}
        aria-hidden={compactInspector && !inspectorDrawerOpen ? true : undefined}
        inert={drawerAccessibility.drawerIsInert || undefined}
      >
        {compactInspector ? (
          inspectorDrawerOpen ? (
            <header className="workspace-inspector-drawer__header">
              <div>
                <h2>{inspectorContext}</h2>
                <span>
                  Current compiled-preview context. Return to the preview when you are done.
                </span>
              </div>
              <button
                className="workspace-inspector-drawer__close"
                type="button"
                ref={inspectorDrawerCloseRef}
                onClick={closeInspectorDrawer}
              >
                Back to preview
              </button>
            </header>
          ) : null
        ) : (
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
        )}
        {(compactInspector ? inspectorDrawerOpen : !rightCollapsed) ? (
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
              <ContextualInspector
                snapshot={snapshot}
                selectedArtifactPinId={selectedArtifactPinId}
                aiTarget={currentAiTarget}
                reviewTarget={currentReviewTarget}
                targetMode={activeTargetMode}
                aiBusy={aiBusy}
                onHandoff={handoffInspectorTarget}
              />
            ) : null}
            {inspectorTab === 'flow' ? (
              <section
                id="inspector-flow"
                role="tabpanel"
                aria-labelledby="inspector-tab-flow"
                className="flow-launcher"
              >
                <p className="conversation-history__eyebrow">Prototype flow</p>
                <h2>Saved flow studio</h2>
                <p>
                  Revision {snapshot.editablePrototype.revision} is persisted by the local host.
                </p>
                <div className="flow-launcher__actions" role="group" aria-label="Flow studio views">
                  <button
                    type="button"
                    aria-pressed={centerStage === 'flow'}
                    onClick={() => selectCenterStage('flow')}
                  >
                    Open flow studio
                  </button>
                  <button
                    type="button"
                    aria-pressed={centerStage === 'preview'}
                    onClick={() => selectCenterStage('preview')}
                  >
                    Show runtime preview
                  </button>
                </div>
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
                  disabled={
                    prototypeModeChanging ||
                    snapshot.prototypeGraphHydration.state === 'recovery-required'
                  }
                  onClick={() =>
                    enterPrototypeMode(snapshot.editablePrototype.mode === 'edit' ? 'run' : 'edit')
                  }
                >
                  {prototypeModeChanging
                    ? 'Switching mode…'
                    : snapshot.editablePrototype.mode === 'edit'
                      ? 'Run saved flow'
                      : 'Edit saved flow'}
                </button>
                <p className="shortcut-hint">
                  Direct port-to-node wiring and keyboard connector controls are available in the
                  center-stage Flow studio.
                </p>
              </section>
            ) : null}
            {inspectorTab === 'reviews' ? (
              <section
                id="inspector-reviews"
                role="tabpanel"
                aria-labelledby="inspector-tab-reviews"
                className="review-panel"
              >
                <header className="review-panel__header">
                  <p className="conversation-history__eyebrow">Stakeholder review</p>
                  <h2>Discuss the rendered artifact</h2>
                  <p>
                    Review threads are stakeholder discussions. They do not send AI instructions or
                    change design baselines.
                  </p>
                </header>
                <section
                  aria-busy={reviewSubmitting || undefined}
                  aria-label="Stakeholder review composer"
                  className="review-composer"
                >
                  <div>
                    <h3>Start a review thread</h3>
                    <p>
                      {currentReviewTarget
                        ? `Review target: ${targetSummary(currentReviewTarget)}.`
                        : 'Choose a free point or region in the preview before starting a thread.'}
                    </p>
                  </div>
                  <label>
                    Comment for stakeholders
                    <textarea
                      aria-label="Stakeholder review thread body"
                      disabled={reviewSubmitting}
                      value={reviewBody}
                      onChange={(event) => setReviewBody(event.currentTarget.value)}
                    />
                  </label>
                  <div
                    className="review-composer__actions"
                    role="group"
                    aria-label="Review actions"
                  >
                    <button
                      className="review-location-action"
                      type="button"
                      aria-pressed={activeTargetMode === 'review'}
                      disabled={reviewSubmitting}
                      onClick={(event) => toggleTargetMode('review', event.currentTarget)}
                    >
                      {activeTargetMode === 'review'
                        ? 'Cancel review target'
                        : 'Target review discussion'}
                    </button>
                    <button
                      className="review-composer__submit"
                      type="button"
                      disabled={!currentReviewTarget || !reviewBody.trim() || reviewSubmitting}
                      onClick={(event) => createReviewThread(event.currentTarget)}
                    >
                      {reviewSubmitting ? 'Saving thread…' : 'Start stakeholder thread'}
                    </button>
                  </div>
                  <p className="shortcut-hint">
                    Escape cancels review targeting; reply shortcuts are available at the selected
                    pin.
                  </p>
                  <p className="review-status" role="status" aria-live="polite">
                    {reviewStatus}
                  </p>
                </section>
                <section className="review-thread-section" aria-labelledby="review-thread-heading">
                  <div className="review-thread-section__header">
                    <h2 id="review-thread-heading">Review threads</h2>
                    <p>
                      Open and resolved stakeholder conversations stay separate from AI changes.
                    </p>
                  </div>
                  {snapshot.reviewThreads.length === 0 ? (
                    <p className="inspector-empty">
                      No stakeholder threads yet. Pick a preview location to start a durable
                      discussion.
                    </p>
                  ) : (
                    (['open', 'resolved'] as const).map((status) => {
                      const threads = snapshot.reviewThreads.filter(
                        (thread) => thread.status === status
                      );
                      const title = status === 'open' ? 'Open threads' : 'Resolved threads';
                      const label = `${title}, ${threads.length}`;

                      return (
                        <section className="review-thread-group" key={status} aria-label={label}>
                          <h3>
                            {title} <span aria-hidden="true">{threads.length}</span>
                          </h3>
                          {threads.length === 0 ? (
                            <p className="review-thread-group__empty">
                              No {status} review threads.
                            </p>
                          ) : (
                            <ol className="review-thread-list">
                              {threads.map((thread) => (
                                <li key={thread.id}>
                                  <button
                                    className="review-thread-row"
                                    type="button"
                                    aria-label={accessibleLabel(
                                      `View ${status === 'resolved' ? 'resolved ' : ''}stakeholder review thread: ${thread.body}`,
                                      targetSummary(thread.anchor)
                                    )}
                                    aria-pressed={selectedThreadId === thread.id}
                                    onClick={(event) =>
                                      selectThread(thread.id, event.currentTarget)
                                    }
                                  >
                                    <strong>{status === 'resolved' ? 'Resolved' : 'Open'}</strong>
                                    <span>{thread.body}</span>
                                    <small>
                                      {targetSummary(thread.anchor)} · {thread.replies.length}{' '}
                                      {thread.replies.length === 1 ? 'reply' : 'replies'}
                                    </small>
                                  </button>
                                </li>
                              ))}
                            </ol>
                          )}
                        </section>
                      );
                    })
                  )}
                </section>
                <section className="review-pin-section" aria-labelledby="review-pin-heading">
                  <h2 id="review-pin-heading">Artifact pins</h2>
                  {snapshot.artifactPins.length === 0 ? (
                    <p className="inspector-empty">
                      Pins appear here after a stakeholder thread is saved.
                    </p>
                  ) : (
                    <ul className="review-pin-list" aria-label="Artifact pins">
                      {snapshot.artifactPins.map((pin) => (
                        <li key={pin.id}>
                          <button
                            type="button"
                            aria-label={accessibleLabel(
                              `Select artifact pin from inspector: ${pin.label}`,
                              targetSummary(pin.anchor)
                            )}
                            aria-pressed={selectedArtifactPinId === pin.id}
                            onClick={(event) => selectArtifactPin(pin.id, event.currentTarget)}
                          >
                            {pin.label} · {targetSummary(pin.anchor)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="review-pin-note">
                    Pins are derived from durable stakeholder threads; standalone pins are not
                    created here.
                  </p>
                </section>
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
                <h2>Read-only request ledger</h2>
                <p>
                  AI requests and outcomes are actionable only in the primary conversation rail.
                </p>
                {snapshot.aiChangeRequests.map((request) => (
                  <p key={request.id}>
                    <strong>{request.status}</strong>: {request.instruction}
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
        ) : null}
      </aside>
    </div>
  );
}
