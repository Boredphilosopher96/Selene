import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject
} from 'react';

import {
  workspaceCockpitRailMaximum,
  workspaceCockpitRailMinimum
} from '../../../shared/designer-api';
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
import { presentDesignerError, safeDesignerNotice } from '../presentation-error';
import {
  PREVIEW_TARGET_CANCEL_EVENT,
  type PreviewElementTelemetrySelection
} from '../../../shared/preview-channel';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { isCurrentProjectOwner } from './ai-conversation-model';
import { AIConversationWorkspace } from './ai-conversation-workspace';
import { ArtboardPreview } from './artboard-preview';
import {
  adjacentThreadId,
  boundedThreadTranscript,
  hasAiMention,
  selectedThreadIndex,
  threadAiFailureMessage
} from './comment-thread-navigation';
import {
  CanvasWorkspace,
  type CanvasPrototypeConnectionSelection,
  type CanvasWorkspaceMode
} from './canvas-workspace';
import { ContextualInspector } from './contextual-inspector';
import {
  compactCockpitMediaQuery,
  compactCanvasMediaQuery,
  compactAiRailEscapeAction,
  compactAiRailFocusTarget,
  desktopCockpitLayoutMode,
  inspectorDrawerAccessibilityState,
  inspectorDrawerBlocksInteraction
} from './desktop-cockpit-layout';
import type { PreviewBuild } from './preview-surface';
import './desktop-cockpit.css';

export const inspectorTabs = ['inspect', 'reviews', 'handoff', 'setup'] as const;
export type InspectorTab = (typeof inspectorTabs)[number];
const paneMinimum = workspaceCockpitRailMinimum;
const paneMaximum = workspaceCockpitRailMaximum;
const initialReplyDraft = '';

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
  readonly describePreview?: (
    policy: NonNullable<PreviewBuild['policy']>,
    screenId: string,
    projectId: string
  ) => Promise<{
    readonly url: string;
    readonly revisionId: string;
    readonly screenId: string;
    readonly projectId: string;
    readonly policy: NonNullable<PreviewBuild['policy']>;
  }>;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: (frame: HTMLIFrameElement) => void;
  readonly onFrameError: (frame: HTMLIFrameElement) => void;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly onRender: (
    snapshot: DesignerSnapshot,
    intent?: 'authoring' | 'presentation'
  ) => Promise<void>;
  /** Clears parent-owned telemetry when the cockpit clears or replaces its selection. */
  readonly onPreviewSelectionClear: () => void;
  /** Keeps the renderer-owned preview channel in sync with canvas mode changes. */
  readonly onCanvasNavigationChange: (enabled: boolean) => void;
  /** Arms the sole iframe Escape bridge only for a live transient artifact selection. */
  readonly onPreviewTargetCancelChange: (enabled: boolean) => void;
  readonly actions: DesktopCockpitActions;
  readonly guidedActions: GuidedSetupActions;
  readonly progress?: DesignerProgress;
  readonly preferences?: WorkspaceCockpitPreferences;
  readonly onPreferencesChange?: (preferences: WorkspaceCockpitPreferences) => void;
  readonly initialSelectedThreadId?: string;
  /** Allows embedded fixtures to exercise the same compact drawer behavior deterministically. */
  readonly compactLayout?: boolean;
  readonly initialInspectorDrawerOpen?: boolean;
  readonly selectedPreviewTelemetry?: PreviewElementTelemetrySelection;
}

function targetAt(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  viewportElement?: HTMLElement
): SpatialTargetInput | undefined {
  const box = element.getBoundingClientRect();
  const viewportWidth = viewportElement?.clientWidth ?? element.clientWidth;
  const viewportHeight = viewportElement?.clientHeight ?? element.clientHeight;
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  )
    return undefined;
  return {
    x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    viewport: { width: viewportWidth, height: viewportHeight }
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
  describePreview,
  frame,
  onFrameLoad,
  onFrameError,
  onSnapshot,
  onRender,
  onPreviewSelectionClear,
  onCanvasNavigationChange,
  onPreviewTargetCancelChange,
  actions,
  guidedActions,
  progress,
  preferences,
  onPreferencesChange,
  initialSelectedThreadId,
  compactLayout,
  initialInspectorDrawerOpen = false,
  selectedPreviewTelemetry
}: DesktopCockpitProps) {
  const currentPreviewTelemetry =
    selectedPreviewTelemetry !== undefined &&
    build?.revisionId === selectedPreviewTelemetry.revisionId
      ? selectedPreviewTelemetry
      : undefined;
  const currentPreviewTelemetryNodeId = currentPreviewTelemetry?.nodeId;
  const currentPreviewTelemetryRevisionId = currentPreviewTelemetry?.revisionId;
  const [referencePreviews, setReferencePreviews] = useState<
    readonly {
      readonly nodeId: string;
      readonly url: string;
      readonly revisionId: string;
      readonly nonce: string;
      readonly origin: string;
      readonly screenId: string;
      readonly projectId: string;
    }[]
  >([]);
  useEffect(() => {
    let disposed = false;
    const previewBuild = build;
    const previewPolicy = previewBuild?.policy;
    if (!previewBuild || !previewPolicy || !describePreview) {
      setReferencePreviews([]);
      return () => {
        disposed = true;
      };
    }
    const fence = `${snapshot.source.projectId}:${previewBuild.revisionId}:${previewPolicy.nonce}`;
    const nodeIds = snapshot.editablePrototype.graph.nodes
      .filter((node) => node.kind === 'screen' || node.kind === 'page')
      .map((node) => node.id);
    void Promise.all(
      nodeIds.map(async (nodeId) => {
        const descriptor = await describePreview(previewPolicy, nodeId, snapshot.source.projectId);
        if (
          descriptor.revisionId !== previewBuild.revisionId ||
          descriptor.policy.nonce !== previewPolicy.nonce ||
          descriptor.policy.origin !== previewPolicy.origin ||
          descriptor.screenId !== nodeId ||
          descriptor.projectId !== snapshot.source.projectId
        )
          throw new Error('Preview descriptor does not match its compiled revision.');
        return {
          nodeId,
          url: descriptor.url,
          revisionId: descriptor.revisionId,
          nonce: descriptor.policy.nonce,
          origin: descriptor.policy.origin,
          screenId: descriptor.screenId,
          projectId: descriptor.projectId
        };
      })
    )
      .then((descriptors) => {
        if (
          !disposed &&
          fence === `${snapshot.source.projectId}:${previewBuild.revisionId}:${previewPolicy.nonce}`
        )
          setReferencePreviews(descriptors);
      })
      .catch(() => {
        if (!disposed) setReferencePreviews([]);
      });
    return () => {
      disposed = true;
    };
  }, [build, describePreview, snapshot.editablePrototype.graph.nodes, snapshot.source.projectId]);
  const runtimeNode = snapshot.editablePrototype.graph.nodes.find(
    (node) => node.id === snapshot.editablePrototype.runtime?.activeNodeId
  );
  const activeScreenId =
    runtimeNode?.kind === 'screen' || runtimeNode?.kind === 'page'
      ? runtimeNode.id
      : runtimeNode?.kind === 'state'
        ? runtimeNode.parentId
        : snapshot.editablePrototype.graph.initialNodeId;
  const activePreviewDescriptor = referencePreviews.find(
    (descriptor) =>
      descriptor.nodeId === activeScreenId &&
      descriptor.projectId === snapshot.source.projectId &&
      descriptor.revisionId === build?.revisionId &&
      descriptor.nonce === build?.policy?.nonce &&
      descriptor.origin === build?.policy?.origin
  );
  const activePreviewBuild =
    build && activePreviewDescriptor ? { ...build, url: activePreviewDescriptor.url } : build;
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
  const [threadAiStatus, setThreadAiStatus] = useState<{
    readonly threadId: string;
    readonly message: string;
  }>();
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [threadAction, setThreadAction] = useState<'idle' | 'replying' | 'resolving'>('idle');
  const [prototypeModeChanging, setPrototypeModeChanging] = useState(false);
  const [canvasMode, setCanvasMode] = useState<CanvasWorkspaceMode>('design');
  const canvasPreviewBuild = canvasMode === 'design' ? activePreviewBuild : build;
  const [selectedCanvasConnection, setSelectedCanvasConnection] =
    useState<CanvasPrototypeConnectionSelection>();
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>();
  const [inspectorSelectionDismissed, setInspectorSelectionDismissed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [compactAiRailOpen, setCompactAiRailOpen] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(initialInspectorDrawerOpen);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspect');
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
  const reviewComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const compactAiRailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactAiRailCloseRef = useRef<HTMLButtonElement | null>(null);
  const paneWidths = useRef({ left: leftWidth, right: rightWidth });
  const aiBusyRef = useRef(false);
  const targetProject = useRef(snapshot.source.projectId);
  const activeProjectRef = useRef(snapshot.source.projectId);
  const activeArtifactRef = useRef(activeScreenId);
  const viewportCompactInspector = useMediaQuery(compactCockpitMediaQuery);
  const viewportCompactCanvas = useMediaQuery(compactCanvasMediaQuery);
  const layoutMode = desktopCockpitLayoutMode({
    compactLayout,
    viewportIsCompact: viewportCompactInspector
  });
  const compactInspector = layoutMode === 'inspector-drawer';
  // The narrow AI rail is a temporary overlay. Its open state must not rewrite
  // the designer's saved split-pane preference for wider desktop windows.
  const effectiveLeftCollapsed = viewportCompactCanvas ? !compactAiRailOpen : leftCollapsed;
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
  const previewTargetCancelEnabled =
    canvasMode === 'present' ||
    activeTargetMode !== 'idle' ||
    currentAiTarget !== undefined ||
    currentReviewTarget !== undefined ||
    selectedArtifactPinId !== undefined ||
    selectedThreadId !== undefined;
  const canRequestAiTarget =
    !aiBusy &&
    snapshot.agents.some((agent) => agent.id === snapshot.selectedAgentId) &&
    !snapshot.aiChangeRequests.some(
      (request) => request.status === 'queued' || request.status === 'running'
    );
  const replyBody = selectedThread ? (replyDrafts[selectedThread.id] ?? initialReplyDraft) : '';
  const restoreFocus = (control: HTMLElement | null) =>
    requestAnimationFrame(() => control?.focus());
  const setCompactAiRailVisible = (isOpen: boolean, moveFocus = false) => {
    setCompactAiRailOpen(isOpen);
    if (!moveFocus) return;
    requestAnimationFrame(() => {
      const target = compactAiRailFocusTarget(isOpen);
      (target === 'close' ? compactAiRailCloseRef : compactAiRailTriggerRef).current?.focus();
    });
  };
  const cancelTargetSelection = (restoreControl?: HTMLElement) => {
    if (activeTargetMode === 'idle') return false;
    const cancelled = activeTargetMode;
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
    if (cancelled === 'ai') {
      if (viewportCompactCanvas) setCompactAiRailOpen(true);
      setAiStatus('AI target selection cancelled. Your draft and saved target remain available.');
    } else
      setReviewStatus(
        'Review location selection cancelled. Your draft and saved location remain available.'
      );
    restoreFocus(restoreControl ?? targetInvokingControl.current);
    return true;
  };
  const closeSelectedThread = () => {
    setThreadStatus(undefined);
    setThreadAiStatus(undefined);
    setSelectedThreadId(undefined);
    setSelectedArtifactPinId(undefined);
    restoreFocus(threadInvokingControl.current);
  };
  const toggleTargetMode = (mode: 'ai' | 'review', invoking: HTMLElement) => {
    if (mode === 'ai' && aiBusyRef.current) return;
    if (activeTargetMode === mode) {
      cancelTargetSelection();
      return;
    }
    targetInvokingControl.current = invoking;
    if (viewportCompactCanvas) setCompactAiRailOpen(false);
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
      if (viewportCompactCanvas) setCompactAiRailOpen(true);
      setSelectedArtifactPinId(undefined);
      setAiTarget(target);
      setAiTargetProjectId(snapshot.source.projectId);
      setAiStatus(`AI target selected: ${targetSummary(target)}.`);
    }
    if (activeTargetMode === 'review') {
      setSelectedArtifactPinId(undefined);
      setReviewTarget(target);
      setReviewTargetProjectId(snapshot.source.projectId);
      setReviewStatus(
        `Review target selected: ${targetSummary(target)}. Add the stakeholder comment now.`
      );
      setInspectorTab('reviews');
      setRightCollapsed(false);
      if (compactInspector) setInspectorDrawerOpen(true);
      persistPreferences({ inspectorTab: 'reviews', rightRailCollapsed: false });
    }
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
    requestAnimationFrame(() =>
      activeTargetMode === 'review'
        ? reviewComposerRef.current?.focus()
        : targetInvokingControl.current?.focus()
    );
  };
  const clearCanvasSelection = () => {
    dragStart.current = undefined;
    setAiTarget(undefined);
    setAiTargetProjectId(undefined);
    setReviewTarget(undefined);
    setReviewTargetProjectId(undefined);
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setSelectedCanvasConnection(undefined);
    setSelectedCanvasNodeId(undefined);
    setInspectorSelectionDismissed(true);
    onPreviewSelectionClear();
    setTargetMode('idle');
    setTargetModeProjectId(snapshot.source.projectId);
  };
  useEffect(() => {
    onPreviewTargetCancelChange(previewTargetCancelEnabled);
    return () => onPreviewTargetCancelChange(false);
  }, [onPreviewTargetCancelChange, previewTargetCancelEnabled]);
  useEffect(() => {
    const cancelFromTrustedPreview = () => {
      if (!previewTargetCancelEnabled || canvasMode === 'present') return;
      clearCanvasSelection();
      setAiStatus('Cleared the artifact target from the preview.');
      setReviewStatus('Cleared the artifact target from the preview.');
    };
    window.addEventListener(PREVIEW_TARGET_CANCEL_EVENT, cancelFromTrustedPreview);
    return () => window.removeEventListener(PREVIEW_TARGET_CANCEL_EVENT, cancelFromTrustedPreview);
  }, [canvasMode, clearCanvasSelection, previewTargetCancelEnabled]);
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
    setInspectorTab(preferences.inspectorTab === 'flow' ? 'inspect' : preferences.inspectorTab);
  }, [preferences]);
  useEffect(() => {
    if (!compactInspector) setInspectorDrawerOpen(false);
  }, [compactInspector]);
  useEffect(() => {
    if (
      currentPreviewTelemetryNodeId === undefined ||
      currentPreviewTelemetryRevisionId === undefined
    )
      return;
    setSelectedCanvasNodeId(undefined);
    setSelectedCanvasConnection(undefined);
    setInspectorSelectionDismissed(false);
    setInspectorTab('inspect');
  }, [currentPreviewTelemetryNodeId, currentPreviewTelemetryRevisionId]);
  useEffect(() => {
    if (!viewportCompactCanvas) setCompactAiRailOpen(false);
  }, [viewportCompactCanvas]);
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
    setCanvasMode('design');
    setSelectedCanvasConnection(undefined);
    setSelectedCanvasNodeId(undefined);
    setInspectorSelectionDismissed(false);
    setAiStatus('Choose a target when this change needs spatial context.');
    setReviewStatus('Choose a preview location before creating a stakeholder thread.');
  }, [snapshot.source.projectId]);
  useEffect(() => {
    if (activeArtifactRef.current === activeScreenId) return;
    activeArtifactRef.current = activeScreenId;
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setThreadStatus(undefined);
    setThreadAiStatus(undefined);
    onPreviewSelectionClear();
  }, [activeScreenId, onPreviewSelectionClear]);
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
      // Target lifecycle always owns Escape before drawers, rails, or an open
      // thread. A designer must be able to abandon a mistaken point/region
      // without first closing unrelated chrome.
      if (activeTargetMode !== 'idle') {
        event.preventDefault();
        cancelTargetSelection();
        return;
      }
      if (
        currentAiTarget !== undefined ||
        currentReviewTarget !== undefined ||
        selectedArtifactPinId !== undefined ||
        selectedCanvasConnection !== undefined
      ) {
        event.preventDefault();
        clearCanvasSelection();
        return;
      }
      if (selectedThreadId !== undefined) {
        event.preventDefault();
        closeSelectedThread();
        return;
      }
      if (compactInspector && inspectorDrawerOpen) {
        event.preventDefault();
        setInspectorDrawerOpen(false);
        requestAnimationFrame(() => inspectorDrawerTriggerRef.current?.focus());
        return;
      }
      const compactAiEscape = compactAiRailEscapeAction({
        isOpen: viewportCompactCanvas && compactAiRailOpen,
        // Active targeting returned above so this branch can only close the
        // compact rail; keeping that precedence explicit avoids a second,
        // contradictory target-cancellation path.
        targetSelectionActive: false
      });
      if (compactAiEscape === 'close-ai-rail') {
        event.preventDefault();
        setCompactAiRailVisible(false, true);
        return;
      }
    };
    // The cockpit owns transient AI/review/drawer state. Handle Escape before
    // the nested canvas clears its own selection so a cancelled target cannot
    // leave the compact rail closed or its trigger stranded over the artifact.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    activeTargetMode,
    compactAiRailOpen,
    compactInspector,
    inspectorDrawerOpen,
    selectedThreadId,
    selectedArtifactPinId,
    selectedCanvasConnection,
    snapshot.source.projectId,
    cancelTargetSelection,
    closeSelectedThread,
    clearCanvasSelection,
    currentAiTarget,
    currentReviewTarget,
    viewportCompactCanvas
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
  useEffect(() => {
    if (
      inspectorTab !== 'reviews' ||
      currentReviewTarget === undefined ||
      activeTargetMode !== 'idle' ||
      (compactInspector && !inspectorDrawerOpen)
    )
      return;
    requestAnimationFrame(() => reviewComposerRef.current?.focus());
  }, [activeTargetMode, compactInspector, currentReviewTarget, inspectorDrawerOpen, inspectorTab]);
  const selectArtifactPin = (id: string, invoking?: HTMLElement) => {
    setThreadStatus(undefined);
    setThreadAiStatus(undefined);
    setSelectedArtifactPinId(id);
    const thread = snapshot.reviewThreads.find((item) => item.id === id);
    if (thread && invoking) threadInvokingControl.current = invoking;
    setSelectedThreadId(thread?.id);
  };
  const selectThread = (id: string, invoking?: HTMLElement) => {
    setThreadStatus(undefined);
    setThreadAiStatus(undefined);
    setSelectedThreadId(id);
    if (invoking) threadInvokingControl.current = invoking;
    setSelectedArtifactPinId(snapshot.artifactPins.some((item) => item.id === id) ? id : undefined);
  };
  const enqueueThreadAiRequest = (
    thread: DesignerSnapshot['reviewThreads'][number],
    reason: string
  ): void => {
    const agentId = snapshot.selectedAgentId;
    if (!agentId || !canRequestAiTarget) {
      setThreadAiStatus({
        threadId: thread.id,
        message: 'AI request was not created: select an available agent first.'
      });
      return;
    }
    setThreadAiStatus({
      threadId: thread.id,
      message: `Creating separate targeted AI request from ${reason}…`
    });
    void actions
      .requestAIChange({
        agentId,
        instruction: `Artifact comment thread ${thread.id}\n${boundedThreadTranscript(thread)}`,
        target: thread.anchor
      })
      .then((next) => {
        onSnapshot(next);
        setAiTarget(thread.anchor);
        setAiTargetProjectId(snapshot.source.projectId);
        setThreadAiStatus({
          threadId: thread.id,
          message: 'Separate targeted AI request created; the human thread remains unchanged.'
        });
      })
      .catch((error: unknown) =>
        setThreadAiStatus({
          threadId: thread.id,
          message: threadAiFailureMessage(error)
        })
      );
  };
  const createReviewThread = (invoking: HTMLElement) => {
    if (!currentReviewTarget || !reviewBody.trim() || reviewSubmittingRef.current) return;
    const body = reviewBody.trim();
    const asksAi = hasAiMention(body);
    reviewSubmittingRef.current = true;
    setReviewSubmitting(true);
    setReviewStatus('Saving stakeholder review thread…');
    void actions
      .addReviewThread({ body, anchor: currentReviewTarget })
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
          if (asksAi) enqueueThreadAiRequest(created, 'the @AI mention');
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
      .catch((error: unknown) => setReviewStatus(presentDesignerError(error, 'review')))
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
      if (hasAiMention(body)) {
        const updated = next.reviewThreads.find((thread) => thread.id === id);
        if (updated) enqueueThreadAiRequest(updated, 'the @AI mention');
      }
    } catch (error) {
      setThreadStatus({
        threadId: id,
        message: presentDesignerError(error, 'review')
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
        message: presentDesignerError(error, 'review')
      });
    } finally {
      threadActionRef.current = 'idle';
      setThreadAction('idle');
    }
  };
  const beginResize = (side: 'left' | 'right') => (event: PointerEvent<HTMLDivElement>) => {
    if (
      (side === 'left' && (effectiveLeftCollapsed || viewportCompactCanvas)) ||
      (side === 'right' && rightCollapsed)
    )
      return;
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
      .catch((error: unknown) => setGraphSaveStatus(presentDesignerError(error, 'canvas')));
  const enterPrototypeMode = async (mode: 'edit' | 'run'): Promise<boolean> => {
    if (snapshot.editablePrototype.mode === mode) return true;
    if (
      prototypeModeChangingRef.current ||
      snapshot.prototypeGraphHydration.state === 'recovery-required'
    )
      return false;
    cancelTargetSelection();
    prototypeModeChangingRef.current = true;
    setPrototypeModeChanging(true);
    setGraphSaveStatus(mode === 'run' ? 'Starting saved prototype…' : 'Opening flow editor…');
    try {
      const next = await actions.setPrototypeMode(mode);
      if (activeProjectRef.current !== next.source.projectId) return false;
      onSnapshot(next);
      setGraphSaveStatus(
        mode === 'run'
          ? 'Presenting the saved graph on this canvas.'
          : 'Saved graph connections are ready to edit.'
      );
      return true;
    } catch (error) {
      setGraphSaveStatus(presentDesignerError(error, 'canvas'));
      return false;
    } finally {
      prototypeModeChangingRef.current = false;
      setPrototypeModeChanging(false);
    }
  };
  const saveGraph = async (
    graph: DesignerSnapshot['editablePrototype']['graph']
  ): Promise<{
    readonly graph: DesignerSnapshot['editablePrototype']['graph'];
    readonly revision: number;
  }> => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required')
      throw new Error('Recover the saved graph before editing it.');
    setGraphSaveStatus('Saving graph revision…');
    try {
      const next = await actions.savePrototypeGraph(graph);
      if (activeProjectRef.current !== next.source.projectId)
        throw new Error('Saved graph belongs to a project that is no longer active.');
      onSnapshot(next);
      setGraphSaveStatus(`Saved graph revision ${next.editablePrototype.revision}.`);
      return {
        graph: next.editablePrototype.graph,
        revision: next.editablePrototype.revision
      };
    } catch (error) {
      const message = presentDesignerError(error, 'canvas');
      setGraphSaveStatus(message);
      throw error;
    }
  };
  const runCommittedGraph = async (): Promise<boolean> => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required') {
      setGraphSaveStatus('Recover the saved graph before presenting it on the canvas.');
      return false;
    }
    if (prototypeModeChangingRef.current) {
      setGraphSaveStatus('Prototype mode is already changing.');
      return false;
    }
    prototypeModeChangingRef.current = true;
    setPrototypeModeChanging(true);
    setGraphSaveStatus('Compiling the committed graph for the live artboard…');
    try {
      const next = await actions.setPrototypeMode('run');
      if (activeProjectRef.current !== next.source.projectId) return false;
      onSnapshot(next);
      // Inspect selection is authoring-only state. Revalidating it here can
      // reject a valid committed graph after the designer already asked to
      // leave the editor, so presentation waits only for the compiled frame.
      await onRender(next, 'presentation');
      setGraphSaveStatus('The live artboard is running the committed graph.');
      return true;
    } catch (error) {
      const message = presentDesignerError(error, 'preview');
      try {
        const rollback = await actions.setPrototypeMode('edit');
        if (activeProjectRef.current === rollback.source.projectId) onSnapshot(rollback);
      } catch {
        // Keep the original render failure authoritative; the next edit action retries the host.
      }
      setGraphSaveStatus(message);
      return false;
    } finally {
      prototypeModeChangingRef.current = false;
      setPrototypeModeChanging(false);
    }
  };
  const startPrototypeScenario = async (
    request: PrototypeScenarioStartInput,
    options: { readonly present?: boolean; readonly expectedActiveNodeId?: string } = {}
  ) => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required')
      throw new Error('Recover the saved graph before starting a scenario.');
    cancelTargetSelection();
    setSelectedThreadId(undefined);
    setSelectedArtifactPinId(undefined);
    setGraphSaveStatus(`Starting saved scenario ${request.scenarioId}…`);
    const next = await actions.startPrototypeScenario(request);
    if (
      activeProjectRef.current !== request.projectId ||
      next.source.projectId !== request.projectId
    )
      return;
    if (
      options.expectedActiveNodeId !== undefined &&
      next.editablePrototype.runtime?.activeNodeId !== options.expectedActiveNodeId
    )
      throw new Error('Saved scenario did not activate the requested canvas artboard.');
    onSnapshot(next);
    if (options.present !== false) setCanvasMode('present');
    setGraphSaveStatus(
      options.present === false
        ? `Opened saved scenario ${request.scenarioId} on the canvas (active: ${next.editablePrototype.runtime?.activeNodeId ?? 'none'}).`
        : `Running saved scenario ${request.scenarioId} on the live artboard.`
    );
  };
  const changeCanvasMode = async (
    mode: CanvasWorkspaceMode,
    _invoking: HTMLButtonElement
  ): Promise<void> => {
    clearCanvasSelection();
    cancelTargetSelection();
    if (mode === 'present') {
      setSelectedThreadId(undefined);
      setSelectedArtifactPinId(undefined);
      if (await runCommittedGraph()) {
        // The iframe's capture listener uses this policy to distinguish a
        // design-canvas selection from a live prototype action. Publish it
        // before exposing presentation so the first click cannot be eaten by
        // a stale design-mode bridge command.
        onCanvasNavigationChange(false);
        setCanvasMode('present');
      }
      return;
    }
    if (snapshot.editablePrototype.mode === 'run' && !(await enterPrototypeMode('edit'))) return;
    setCanvasMode('design');
  };
  const requestAiCanvasTarget = (invoking: HTMLButtonElement): void => {
    if (!canRequestAiTarget) return;
    if (currentReviewTarget) {
      setAiTarget(currentReviewTarget);
      setAiTargetProjectId(snapshot.source.projectId);
      setAiStatus('Shared canvas target is ready for the next AI edit request.');
      if (viewportCompactCanvas) setCompactAiRailOpen(true);
      return;
    }
    toggleTargetMode('ai', invoking);
  };
  const beginArtifactComment = (invoking: HTMLButtonElement): void => {
    // The target layer owns pointer input above the live iframe, so a review
    // gesture is safe while a saved prototype is running. Do not serialise the
    // comment affordance behind a host mode transition: designers can comment
    // on what they are seeing without interrupting the simulated flow.
    setRightCollapsed(false);
    if (compactInspector) setInspectorDrawerOpen(true);
    selectInspectorTab('reviews');
    // Reuse the same selector state machine as the inspector control. It is
    // intentionally independent of the currently running simulated flow.
    toggleTargetMode('review', invoking);
  };
  const askAiFromThread = (threadId: string): void => {
    const thread = snapshot.reviewThreads.find((item) => item.id === threadId);
    if (thread) enqueueThreadAiRequest(thread, 'Ask AI');
  };
  const navigateThread = (direction: -1 | 1): void => {
    const next = adjacentThreadId(snapshot.reviewThreads, selectedThreadId, direction);
    if (next !== undefined) selectThread(next);
  };
  const activateCanvasNode = (nodeId: string): void => {
    const scenario = snapshot.editablePrototype.graph.scenarios.find(
      (item) => item.startNodeId === nodeId
    );
    if (!scenario) {
      setGraphSaveStatus('This dormant artboard has no declared scenario to compile.');
      return;
    }
    void startPrototypeScenario(
      {
        projectId: snapshot.source.projectId,
        graphRevision: snapshot.editablePrototype.revision,
        scenarioId: scenario.id
      },
      { present: false, expectedActiveNodeId: nodeId }
    ).catch((error: unknown) => setGraphSaveStatus(presentDesignerError(error, 'scenario')));
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
          '--workspace-right-rail': `${rightWidth}px`,
          '--workspace-rail-minimum': `${paneMinimum}px`,
          '--workspace-center-minimum': '20rem'
        } as CSSProperties
      }
      data-left-collapsed={effectiveLeftCollapsed || undefined}
      data-right-collapsed={rightCollapsed || undefined}
      data-target-mode={activeTargetMode}
      data-layout-mode={layoutMode}
      data-canvas-mode={canvasMode}
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
          ref={compactAiRailCloseRef}
          aria-pressed={effectiveLeftCollapsed}
          onClick={() => {
            if (viewportCompactCanvas) {
              setCompactAiRailVisible(false, true);
              return;
            }
            const next = !leftCollapsed;
            setLeftCollapsed(next);
            persistPreferences({ leftRailCollapsed: next });
          }}
        >
          {effectiveLeftCollapsed ? 'Show AI rail' : 'Hide AI rail'}
        </button>
        <div className="conversation-rail__body" hidden={effectiveLeftCollapsed}>
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
        tabIndex={effectiveLeftCollapsed || viewportCompactCanvas ? -1 : 0}
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
        <CanvasWorkspace
          graph={snapshot.editablePrototype.graph}
          graphRevision={snapshot.editablePrototype.revision}
          referencePreviews={referencePreviews}
          mode={canvasMode}
          readOnly={
            prototypeModeChanging || snapshot.prototypeGraphHydration.state === 'recovery-required'
          }
          saveStatus={graphSaveStatus}
          {...(snapshot.editablePrototype.runtime
            ? { activeNodeId: snapshot.editablePrototype.runtime.activeNodeId }
            : {})}
          catalogEntries={snapshot.componentCatalog.entries}
          activatableNodeIds={snapshot.editablePrototype.graph.scenarios.map(
            (scenario) => scenario.startNodeId
          )}
          onModeChange={changeCanvasMode}
          onGraphChange={saveGraph}
          onActivateNode={activateCanvasNode}
          onNodeSelectionChange={(nodeId) => {
            setSelectedCanvasNodeId(nodeId);
            setInspectorSelectionDismissed(nodeId === undefined);
            // Graph selection is inspector context, not conversation ownership.
            // React Flow can re-emit node selection after any nested artifact
            // control. Keep the thread open until the active artifact actually
            // changes, blank-canvas dismissal runs, or the designer closes it.
            if (nodeId) selectInspectorTab('inspect');
          }}
          onConnectionSelectionChange={(selection) => {
            setSelectedCanvasConnection(selection);
            if (selection) selectInspectorTab('inspect');
          }}
          onRequestAiTarget={requestAiCanvasTarget}
          onClearSelection={clearCanvasSelection}
          onRequestReviewTarget={beginArtifactComment}
          onCanvasNavigationChange={onCanvasNavigationChange}
          canRequestAiTarget={canRequestAiTarget}
          {...(compactInspector && effectiveLeftCollapsed
            ? {
                onOpenAi: () => {
                  if (viewportCompactCanvas) {
                    setCompactAiRailVisible(true, true);
                    return;
                  }
                  setLeftCollapsed(false);
                  persistPreferences({ leftRailCollapsed: false });
                }
              }
            : {})}
          {...(compactInspector
            ? {
                onOpenInspector: () => {
                  inspectorDrawerTriggerRef.current?.focus();
                  openInspectorDrawer();
                }
              }
            : {})}
          preview={
            <ArtboardPreview
              key={`${snapshot.source.projectId}:${canvasMode === 'design' ? (snapshot.editablePrototype.runtime?.activeNodeId ?? 'default') : 'present'}:${canvasPreviewBuild?.revisionId ?? 'unbuilt'}:${canvasPreviewBuild?.policy?.nonce ?? 'unfenced'}:${canvasPreviewBuild?.url ?? 'unpublished'}`}
              {...(canvasPreviewBuild === undefined ? {} : { build: canvasPreviewBuild })}
              frame={frame}
              onFrameLoad={onFrameLoad}
              onFrameError={onFrameError}
              targeting={canvasMode !== 'present' && activeTargetMode !== 'idle'}
              targetMode={activeTargetMode}
              {...(canvasMode === 'present' || currentAiTarget === undefined
                ? {}
                : { aiTarget: currentAiTarget })}
              {...(canvasMode === 'present' || currentReviewTarget === undefined
                ? {}
                : { reviewTarget: currentReviewTarget })}
              onTargetPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
                const start = targetAt(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                  frame.current ?? undefined
                );
                if (!start) return;
                dragStart.current = start;
              }}
              onTargetPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
                const start = dragStart.current;
                const end = targetAt(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                  frame.current ?? undefined
                );
                dragStart.current = undefined;
                if (!start || !end) return;
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
              }}
              onTargetClick={(event: PointerEvent<HTMLButtonElement>) => {
                if (event.detail !== 0) return;
                const box = event.currentTarget.getBoundingClientRect();
                const selected = targetAt(
                  event.currentTarget,
                  box.left + box.width / 2,
                  box.top + box.height / 2,
                  frame.current ?? undefined
                );
                if (selected) completeTargetSelection(selected);
              }}
              pins={canvasMode === 'present' ? [] : snapshot.artifactPins}
              {...(canvasMode === 'present' || selectedArtifactPinId === undefined
                ? {}
                : { selectedPinId: selectedArtifactPinId })}
              onSelectPin={selectArtifactPin}
              {...(canvasMode === 'present' || selectedThread === undefined
                ? {}
                : { selectedThread })}
              replyBody={replyBody}
              threadAction={threadAction}
              threadStatus={
                selectedThread
                  ? threadAiStatus?.threadId === selectedThread.id
                    ? threadAiStatus.message
                    : threadStatus?.threadId === selectedThread.id
                      ? threadStatus.message
                      : ''
                  : ''
              }
              onReplyBodyChange={(body) => {
                if (selectedThread)
                  setReplyDrafts((current) => ({ ...current, [selectedThread.id]: body }));
              }}
              onReplyThread={replyToSelectedThread}
              onInsertAiMention={() => {
                if (!selectedThread) return;
                setReplyDrafts((current) => {
                  const draft = current[selectedThread.id] ?? '';
                  return {
                    ...current,
                    [selectedThread.id]: draft.length === 0 ? '@AI ' : `${draft} @AI `
                  };
                });
              }}
              onResolveThread={resolveSelectedThread}
              onCloseThread={closeSelectedThread}
              presenting={canvasMode === 'present'}
              onAskAiFromThread={askAiFromThread}
              threadIndex={Math.max(
                0,
                selectedThreadIndex(snapshot.reviewThreads, selectedThreadId)
              )}
              threadCount={snapshot.reviewThreads.length}
              onNavigateThread={navigateThread}
              onShowAllThreads={() => {
                setRightCollapsed(false);
                if (compactInspector) setInspectorDrawerOpen(true);
                selectInspectorTab('reviews');
              }}
              onClearArtifactSelection={clearCanvasSelection}
            />
          }
        />
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
                <span>Current live-artboard context. Return to the canvas when you are done.</span>
              </div>
              <button
                className="workspace-inspector-drawer__close"
                type="button"
                ref={inspectorDrawerCloseRef}
                onClick={closeInspectorDrawer}
              >
                Back to canvas
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
              <>
                <ContextualInspector
                  snapshot={snapshot}
                  selectedArtifactPinId={selectedArtifactPinId}
                  aiTarget={currentAiTarget}
                  reviewTarget={currentReviewTarget}
                  targetMode={activeTargetMode}
                  aiBusy={aiBusy}
                  {...(selectedCanvasNodeId === undefined
                    ? {}
                    : { selectedGraphNodeId: selectedCanvasNodeId })}
                  {...(inspectorSelectionDismissed && currentPreviewTelemetry === undefined
                    ? { hideSnapshotSelection: true }
                    : {})}
                  {...(currentPreviewTelemetry === undefined
                    ? {}
                    : { selectedPreviewTelemetry: currentPreviewTelemetry })}
                  {...(selectedCanvasConnection
                    ? { prototypeConnection: selectedCanvasConnection }
                    : {})}
                  onHandoff={handoffInspectorTarget}
                />
                {snapshot.prototypeGraphHydration.state === 'recovery-required' ? (
                  <section className="workspace-notice canvas-recovery" role="alert">
                    <p>Recover the saved graph before continuing in the canvas.</p>
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
              </>
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
                      ref={reviewComposerRef}
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
                    {currentReviewTarget ? (
                      <button
                        type="button"
                        disabled={reviewSubmitting}
                        onClick={() => {
                          setReviewTarget(undefined);
                          setReviewTargetProjectId(undefined);
                          setReviewStatus(
                            'Cleared the review target. Choose another point or region.'
                          );
                        }}
                      >
                        Clear review target
                      </button>
                    ) : null}
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
                    {safeDesignerNotice(
                      reviewStatus,
                      'Review status is unavailable. Try saving the thread again.'
                    )}
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
