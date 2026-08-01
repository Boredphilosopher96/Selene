import {
  useEffect,
  useMemo,
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
  AIChangeRequest,
  AIChangeRequestInput,
  AIChangeUndoInput,
  AIProposalDecisionInput,
  ManualDesignUndoInput,
  DesignerProgress,
  DesignerSnapshot,
  DesignSystemComponentPropertyValue,
  DeveloperAnnotationInput,
  ManualLayoutProperty,
  ManualLayoutValue,
  ReviewThreadInput,
  ReviewThreadReplyInput,
  ReviewThreadResolutionInput,
  SpatialTargetInput,
  PrototypeScenarioStartInput,
  WorkspaceCockpitPreferences
} from '../../../shared/designer-api';
import { presentDesignerError } from '../presentation-error';
import {
  type PreviewElementTelemetrySelection,
  type PreviewMappedElementTelemetrySelection
} from '../../../shared/preview-channel';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { isCurrentProjectOwner, requestInput } from './ai-conversation-model';
import { AIConversationWorkspace } from './ai-conversation-workspace';
import { ArtboardPreview } from './artboard-preview';
import { sourceBackedArtifactGapPixels } from './artifact-auto-layout';
import { artifactSelectionAnchor } from './artifact-selection-anchor';
import { adjacentThreadId, selectedThreadIndex } from './comment-thread-navigation';
import {
  CanvasWorkspace,
  type CanvasArtifactFocusRequest,
  type CanvasArtifactReview,
  type CanvasPrototypeConnectionSelection,
  type CanvasWorkspaceMode
} from './canvas-workspace';
import { catalogInsertTarget } from './canvas-workspace-model';
import { ContextualInspector, type ManualTextEditorPort } from './contextual-inspector';
import {
  compactCockpitMediaQuery,
  compactCanvasMediaQuery,
  compactAiRailEscapeAction,
  compactAiRailFocusTarget,
  desktopCockpitLayoutMode,
  inspectorDrawerAccessibilityState,
  inspectorDrawerBlocksInteraction
} from './desktop-cockpit-layout';
import type { PreviewBuild } from './artifact-preview-contracts';
import './desktop-cockpit.css';

export const inspectorTabs = ['inspect', 'handoff', 'setup'] as const;
export type InspectorTab = (typeof inspectorTabs)[number];
const paneMinimum = workspaceCockpitRailMinimum;
const paneMaximum = workspaceCockpitRailMaximum;
const initialReplyDraft = '';

type CatalogInsertEntry = DesignerSnapshot['componentCatalog']['entries'][number];

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

function componentMutationFailure(
  action: 'insert' | 'replace',
  diagnosticCode: string | undefined
): string {
  const subject = action === 'insert' ? 'Component insertion' : 'Component replacement';
  const guidance =
    diagnosticCode === 'STALE_SOURCE' ||
    diagnosticCode === 'STALE_BINDING' ||
    diagnosticCode === 'STALE_DESIGN_SYSTEM_LOCK'
      ? 'The React artifact changed. Select the target again and retry.'
      : diagnosticCode === 'UNAPPROVED_COMPONENT'
        ? 'The approved design-system package changed. Refresh the package in Setup.'
        : diagnosticCode === 'COMPONENT_IMPORT_CONFLICT'
          ? 'An existing import conflicts with this component. Resolve the import or choose another component.'
          : diagnosticCode === 'MISSING_TARGET' ||
              diagnosticCode === 'MISSING_HOST_BINDING' ||
              diagnosticCode === 'SOURCE_BINDING_MISMATCH'
            ? 'The selected element is no longer source-backed. Select a mapped React target.'
            : 'The compiler could not apply this source-safe change.';
  return `${subject} stopped (${diagnosticCode ?? 'UNKNOWN_REJECTION'}). ${guidance}`;
}

export interface DesktopCockpitActions {
  snapshot(): Promise<DesignerSnapshot>;
  selectNode(nodeId: string): Promise<DesignerSnapshot>;
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  acceptAIProposal(input: AIProposalDecisionInput): Promise<DesignerSnapshot>;
  rejectAIProposal(input: AIProposalDecisionInput): Promise<DesignerSnapshot>;
  cancelAIChange(requestId: string): Promise<void>;
  undoLastAIChange(input: AIChangeUndoInput): Promise<DesignerSnapshot>;
  undoLatestManualDesignEdit(input: ManualDesignUndoInput): Promise<DesignerSnapshot>;
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
  readonly onPreviewAIProposal: (input: AIProposalDecisionInput) => Promise<void>;
  readonly onPreviewCurrentRevision: () => Promise<void>;
  readonly onBuildStoryPreview?: (
    ticket: import('../../../shared/designer-api').StoryPreviewTicket
  ) => Promise<import('../../../shared/designer-api').StoryPreviewBuildResult>;
  /** Clears parent-owned telemetry when the cockpit clears or replaces its selection. */
  readonly onPreviewSelectionClear: () => void;
  /** Keeps the renderer-owned preview channel in sync with canvas mode changes. */
  readonly onCanvasNavigationChange: (enabled: boolean) => void;
  /** Escape is forwarded only while the live prototype is presenting. */
  readonly onPreviewTargetCancelChange: (enabled: boolean) => void;
  readonly manualTextEditor: ManualTextEditorPort;
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
  /** Direct-manipulation chrome is only allowed after a completed iframe selection gesture. */
  readonly previewDirectSelectionAuthorized?: boolean;
  /** Authoritative clears from the host discard renderer-owned AI target state. */
  readonly previewSelectionClearEpoch?: number;
}

/** A canvas pin is visible only on the exact rendered project screen that owns it. */
function belongsToActiveArtifact(
  anchor: Pick<DesignerSnapshot['reviewThreads'][number]['anchor'], 'artifactId' | 'screenId'>,
  projectId: string,
  screenId: string
): boolean {
  return anchor.artifactId === projectId && anchor.screenId === screenId;
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
  onPreviewAIProposal,
  onPreviewCurrentRevision,
  onBuildStoryPreview,
  onPreviewSelectionClear,
  onCanvasNavigationChange,
  onPreviewTargetCancelChange,
  manualTextEditor,
  actions,
  guidedActions,
  progress,
  preferences,
  onPreferencesChange,
  initialSelectedThreadId,
  compactLayout,
  initialInspectorDrawerOpen = false,
  selectedPreviewTelemetry,
  previewDirectSelectionAuthorized = false,
  previewSelectionClearEpoch
}: DesktopCockpitProps) {
  const pendingAIProposal = snapshot.pendingAIProposal;
  const proposalPreviewActive =
    pendingAIProposal !== undefined && build?.revisionId === pendingAIProposal.candidateRevisionId;
  const currentPreviewTelemetry =
    selectedPreviewTelemetry !== undefined &&
    build?.revisionId === selectedPreviewTelemetry.revisionId
      ? selectedPreviewTelemetry
      : undefined;
  const currentPreviewTelemetryIdentity =
    currentPreviewTelemetry?.provenance === 'authenticated-preview-node'
      ? currentPreviewTelemetry.nodeId
      : currentPreviewTelemetry?.elementId;
  const currentPreviewTelemetryRevisionId = currentPreviewTelemetry?.revisionId;
  const currentCatalogInsertTarget = useMemo(
    () => catalogInsertTarget(snapshot.catalogReplaceTarget?.nodeId, snapshot.catalogInsertTarget),
    [
      snapshot.catalogInsertTarget?.layout,
      snapshot.catalogInsertTarget?.nodeId,
      snapshot.catalogReplaceTarget?.nodeId
    ]
  );
  const currentCatalogReplaceTarget = snapshot.catalogReplaceTarget?.nodeId;
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
  const [selectedArtifactPinId, setSelectedArtifactPinId] = useState<string | undefined>(() =>
    initialSelectedThreadId !== undefined &&
    snapshot.artifactPins.some((pin) => pin.id === initialSelectedThreadId)
      ? initialSelectedThreadId
      : undefined
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    initialSelectedThreadId
  );
  const [artifactFocusRequest, setArtifactFocusRequest] = useState<
    CanvasArtifactFocusRequest | undefined
  >();
  const [replyDrafts, setReplyDrafts] = useState<Readonly<Record<string, string>>>({});
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');
  const [aiStatus, setAiStatus] = useState(
    'Choose a target when this change needs spatial context.'
  );
  const [aiBusy, setAiBusy] = useState(false);
  const [proposalPreviewSwitching, setProposalPreviewSwitching] = useState(false);
  const [manualEditStatus, setManualEditStatus] = useState<string>();
  const [threadStatus, setThreadStatus] = useState<{
    readonly threadId: string;
    readonly message: string;
  }>();
  const [threadAction, setThreadAction] = useState<'idle' | 'replying' | 'resolving'>('idle');
  const [prototypeModeChanging, setPrototypeModeChanging] = useState(false);
  const [canvasMode, setCanvasMode] = useState<CanvasWorkspaceMode>('design');
  const canvasPreviewBuild = canvasMode === 'design' ? activePreviewBuild : build;
  const [selectedCanvasConnection, setSelectedCanvasConnection] =
    useState<CanvasPrototypeConnectionSelection>();
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>();
  const [inspectorSelectionDismissed, setInspectorSelectionDismissed] = useState(false);
  // A first-time designer lands on the artifact, not an open conversation or
  // inspector. Persisted workspace preferences intentionally replace these
  // defaults once the host supplies them.
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [compactAiRailOpen, setCompactAiRailOpen] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(initialInspectorDrawerOpen);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspect');
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(340);
  const resizing = useRef<'left' | 'right' | undefined>(undefined);
  const threadActionRef = useRef<'idle' | 'replying' | 'resolving'>('idle');
  const prototypeModeChangingRef = useRef(false);
  const threadInvokingControl = useRef<HTMLElement | null>(null);
  const inspectorTabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const inspectorDrawerRef = useRef<HTMLElement | null>(null);
  const inspectorDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inspectorDrawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const compactAiRailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const compactAiRailCloseRef = useRef<HTMLButtonElement | null>(null);
  const paneWidths = useRef({ left: leftWidth, right: rightWidth });
  const aiBusyRef = useRef(false);
  const targetProject = useRef(snapshot.source.projectId);
  const activeProjectRef = useRef(snapshot.source.projectId);
  const activeArtifactRef = useRef(activeScreenId);
  const artifactFocusSequence = useRef(0);
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
  const activeArtifactThreads = snapshot.reviewThreads.filter((thread) =>
    belongsToActiveArtifact(thread.anchor, snapshot.source.projectId, activeScreenId)
  );
  const activeArtifactPins = snapshot.artifactPins.filter((pin) =>
    belongsToActiveArtifact(pin.anchor, snapshot.source.projectId, activeScreenId)
  );
  const selectedThread = activeArtifactThreads.find((thread) => thread.id === selectedThreadId);
  const selectedScenario = snapshot.scenarios.find(
    (item) => item.id === snapshot.selectedScenarioId
  );
  const activeArtifactNode = snapshot.editablePrototype.graph.nodes.find(
    (node) => node.id === activeScreenId
  );
  // The scenario's declared heading is compiler input for the live React
  // artifact. Keep the drawer aligned with that compiled context instead of
  // repeating a canvas-node label that can lag the rendered screen.
  const inspectorContext =
    selectedScenario?.fixture.heading ??
    activeArtifactNode?.label ??
    selectedScenario?.title ??
    snapshot.source.projectId;
  const setConversationBusy = (busy: boolean) => {
    aiBusyRef.current = busy;
    setAiBusy(busy);
  };
  const currentAiTarget = isCurrentProjectOwner(aiTargetProjectId, snapshot.source.projectId)
    ? aiTarget
    : undefined;
  const canRequestAiTarget =
    !aiBusy &&
    pendingAIProposal === undefined &&
    !proposalPreviewActive &&
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
  const closeSelectedThread = () => {
    setThreadStatus(undefined);
    setSelectedThreadId(undefined);
    setSelectedArtifactPinId(undefined);
    setArtifactFocusRequest(undefined);
    restoreFocus(threadInvokingControl.current);
  };
  const clearedPreviewSelectionEpoch = useRef<number | undefined>(undefined);
  const clearCanvasSelection = (notifyParent = true) => {
    setAiTarget(undefined);
    setAiTargetProjectId(undefined);
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setArtifactFocusRequest(undefined);
    setSelectedCanvasConnection(undefined);
    setSelectedCanvasNodeId(undefined);
    setInspectorSelectionDismissed(true);
    if (notifyParent) onPreviewSelectionClear();
  };
  useEffect(() => {
    if (
      previewSelectionClearEpoch === undefined ||
      clearedPreviewSelectionEpoch.current === previewSelectionClearEpoch
    )
      return;
    clearedPreviewSelectionEpoch.current = previewSelectionClearEpoch;
    clearCanvasSelection(false);
  }, [previewSelectionClearEpoch]);
  useEffect(() => {
    onPreviewTargetCancelChange(canvasMode === 'present');
    return () => onPreviewTargetCancelChange(false);
  }, [canvasMode, onPreviewTargetCancelChange]);
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
      currentPreviewTelemetryIdentity === undefined ||
      currentPreviewTelemetryRevisionId === undefined
    )
      return;
    setSelectedCanvasNodeId(undefined);
    setSelectedCanvasConnection(undefined);
    setInspectorSelectionDismissed(false);
    setInspectorTab('inspect');
  }, [currentPreviewTelemetryIdentity, currentPreviewTelemetryRevisionId]);
  useEffect(() => {
    if (!viewportCompactCanvas) setCompactAiRailOpen(false);
  }, [viewportCompactCanvas]);
  useEffect(() => {
    if (targetProject.current === snapshot.source.projectId) return;
    targetProject.current = snapshot.source.projectId;
    setAiTarget(undefined);
    setAiTargetProjectId(undefined);
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setCanvasMode('design');
    setSelectedCanvasConnection(undefined);
    setSelectedCanvasNodeId(undefined);
    setInspectorSelectionDismissed(false);
    setAiStatus('Select a compiler-authenticated React element when this change needs context.');
  }, [snapshot.source.projectId]);
  useEffect(() => {
    if (activeArtifactRef.current === activeScreenId) return;
    activeArtifactRef.current = activeScreenId;
    onPreviewSelectionClear();
    setArtifactFocusRequest(undefined);
    setSelectedArtifactPinId(undefined);
    setSelectedThreadId(undefined);
    setThreadStatus(undefined);
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
      if (
        currentAiTarget !== undefined ||
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
    compactAiRailOpen,
    compactInspector,
    inspectorDrawerOpen,
    selectedThreadId,
    selectedArtifactPinId,
    selectedCanvasConnection,
    snapshot.source.projectId,
    closeSelectedThread,
    clearCanvasSelection,
    currentAiTarget,
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
  const selectArtifactPin = (id: string, invoking?: HTMLElement) => {
    selectThread(id, invoking);
  };
  const selectThread = (id: string, invoking?: HTMLElement) => {
    const thread = snapshot.reviewThreads.find((item) => item.id === id);
    if (thread === undefined) return;
    if (!belongsToActiveArtifact(thread.anchor, snapshot.source.projectId, activeScreenId)) {
      const artboard = snapshot.editablePrototype.graph.nodes.find(
        (node) =>
          node.id === thread.anchor.screenId && (node.kind === 'screen' || node.kind === 'page')
      );
      if (thread.anchor.artifactId !== snapshot.source.projectId || artboard === undefined) {
        setGraphSaveStatus(
          'This legacy review thread has no exact project artboard, so it cannot open on the artifact.'
        );
        return;
      }
      setArtifactFocusRequest({
        artifactId: artboard.id,
        requestId: ++artifactFocusSequence.current
      });
      setGraphSaveStatus(`Focused ${artboard.label} for the selected review thread.`);
    }
    setThreadStatus(undefined);
    setSelectedThreadId(id);
    if (invoking) threadInvokingControl.current = invoking;
    setSelectedArtifactPinId(snapshot.artifactPins.some((item) => item.id === id) ? id : undefined);
  };
  const createArtifactThread = async (
    selection: PreviewMappedElementTelemetrySelection,
    body: string,
    invoking: HTMLButtonElement
  ): Promise<void> => {
    if (
      canvasMode !== 'design' ||
      !previewDirectSelectionAuthorized ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== selection.nodeId ||
      currentPreviewTelemetry.revisionId !== selection.revisionId
    )
      throw new Error('Select a mapped React element again before starting a thread.');
    const preview = frame.current;
    const anchor =
      preview === null
        ? undefined
        : artifactSelectionAnchor(selection, {
            width: preview.clientWidth,
            height: preview.clientHeight
          });
    if (anchor === undefined)
      throw new Error(
        'The selected element geometry is unavailable. Select it again before commenting.'
      );
    if (selection.revisionId !== snapshot.source.revision.id)
      throw new Error(
        'The selected element is from an older revision. Select it again before commenting.'
      );
    const next = await actions.addReviewThread({ body, anchor });
    const created = next.reviewThreads.find(
      (thread) => !snapshot.reviewThreads.some((current) => current.id === thread.id)
    );
    if (created === undefined)
      throw new Error('The review thread was not projected to this artifact. Try sending again.');
    const pin = next.artifactPins.find((candidate) => candidate.id === created.id);
    if (pin === undefined)
      throw new Error('The review thread was saved without an artifact pin. Try sending again.');
    onSnapshot(next);
    threadInvokingControl.current = invoking;
    setSelectedThreadId(created.id);
    setSelectedArtifactPinId(pin.id);
    setThreadStatus(undefined);
    if (!belongsToActiveArtifact(created.anchor, snapshot.source.projectId, activeScreenId))
      setArtifactFocusRequest({
        artifactId: created.anchor.screenId,
        requestId: ++artifactFocusSequence.current
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
      throw new Error('Saved scenario did not activate the requested artifact.');
    onSnapshot(next);
    if (options.present === false) {
      await onRender(next);
    } else {
      setCanvasMode('present');
    }
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
  const requestAiCanvasTarget = (_invoking: HTMLButtonElement): void => {
    if (!canRequestAiTarget) return;
    setAiStatus('Select a compiler-authenticated React element, then use Ask AI.');
    if (viewportCompactCanvas) setCompactAiRailOpen(true);
  };
  const actOnMappedElement = (
    action: 'ask-ai' | 'inspect',
    selection: PreviewMappedElementTelemetrySelection
  ): void => {
    if (action === 'inspect') {
      setInspectorSelectionDismissed(false);
      openInspectorWorkspace('inspect');
      return;
    }
    if (selection.revisionId !== snapshot.source.revision.id) {
      clearCanvasSelection();
      setAiStatus(
        'The selected element is from an older revision. Select it again before asking AI.'
      );
      return;
    }
    const preview = frame.current;
    const anchor =
      preview === null
        ? undefined
        : artifactSelectionAnchor(selection, {
            width: preview.clientWidth,
            height: preview.clientHeight
          });
    if (anchor === undefined) {
      const message =
        'The selected element geometry is unavailable. Select it again before starting a conversation.';
      setAiStatus(message);
      return;
    }
    if (action === 'ask-ai') {
      if (!canRequestAiTarget) {
        setAiStatus('Connect and select an AI agent before asking about this element.');
        openAiWorkspace();
        return;
      }
      setAiTarget(anchor);
      setAiTargetProjectId(snapshot.source.projectId);
      setAiStatus('Selected React element is attached to the next AI edit request.');
      openAiWorkspace();
      return;
    }
  };
  const showProposalRevision = (): void => {
    if (pendingAIProposal === undefined || proposalPreviewSwitching) return;
    setProposalPreviewSwitching(true);
    clearCanvasSelection();
    void onPreviewAIProposal({
      projectId: snapshot.source.projectId,
      requestId: pendingAIProposal.requestId,
      candidateRevisionId: pendingAIProposal.candidateRevisionId
    })
      .catch((error: unknown) => setAiStatus(presentDesignerError(error, 'preview')))
      .finally(() => setProposalPreviewSwitching(false));
  };
  const showCurrentRevision = (): void => {
    if (pendingAIProposal === undefined || proposalPreviewSwitching) return;
    setProposalPreviewSwitching(true);
    clearCanvasSelection();
    void onPreviewCurrentRevision()
      .then(() => setAiStatus('Viewing the current design beside the staged AI proposal.'))
      .catch((error: unknown) => setAiStatus(presentDesignerError(error, 'preview')))
      .finally(() => setProposalPreviewSwitching(false));
  };
  const navigateThread = (direction: -1 | 1): void => {
    const next = adjacentThreadId(activeArtifactThreads, selectedThreadId, direction);
    if (next !== undefined) selectThread(next);
  };
  const canvasArtifactReviews: readonly CanvasArtifactReview[] =
    snapshot.editablePrototype.graph.nodes
      .filter((node) => node.kind === 'screen' || node.kind === 'page')
      .map((node) => {
        const threads = snapshot.reviewThreads.filter((thread) =>
          belongsToActiveArtifact(thread.anchor, snapshot.source.projectId, node.id)
        );
        const selected = threads.find((thread) => thread.id === selectedThreadId);
        return {
          screenId: node.id,
          pins: snapshot.artifactPins.filter((pin) =>
            belongsToActiveArtifact(pin.anchor, snapshot.source.projectId, node.id)
          ),
          ...(selectedArtifactPinId === undefined ? {} : { selectedPinId: selectedArtifactPinId }),
          ...(selected === undefined ? {} : { selectedThread: selected }),
          replyBody: selected ? (replyDrafts[selected.id] ?? initialReplyDraft) : '',
          threadAction,
          threadStatus:
            selected && threadStatus?.threadId === selected.id ? threadStatus.message : '',
          onSelectPin: selectArtifactPin,
          onReplyBodyChange: (body: string) => {
            if (selected) setReplyDrafts((current) => ({ ...current, [selected.id]: body }));
          },
          onReplyThread: replyToSelectedThread,
          onResolveThread: resolveSelectedThread,
          onCloseThread: closeSelectedThread,
          presenting: false,
          onInsertAiMention: () => {
            if (!selected) return;
            setReplyDrafts((current) => {
              const draft = current[selected.id] ?? '';
              return { ...current, [selected.id]: draft.length === 0 ? '@AI ' : `${draft} @AI ` };
            });
          },
          threadIndex: Math.max(0, selectedThreadIndex(threads, selectedThreadId)),
          threadCount: threads.length,
          onNavigateThread: (direction: -1 | 1) => {
            const next = adjacentThreadId(threads, selectedThreadId, direction);
            if (next !== undefined) selectThread(next);
          }
        };
      });
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
    mode: 'ai',
    target: SpatialTargetInput,
    _invoking: HTMLButtonElement
  ) => {
    if (aiBusyRef.current) return;
    setAiTarget(target);
    setAiTargetProjectId(snapshot.source.projectId);
    setAiStatus('Inspect context is ready for the next AI edit request.');
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
  const openAiWorkspace = () => {
    if (viewportCompactCanvas) {
      setCompactAiRailVisible(true, true);
      return;
    }
    setLeftCollapsed(false);
    setRightCollapsed(true);
    if (compactInspector) setInspectorDrawerOpen(false);
    persistPreferences({ leftRailCollapsed: false, rightRailCollapsed: true });
  };
  const openInspectorWorkspace = (tab: InspectorTab) => {
    selectInspectorTab(tab);
    setRightCollapsed(false);
    setLeftCollapsed(true);
    if (viewportCompactCanvas) setCompactAiRailVisible(false);
    if (compactInspector) openInspectorDrawer();
    persistPreferences({
      inspectorTab: tab,
      leftRailCollapsed: true,
      rightRailCollapsed: false
    });
  };
  const applySelectedElementLayout = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly property: ManualLayoutProperty;
    readonly value: ManualLayoutValue;
    readonly operation: string;
    readonly successMessage: string;
    readonly unavailableMessage: string;
    readonly refreshFailureMessage: string;
  }): Promise<Readonly<{ applied: boolean; message: string }>> => {
    if (
      canvasMode !== 'design' ||
      snapshot.source.revision.id !== input.revisionId ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== input.nodeId ||
      currentPreviewTelemetry.revisionId !== input.revisionId
    )
      return {
        applied: false,
        message: `${input.operation} stopped because the selected React revision changed. Select it again.`
      };
    try {
      const capability = await manualTextEditor.requestManualLayoutEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: input.nodeId,
        revisionId: input.revisionId
      });
      if (capability.kind !== 'available' || !capability.properties.includes(input.property))
        return { applied: false, message: input.unavailableMessage };
      if (input.property === 'gap') {
        const currentGap = capability.currentValues.gap;
        if (sourceBackedArtifactGapPixels(currentGap) === undefined)
          return {
            applied: false,
            message:
              'This gap is token-based, relative, inherited, or multi-axis. Use Inspect or ask AI so Selene preserves the authored design value.'
          };
      }
      const result = await manualTextEditor.applyManualLayoutEdit({
        format: 'selene-desktop-manual-layout-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: capability.capabilityId,
        property: input.property,
        value: input.value
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed')
        return {
          applied: false,
          message: `${input.operation} was not applied: ${result.diagnostics[0]?.code ?? 'layout unavailable'}.`
        };
      const next = await manualTextEditor.snapshot();
      setManualEditStatus(input.successMessage);
      onSnapshot(next);
      try {
        await onRender(next);
        return { applied: true, message: input.successMessage };
      } catch {
        setManualEditStatus(input.refreshFailureMessage);
        return { applied: true, message: input.refreshFailureMessage };
      }
    } catch {
      return {
        applied: false,
        message: `${input.operation} is unavailable. Select the element again or use Auto layout in Inspect.`
      };
    }
  };
  const resizeSelectedElement = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly property: 'width' | 'height';
    readonly value: number;
  }): Promise<Readonly<{ applied: boolean; message: string }>> =>
    applySelectedElementLayout({
      ...input,
      value: `${input.value}px`,
      operation: 'Resize',
      successMessage: `${input.property === 'width' ? 'Width' : 'Height'} updated to ${input.value}px in React source.`,
      unavailableMessage:
        'This element cannot be resized safely. Use Frame controls to inspect its authored layout.',
      refreshFailureMessage: 'React source was saved, but the resized preview could not refresh.'
    });
  const updateSelectedElementLayout = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly property: 'gap' | 'alignItems' | 'justifyContent';
    readonly value: string;
  }): Promise<Readonly<{ applied: boolean; message: string }>> => {
    const label =
      input.property === 'gap'
        ? 'Gap'
        : input.property === 'alignItems'
          ? 'Alignment'
          : 'Distribution';
    return applySelectedElementLayout({
      ...input,
      operation: 'Auto layout',
      successMessage: `${label} updated to ${input.value} in React source.`,
      unavailableMessage:
        'This container has no compiler-proven source-backed control for that auto-layout value. Use Inspect or ask AI.',
      refreshFailureMessage: `React source was saved, but the ${label.toLowerCase()} preview could not refresh.`
    });
  };
  const beginSelectedElementTextEdit = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
  }): Promise<
    | Readonly<{
        available: true;
        capabilityId: string;
        currentContent: string;
        maxLength: number;
      }>
    | Readonly<{ available: false; message: string }>
  > => {
    if (
      canvasMode !== 'design' ||
      snapshot.source.revision.id !== input.revisionId ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== input.nodeId ||
      currentPreviewTelemetry.revisionId !== input.revisionId
    )
      return {
        available: false,
        message: 'Text edit stopped because the selected React revision changed. Select it again.'
      };
    try {
      const capability = await manualTextEditor.requestManualTextEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: input.nodeId,
        revisionId: input.revisionId
      });
      if (capability.kind !== 'available')
        return {
          available: false,
          message:
            'This element does not have one literal JSX text child. Use Inspect or ask AI for expressions and nested content.'
        };
      return {
        available: true,
        capabilityId: capability.capabilityId,
        currentContent: capability.currentContent,
        maxLength: capability.maxLength
      };
    } catch {
      return {
        available: false,
        message: 'Direct text editing is unavailable. Select the mapped React element again.'
      };
    }
  };
  const updateSelectedElementText = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly capabilityId: string;
    readonly content: string;
  }): Promise<Readonly<{ applied: boolean; message: string }>> => {
    if (
      canvasMode !== 'design' ||
      snapshot.source.revision.id !== input.revisionId ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== input.nodeId ||
      currentPreviewTelemetry.revisionId !== input.revisionId
    )
      return {
        applied: false,
        message: 'Text edit stopped because the selected React revision changed. Select it again.'
      };
    try {
      const result = await manualTextEditor.applyManualTextEdit({
        format: 'selene-desktop-manual-text-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: input.capabilityId,
        content: input.content
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed')
        return {
          applied: false,
          message: `Text was not updated: ${result.diagnostics[0]?.code ?? 'text unavailable'}.`
        };
      const next = await manualTextEditor.snapshot();
      const status =
        result.kind === 'applied'
          ? 'Text updated in React source.'
          : 'The existing React text update was replayed.';
      setManualEditStatus(status);
      onSnapshot(next);
      try {
        await onRender(next);
        return { applied: true, message: status };
      } catch {
        const message = 'React source was saved, but the edited preview could not refresh.';
        setManualEditStatus(message);
        return { applied: true, message };
      }
    } catch {
      return {
        applied: false,
        message: 'Text update is unavailable. Refresh the selection and try again.'
      };
    }
  };
  const moveSelectedElement = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly deltaX: number;
    readonly deltaY: number;
  }): Promise<Readonly<{ applied: boolean; message: string }>> => {
    if (
      canvasMode !== 'design' ||
      snapshot.source.revision.id !== input.revisionId ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== input.nodeId ||
      currentPreviewTelemetry.revisionId !== input.revisionId
    )
      return {
        applied: false,
        message: 'Move stopped because the selected React revision changed. Select it again.'
      };
    try {
      const capability = await manualTextEditor.requestManualPositionEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: input.nodeId,
        revisionId: input.revisionId
      });
      if (capability.kind !== 'available')
        return {
          applied: false,
          message:
            'Move is available only for authored inline absolute or fixed left/top. Flex, grid, and static elements stay unchanged.'
        };
      const result = await manualTextEditor.applyManualPositionEdit({
        format: 'selene-desktop-manual-position-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: capability.capabilityId,
        left: capability.currentValues.left + input.deltaX,
        top: capability.currentValues.top + input.deltaY
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed')
        return {
          applied: false,
          message: `Move was not applied: ${result.diagnostics[0]?.code ?? 'position unavailable'}.`
        };
      const next = await manualTextEditor.snapshot();
      const status = `Position updated by ${input.deltaX}, ${input.deltaY}px in React source.`;
      setManualEditStatus(status);
      onSnapshot(next);
      try {
        // The shared authoring refresh reselects the same host-confirmed node
        // on the new revision before publishing it back to the artboard.
        await onRender(next);
        return { applied: true, message: status };
      } catch {
        const message = 'React source was saved, but the moved preview could not refresh.';
        setManualEditStatus(message);
        return { applied: true, message };
      }
    } catch {
      return {
        applied: false,
        message: 'Move is unavailable. Select the authored absolute or fixed element again.'
      };
    }
  };
  const reorderSelectedElement = async (input: {
    readonly nodeId: string;
    readonly revisionId: string;
    readonly targetNodeId: string;
  }): Promise<Readonly<{ applied: boolean; message: string }>> => {
    if (
      manualTextEditor.requestManualStructureEditCapability === undefined ||
      manualTextEditor.applyManualStructureEdit === undefined
    )
      return {
        applied: false,
        message: 'Semantic reordering is unavailable until the desktop host has refreshed.'
      };
    if (
      canvasMode !== 'design' ||
      snapshot.source.revision.id !== input.revisionId ||
      currentPreviewTelemetry?.provenance !== 'authenticated-preview-node' ||
      currentPreviewTelemetry.nodeId !== input.nodeId ||
      currentPreviewTelemetry.revisionId !== input.revisionId
    )
      return {
        applied: false,
        message:
          'Structure edit stopped because the selected React revision changed. Select it again.'
      };
    try {
      const capability = await manualTextEditor.requestManualStructureEditCapability({
        projectId: snapshot.source.projectId,
        nodeId: input.nodeId,
        revisionId: input.revisionId,
        targetNodeId: input.targetNodeId
      });
      if (capability.kind !== 'available')
        return {
          applied: false,
          message:
            capability.code === 'COMPONENT_SLOT_REQUIRED'
              ? 'That component has no declared children slot. Choose a package-declared drop zone.'
              : capability.code === 'INCOMPATIBLE_COMPONENT_SLOT'
                ? 'That component type is not accepted by this design-system slot.'
                : capability.code === 'SLOT_CARDINALITY_VIOLATION'
                  ? 'That move would violate the design-system slot item limit.'
                  : capability.code === 'UNMAPPED_COMPONENT_CHILD'
                    ? 'This restricted slot accepts only mapped design-system components.'
                    : capability.code === 'STALE_SELECTION'
                      ? 'The React revision changed. Select the component again before moving it.'
                      : 'This move is not source-safe. Use a mapped sibling in a literal React container.'
        };
      const result = await manualTextEditor.applyManualStructureEdit({
        format: 'selene-desktop-manual-structure-edit-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: capability.capabilityId
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed')
        return {
          applied: false,
          message: `Structure edit was not applied: ${result.diagnostics[0]?.code ?? 'unavailable'}.`
        };
      const next = await manualTextEditor.snapshot();
      const status = `${capability.operation === 'reparent' ? 'Moved to a compatible container' : 'Reordered'} in React source.`;
      setManualEditStatus(status);
      onSnapshot(next);
      try {
        await onRender(next);
        return { applied: true, message: status };
      } catch {
        const message = 'React source was saved, but the reorganized preview could not refresh.';
        setManualEditStatus(message);
        return { applied: true, message };
      }
    } catch {
      return {
        applied: false,
        message: 'Structure edit is unavailable. Select mapped React elements again.'
      };
    }
  };
  const insertDesignSystemComponent = async (
    entry: CatalogInsertEntry,
    props: Readonly<Record<string, DesignSystemComponentPropertyValue>> | undefined,
    target: Readonly<{ projectId: string; nodeId: string; revisionId: string }>
  ): Promise<string> => {
    if (
      entry.origin !== 'design-system' ||
      entry.packageName === undefined ||
      entry.version === undefined ||
      entry.entrypoint === undefined ||
      entry.exportName === undefined ||
      entry.artifactDigest === undefined
    )
      return 'This catalog entry is missing host-approved provenance.';
    const requestCapability = manualTextEditor.requestDesignSystemComponentInsertCapability;
    const applyInsertion = manualTextEditor.applyDesignSystemComponentInsert;
    if (!requestCapability || !applyInsertion)
      return 'Component insertion is unavailable in this desktop host.';
    try {
      setManualEditStatus(`Authorizing ${entry.component} insertion…`);
      const capability = await requestCapability({
        projectId: target.projectId,
        nodeId: target.nodeId,
        revisionId: target.revisionId,
        component: {
          packageName: entry.packageName,
          version: entry.version,
          entrypoint: entry.entrypoint,
          exportName: entry.exportName,
          artifactDigest: entry.artifactDigest
        },
        ...(props === undefined ? {} : { props })
      });
      if (capability.kind !== 'available') {
        if (capability.code === 'COMPONENT_NOT_APPROVED')
          return 'That library component changed or was disabled. Refresh Assets and try again.';
        if (capability.code === 'COMPONENT_CONFIGURATION_INVALID')
          return 'Choose valid values for every required component property.';
        if (capability.code === 'STALE_SELECTION' || capability.code === 'PROJECT_MISMATCH')
          return 'The selected React revision changed. Select the container again.';
        if (capability.code === 'MAPPED_INSERTION_UNAVAILABLE')
          return 'Select a source-backed flex or grid container for this component.';
        return 'Component insertion is unavailable until the compiled preview refreshes.';
      }
      setManualEditStatus(`Applying ${entry.component} to the React source…`);
      const result = await applyInsertion({
        format: 'selene-desktop-design-system-component-insert-apply/v1',
        projectId: target.projectId,
        capabilityId: capability.capabilityId
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed') {
        const failure = componentMutationFailure('insert', result.diagnostics[0]?.code);
        setManualEditStatus(failure);
        return failure;
      }
      const status =
        result.kind === 'applied'
          ? `${entry.component} inserted into the React artifact.`
          : `${entry.component} insertion replayed.`;
      setManualEditStatus('Refreshing the compiled React preview…');
      const next = await manualTextEditor.snapshot();
      onSnapshot(next);
      try {
        await onRender(next, 'authoring');
      } catch {
        const failure = `${status} The preview could not refresh yet.`;
        setManualEditStatus(failure);
        return failure;
      }
      setManualEditStatus(status);
      return status;
    } catch {
      setManualEditStatus('Component insertion could not finish. Refresh the selection and retry.');
      return 'Component insertion is unavailable. Refresh the selection and try again.';
    }
  };
  const replaceDesignSystemComponent = async (
    entry: CatalogInsertEntry,
    props?: Readonly<Record<string, DesignSystemComponentPropertyValue>>
  ): Promise<string> => {
    const selectedNodeId = snapshot.catalogReplaceTarget?.nodeId;
    if (canvasMode !== 'design' || selectedNodeId === undefined)
      return 'Select a mapped React element before replacing it.';
    if (
      entry.origin !== 'design-system' ||
      entry.packageName === undefined ||
      entry.version === undefined ||
      entry.entrypoint === undefined ||
      entry.exportName === undefined ||
      entry.artifactDigest === undefined
    )
      return 'This catalog entry is missing host-approved provenance.';
    const requestCapability = manualTextEditor.requestDesignSystemComponentReplaceCapability;
    const applyReplacement = manualTextEditor.applyDesignSystemComponentReplace;
    if (!requestCapability || !applyReplacement)
      return 'Component replacement is unavailable in this desktop host.';
    try {
      const capability = await requestCapability({
        projectId: snapshot.source.projectId,
        nodeId: selectedNodeId,
        revisionId: snapshot.source.revision.id,
        component: {
          packageName: entry.packageName,
          version: entry.version,
          entrypoint: entry.entrypoint,
          exportName: entry.exportName,
          artifactDigest: entry.artifactDigest
        },
        ...(props === undefined ? {} : { props })
      });
      if (capability.kind !== 'available') {
        if (capability.code === 'COMPONENT_NOT_APPROVED')
          return 'That library component changed or was disabled. Refresh Assets and try again.';
        if (capability.code === 'COMPONENT_CONFIGURATION_INVALID')
          return 'Choose valid values for every required component property.';
        if (capability.code === 'STALE_SELECTION' || capability.code === 'PROJECT_MISMATCH')
          return 'The selected React revision changed. Select the element again.';
        if (capability.code === 'MAPPED_REPLACEMENT_UNAVAILABLE')
          return 'This selection cannot be safely replaced. Choose a compiler-mapped React element.';
        return 'Component replacement is unavailable until the compiled preview refreshes.';
      }
      const result = await applyReplacement({
        format: 'selene-desktop-design-system-component-replace-apply/v1',
        projectId: snapshot.source.projectId,
        capabilityId: capability.capabilityId
      });
      if (result.kind !== 'applied' && result.kind !== 'replayed') {
        const failure = componentMutationFailure('replace', result.diagnostics[0]?.code);
        setManualEditStatus(failure);
        return failure;
      }
      const status =
        result.kind === 'applied'
          ? `Selected element replaced with ${entry.component}; children and review identity were preserved.`
          : `${entry.component} replacement replayed.`;
      const next = await manualTextEditor.snapshot();
      onSnapshot(next);
      try {
        await onRender(next, 'authoring');
      } catch {
        const failure = `${status} The preview could not refresh yet.`;
        setManualEditStatus(failure);
        return failure;
      }
      setManualEditStatus(status);
      return status;
    } catch {
      const failure = 'Component replacement is unavailable. Refresh the selection and try again.';
      setManualEditStatus(failure);
      return failure;
    }
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
            if (!next) setRightCollapsed(true);
            persistPreferences({
              leftRailCollapsed: next,
              ...(next ? {} : { rightRailCollapsed: true })
            });
          }}
        >
          {effectiveLeftCollapsed ? 'Show AI rail' : 'Hide AI rail'}
        </button>
        <div className="conversation-rail__body" hidden={effectiveLeftCollapsed}>
          <AIConversationWorkspace
            snapshot={snapshot}
            {...(progress === undefined ? {} : { progress })}
            target={currentAiTarget}
            status={aiStatus}
            actions={{
              snapshot: actions.snapshot,
              selectAgent: actions.selectAgent,
              requestAIChange: actions.requestAIChange,
              acceptAIProposal: actions.acceptAIProposal,
              rejectAIProposal: actions.rejectAIProposal,
              cancelAIChange: actions.cancelAIChange,
              undoLastAIChange: actions.undoLastAIChange,
              undoLatestManualDesignEdit: actions.undoLatestManualDesignEdit
            }}
            onSnapshot={onSnapshot}
            onRender={onRender}
            onPreviewProposal={onPreviewAIProposal}
            onPrepareProposalRevision={(request: AIChangeRequest) => {
              setAiTarget(requestInput(request).target);
              setAiTargetProjectId(snapshot.source.projectId);
              setAiStatus('Revise the saved instruction, then send it as a new AI request.');
            }}
            onStatusChange={setAiStatus}
            onBusyChange={setConversationBusy}
            onSelectOnCanvas={() =>
              setAiStatus('Select a compiler-authenticated React element, then use Ask AI.')
            }
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
          artifactReviews={canvasArtifactReviews}
          {...(artifactFocusRequest === undefined ? {} : { artifactFocusRequest })}
          mode={canvasMode}
          readOnly={
            proposalPreviewActive ||
            prototypeModeChanging ||
            snapshot.prototypeGraphHydration.state === 'recovery-required'
          }
          saveStatus={graphSaveStatus}
          viewportLayoutKey={`${layoutMode}:${effectiveLeftCollapsed ? 'left-closed' : leftWidth}:${rightCollapsed ? 'right-closed' : rightWidth}`}
          {...(snapshot.editablePrototype.runtime
            ? { activeNodeId: snapshot.editablePrototype.runtime.activeNodeId }
            : {})}
          catalogEntries={snapshot.componentCatalog.entries}
          catalogManifest={snapshot.componentCatalog.manifest}
          catalogSourceProjectId={snapshot.source.projectId}
          catalogSourceRevisionId={snapshot.source.revision.id}
          {...(onBuildStoryPreview === undefined ? {} : { onBuildStoryPreview })}
          {...(canvasMode === 'design' && currentCatalogInsertTarget !== undefined
            ? { catalogInsertTarget: currentCatalogInsertTarget }
            : {})}
          {...(canvasMode === 'design' && currentCatalogReplaceTarget !== undefined
            ? { catalogReplaceTarget: currentCatalogReplaceTarget }
            : {})}
          onInsertCatalogComponent={insertDesignSystemComponent}
          onReplaceCatalogComponent={replaceDesignSystemComponent}
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
          onCanvasNavigationChange={onCanvasNavigationChange}
          canRequestAiTarget={canRequestAiTarget}
          {...(pendingAIProposal === undefined
            ? {}
            : {
                proposalReview: {
                  currentRevisionId: pendingAIProposal.baseRevisionId,
                  candidateRevisionId: pendingAIProposal.candidateRevisionId,
                  summary: pendingAIProposal.summary,
                  active: proposalPreviewActive ? ('proposal' as const) : ('current' as const),
                  switching: proposalPreviewSwitching,
                  onShowCurrent: showCurrentRevision,
                  onShowProposal: showProposalRevision
                }
              })}
          onOpenAi={openAiWorkspace}
          onOpenInspector={() => openInspectorWorkspace('inspect')}
          inspectorTriggerRef={inspectorDrawerTriggerRef}
          preview={
            <ArtboardPreview
              key={`${snapshot.source.projectId}:${canvasMode === 'design' ? (snapshot.editablePrototype.runtime?.activeNodeId ?? 'default') : 'present'}:${canvasPreviewBuild?.revisionId ?? 'unbuilt'}:${canvasPreviewBuild?.policy?.nonce ?? 'unfenced'}:${canvasPreviewBuild?.url ?? 'unpublished'}`}
              {...(canvasPreviewBuild === undefined ? {} : { build: canvasPreviewBuild })}
              frame={frame}
              onFrameLoad={onFrameLoad}
              onFrameError={onFrameError}
              pins={canvasMode === 'present' || proposalPreviewActive ? [] : activeArtifactPins}
              {...(canvasMode === 'present' || selectedArtifactPinId === undefined
                ? {}
                : { selectedPinId: selectedArtifactPinId })}
              onSelectPin={selectArtifactPin}
              {...(canvasMode === 'present' || proposalPreviewActive || selectedThread === undefined
                ? {}
                : { selectedThread })}
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
              threadIndex={Math.max(
                0,
                selectedThreadIndex(activeArtifactThreads, selectedThreadId)
              )}
              threadCount={activeArtifactThreads.length}
              onNavigateThread={navigateThread}
              onClearElementSelection={clearCanvasSelection}
              {...(canvasMode === 'design' &&
              previewDirectSelectionAuthorized &&
              currentPreviewTelemetry?.provenance === 'authenticated-preview-node'
                ? { selectedElement: currentPreviewTelemetry }
                : {})}
              onSelectedElementContextAction={actOnMappedElement}
              onCreateArtifactThread={createArtifactThread}
              onBeginSelectedElementTextEdit={beginSelectedElementTextEdit}
              onUpdateSelectedElementText={updateSelectedElementText}
              onResizeSelectedElement={resizeSelectedElement}
              onMoveSelectedElement={moveSelectedElement}
              onReorderSelectedElement={reorderSelectedElement}
              onUpdateSelectedElementLayout={updateSelectedElementLayout}
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
            aria-label={rightCollapsed ? 'Show inspector' : 'Hide inspector'}
            onClick={() => {
              const next = !rightCollapsed;
              setRightCollapsed(next);
              if (!next) setLeftCollapsed(true);
              persistPreferences({
                rightRailCollapsed: next,
                ...(next ? {} : { leftRailCollapsed: true })
              });
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
                  aiTarget={currentAiTarget}
                  aiBusy={aiBusy}
                  {...(selectedCanvasNodeId === undefined
                    ? {}
                    : { selectedGraphNodeId: selectedCanvasNodeId })}
                  {...((inspectorSelectionDismissed && currentPreviewTelemetry === undefined) ||
                  currentPreviewTelemetry?.provenance === 'authenticated-preview-unmapped'
                    ? { hideSnapshotSelection: true }
                    : {})}
                  {...(currentPreviewTelemetry === undefined
                    ? {}
                    : { selectedPreviewTelemetry: currentPreviewTelemetry })}
                  {...(selectedCanvasConnection
                    ? { prototypeConnection: selectedCanvasConnection }
                    : {})}
                  onSelectNode={(nodeId) => {
                    onPreviewSelectionClear();
                    setInspectorSelectionDismissed(false);
                    apply(actions.selectNode(nodeId));
                  }}
                  onArtifactApplied={async (next, status) => {
                    // The durable source is authoritative even when a later
                    // preview compilation or presentation step fails.
                    setManualEditStatus(status);
                    onSnapshot(next);
                    try {
                      await onRender(next);
                    } catch (error) {
                      setManualEditStatus(
                        'React artifact saved, but the compiled preview could not refresh.'
                      );
                      throw error;
                    }
                  }}
                  manualTextEditor={manualTextEditor}
                  onHandoff={handoffInspectorTarget}
                />
                {manualEditStatus ? (
                  <output
                    className="dev-inspector__edit-status"
                    role="status"
                    aria-label="Manual React edit status"
                  >
                    {manualEditStatus}
                  </output>
                ) : null}
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
