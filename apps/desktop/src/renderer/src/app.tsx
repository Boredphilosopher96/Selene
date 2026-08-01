import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { DesktopCockpit } from './cockpit/desktop-cockpit';
import { PreviewCanvasNavigation } from './cockpit/preview-canvas-navigation';
import { PreviewTargetCancel } from './cockpit/preview-target-cancel';
import { shouldClearPreviewTelemetry } from './cockpit/preview-telemetry-state';
import { ProjectLaunchpad } from './cockpit/project-launchpad';
import { WorkspaceToolbar } from './cockpit/workspace-toolbar';
import {
  previewInteractionFailureNotice,
  presentDesignerError,
  safeDesignerNotice,
  type PreviewInteractionFailure
} from './presentation-error';
import {
  isActivePreviewFrameEvent,
  PreviewPresentationCoordinator,
  PreviewRefreshError,
  retainCurrentSnapshotAfterPreviewRefresh,
  refreshPreviewRevision,
  type PreviewPresentationIdentity
} from './cockpit/preview-refresh';
import {
  PREVIEW_CANVAS_GESTURE_EVENT,
  PREVIEW_TARGET_CANCEL_EVENT,
  previewCanvasGesture,
  type PreviewCanvasNavigationMessage,
  type PreviewFrameMessage,
  type PreviewInspectNodeMessage,
  type PreviewTargetCancelMessage,
  type PreviewElementTelemetrySelection,
  type PreviewRuntimeState,
  validatePreviewFrameMessage
} from '../../shared/preview-channel';
import {
  assertDesignerApiVersion,
  defaultWorkspaceCockpitPreferences,
  type AIProposalDecisionInput,
  type DesignerProgress,
  type DesignerPublishConsentInput,
  type ProjectOpenResult,
  type DesignerSnapshot,
  type GeneratedCodePublishReceipt,
  type WorkspaceCockpitPreferences
} from '../../shared/designer-api';
import { DESKTOP_PRELOAD_API_VERSION } from '../../shared/desktop-api';

type BuildResult = Awaited<ReturnType<Window['selene']['preview']['buildAIProposal']>>;

function download(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportPreviewInteractionFailure(operation: PreviewInteractionFailure): void {
  // The renderer records only a bounded category. Detailed host diagnostics
  // remain behind the trusted host boundary and never enter designer state.
  // oxlint-disable-next-line no-console
  console.warn(`[Selene preview] ${operation} failed.`);
}

function validBuild(value: unknown): value is BuildResult {
  if (
    !record(value) ||
    !record(value.policy) ||
    typeof value.url !== 'string' ||
    typeof value.revisionId !== 'string'
  )
    return false;
  const policy = value.policy;
  if (
    policy.origin !== 'selene-preview://local' ||
    typeof policy.nonce !== 'string' ||
    typeof policy.maxMessageBytes !== 'number' ||
    typeof policy.csp !== 'string'
  )
    return false;
  try {
    const url = new URL(value.url);
    return (
      url.protocol === 'selene-preview:' &&
      url.hostname === 'local' &&
      /^\/[A-Za-z0-9_-]{1,128}\/index\.html$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validCanonicalBuild(
  value: unknown,
  ticket: NonNullable<DesignerSnapshot['editablePrototype']['previewTicket']>
): value is Awaited<ReturnType<Window['selene']['preview']['build']>> {
  if (!validBuild(value) || !record(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    value.revisionId === ticket.sourceRevisionId &&
    identity.projectId === ticket.projectId &&
    identity.sourceRevisionId === ticket.sourceRevisionId &&
    identity.graphRevision === ticket.graphRevision &&
    identity.bindingId === ticket.bindingId
  );
}

function previewIdentity(build: BuildResult): PreviewPresentationIdentity {
  return {
    revisionId: build.revisionId,
    nonce: build.policy.nonce,
    url: build.url
  };
}

function runtimeState(snapshot: DesignerSnapshot): PreviewRuntimeState | undefined {
  const runtime = snapshot.editablePrototype.runtime;
  return runtime
    ? {
        activeNodeId: runtime.activeNodeId,
        ...(runtime.activeStateId ? { activeStateId: runtime.activeStateId } : {}),
        ...(runtime.activeOverlayId ? { activeOverlayId: runtime.activeOverlayId } : {}),
        activePathTransitionIds: runtime.activePathTransitionIds.slice(0, 256)
      }
    : undefined;
}

function initialRuntimeState(snapshot: DesignerSnapshot): PreviewRuntimeState {
  return (
    runtimeState(snapshot) ?? {
      activeNodeId: snapshot.editablePrototype.graph.initialNodeId,
      activePathTransitionIds: []
    }
  );
}

function postCanvasNavigation(port: MessagePort, build: BuildResult, enabled: boolean): void {
  const message: PreviewCanvasNavigationMessage = {
    type: 'canvas-navigation',
    nonce: build.policy.nonce,
    origin: build.policy.origin,
    revisionId: build.revisionId,
    enabled
  };
  port.postMessage(message);
}

function postPreviewTargetCancel(port: MessagePort, build: BuildResult, enabled: boolean): void {
  const message: PreviewTargetCancelMessage = {
    type: 'target-cancel',
    nonce: build.policy.nonce,
    origin: build.policy.origin,
    revisionId: build.revisionId,
    enabled
  };
  port.postMessage(message);
}

function postPreviewInspect(port: MessagePort, build: BuildResult, nodeId: string): void {
  const message: PreviewInspectNodeMessage = {
    type: 'inspect-node',
    nonce: build.policy.nonce,
    origin: build.policy.origin,
    revisionId: build.revisionId,
    nodeId
  };
  port.postMessage(message);
}

/** Electron orchestration only: all product visuals live in DesktopCockpit. */
export function App() {
  const [snapshot, setSnapshot] = useState<DesignerSnapshot>();
  const [build, setBuild] = useState<BuildResult>();
  // Channel state is evidence, not product state. Updating it must never
  // reconcile the live iframe or retire its MessagePort during a gesture.
  const previewChannelState = useRef<'unavailable' | 'connecting' | 'port' | 'fallback'>(
    'unavailable'
  );
  const [selectedPreviewTelemetry, setSelectedPreviewTelemetry] =
    useState<PreviewElementTelemetrySelection>();
  /** Render fence: direct-manipulation chrome requires a completed physical selection. */
  const [previewDirectSelectionAuthorized, setPreviewDirectSelectionAuthorized] = useState(false);
  /** Signals the cockpit to discard renderer-owned AI targets with an authoritative selection clear. */
  const [previewSelectionClearEpoch, setPreviewSelectionClearEpoch] = useState(0);
  const [notice, setNotice] = useState('Loading desktop designer…');
  const [sessionResolution, setSessionResolution] = useState<'resolving' | 'resolved'>('resolving');
  const [progress, setProgress] = useState<DesignerProgress>();
  const [publishStatus, setPublishStatus] = useState('No publish operation started.');
  const [publishId, setPublishId] = useState<string>();
  const [publishActive, setPublishActive] = useState(false);
  const [publishStarting, setPublishStarting] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [completedRemotePublication, setCompletedRemotePublication] = useState<{
    readonly publishId: string;
    readonly receipt: Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }>;
  }>();
  const [cockpitPreferences, setCockpitPreferences] = useState<WorkspaceCockpitPreferences>(
    defaultWorkspaceCockpitPreferences
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const workspaceRoot = useRef<HTMLElement>(null);
  const previewSelectionStage = useRef<
    'idle' | 'accepted-message' | 'host-confirmed' | 'authorized' | 'cleared' | 'host-failed'
  >('idle');
  const currentSnapshot = useRef<DesignerSnapshot | undefined>(undefined);
  const framePort = useRef<MessagePort | null>(null);
  const currentBuild = useRef<BuildResult | undefined>(undefined);
  const canonicalPreviewBuild = useRef<BuildResult | undefined>(undefined);
  const stagedProposalBuild = useRef<BuildResult | undefined>(undefined);
  const previewCanvasNavigation = useRef<PreviewCanvasNavigation | undefined>(undefined);
  const previewTargetCancel = useRef<PreviewTargetCancel | undefined>(undefined);
  const activePreviewIdentity = useRef<PreviewPresentationIdentity | undefined>(undefined);
  /** Invalidates pending authenticated selection resolutions across clears and frame changes. */
  const previewSelectionEpoch = useRef(0);
  /** Deduplicates the port and window copies of each preview selection gesture. */
  const previewSelectionInteractionSequence = useRef(0);
  /**
   * The host owns durable selection, so preview-originated mutations must reach
   * it in order. In particular, an unsupported hit must clear after any mapped
   * selection already in flight instead of merely ignoring its stale response.
   */
  const previewSelectionHostQueue = useRef<Promise<void>>(Promise.resolve());
  const enqueuePreviewSelectionHostOperation = useCallback(
    (operation: () => Promise<DesignerSnapshot>): Promise<DesignerSnapshot> => {
      const result = previewSelectionHostQueue.current.then(operation, operation);
      previewSelectionHostQueue.current = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    []
  );
  /** A canvas clear must not replay the host's retained node into a new preview frame. */
  const previewSelectionSuppressed = useRef(false);
  /** Serializes duplicate transport delivery without dropping a later clear gesture. */
  const previewSelectionClearInFlight = useRef<Promise<void> | undefined>(undefined);
  const previewSelectionClearTrailing = useRef(false);
  const previewSelectionClearLatestRequestId = useRef(0);
  currentBuild.current = build;
  if (!previewCanvasNavigation.current)
    previewCanvasNavigation.current = new PreviewCanvasNavigation((enabled) => {
      const activeBuild = currentBuild.current;
      const port = framePort.current;
      if (activeBuild && port) postCanvasNavigation(port, activeBuild, enabled);
    });
  if (!previewTargetCancel.current)
    previewTargetCancel.current = new PreviewTargetCancel((enabled) => {
      const activeBuild = currentBuild.current;
      const port = framePort.current;
      if (activeBuild && port) postPreviewTargetCancel(port, activeBuild, enabled);
    });
  const activePreviewRefresh = useRef<AbortController | undefined>(undefined);
  const setPreviewChannelDiagnostic = useCallback(
    (state: 'unavailable' | 'connecting' | 'port' | 'fallback') => {
      previewChannelState.current = state;
      workspaceRoot.current?.setAttribute('data-selene-preview-channel', state);
    },
    []
  );
  const setPreviewSelectionStage = useCallback((stage: typeof previewSelectionStage.current) => {
    previewSelectionStage.current = stage;
    workspaceRoot.current?.setAttribute('data-selene-preview-selection-stage', stage);
  }, []);
  const publishPreviewBuild = useCallback(
    (nextBuild: BuildResult) => {
      framePort.current?.close();
      framePort.current = null;
      previewCanvasNavigation.current?.previewUnavailable();
      previewTargetCancel.current?.previewUnavailable();
      activePreviewIdentity.current = previewIdentity(nextBuild);
      previewSelectionInteractionSequence.current = 0;
      setPreviewChannelDiagnostic('unavailable');
      setPreviewSelectionStage('idle');
      setSelectedPreviewTelemetry(undefined);
      setBuild(nextBuild);
    },
    [setPreviewChannelDiagnostic, setPreviewSelectionStage]
  );
  const acceptPreviewSelectionInteraction = useCallback((message: PreviewFrameMessage): boolean => {
    if (message.type !== 'select-node' && message.type !== 'clear-selection') return true;
    if (message.interactionSequence <= previewSelectionInteractionSequence.current) return false;
    previewSelectionInteractionSequence.current = message.interactionSequence;
    return true;
  }, []);
  useLayoutEffect(() => {
    previewSelectionEpoch.current += 1;
    previewSelectionSuppressed.current = false;
    setPreviewSelectionStage('idle');
    setSelectedPreviewTelemetry(undefined);
    setPreviewDirectSelectionAuthorized(false);
  }, [setPreviewSelectionStage, snapshot?.source.projectId]);
  useEffect(() => {
    if (
      shouldClearPreviewTelemetry(snapshot?.selectedNodeId, currentSnapshot.current?.selectedNodeId)
    )
      setSelectedPreviewTelemetry(undefined);
  }, [snapshot?.selectedNodeId]);
  const previewPresentation = useMemo(
    () =>
      new PreviewPresentationCoordinator<BuildResult>(publishPreviewBuild, previewIdentity, {
        schedule: (task, delayMs) => window.setTimeout(task, delayMs),
        cancel: (handle) => window.clearTimeout(handle as number)
      }),
    [publishPreviewBuild]
  );
  const graphSaveTail = useRef<Promise<void>>(Promise.resolve());
  const committedCockpitPreferences = useRef<WorkspaceCockpitPreferences>(
    defaultWorkspaceCockpitPreferences
  );
  const desiredCockpitPreferences = useRef<WorkspaceCockpitPreferences>(
    defaultWorkspaceCockpitPreferences
  );
  const cockpitPreferenceFlushActive = useRef(false);
  /** This survives transient popover unmounts while trusted native consent is pending. */
  const publishStartInFlight = useRef(false);
  const publishGeneration = useRef(0);
  const publishActiveRef = useRef(publishActive);
  const publishStartingRef = useRef(publishStarting);
  publishActiveRef.current = publishActive;
  publishStartingRef.current = publishStarting;
  /** Project selection and publish consent are mutually exclusive host transitions. */
  const projectSwitchInFlight = useRef(false);
  const deliveryActionInFlight = useRef(false);
  currentSnapshot.current = snapshot;
  const compile = useCallback(
    async (next: DesignerSnapshot, signal?: AbortSignal): Promise<BuildResult> => {
      if (signal?.aborted)
        throw new PreviewRefreshError(
          'refresh-aborted',
          next.source.revision.id,
          'The refresh was cancelled before compilation'
        );
      const ticket = next.editablePrototype.previewTicket;
      if (ticket === undefined)
        throw new Error('The host has not issued a current React preview identity.');
      const result = await window.selene.preview.build(ticket);
      if (signal?.aborted)
        throw new PreviewRefreshError(
          'refresh-aborted',
          next.source.revision.id,
          'The refresh was cancelled during compilation'
        );
      if (!validCanonicalBuild(result, ticket))
        throw new Error('Preview host returned an invalid preview build');
      return result;
    },
    []
  );
  const render = useCallback(
    async (
      next: DesignerSnapshot,
      intent: 'authoring' | 'presentation' = 'authoring'
    ): Promise<void> => {
      activePreviewRefresh.current?.abort();
      // A replacement iframe can load before React commits the corresponding
      // snapshot. Seed the same host-confirmed state that requested this
      // render so MessageChannel initialization never replays a prior scenario.
      currentSnapshot.current = next;
      setSelectedPreviewTelemetry(undefined);
      const controller = new AbortController();
      activePreviewRefresh.current = controller;
      try {
        const refreshed = await refreshPreviewRevision({
          snapshot: next,
          compile,
          present: (nextBuild, signal) => previewPresentation.present(nextBuild, signal),
          selection:
            intent === 'presentation'
              ? { intent: 'presentation' as const }
              : {
                  intent: 'authoring' as const,
                  retarget: async (accepted: DesignerSnapshot, revisionId: string) => {
                    const selectedNodeId = accepted.selectedNodeId;
                    if (!selectedNodeId) return accepted;
                    const retargeted = await enqueuePreviewSelectionHostOperation(() =>
                      window.selene.designer.selectNode(selectedNodeId)
                    );
                    if (retargeted.source.revision.id !== revisionId)
                      throw new Error(`Host selection belongs to ${retargeted.source.revision.id}`);
                    return retargeted;
                  }
                },
          signal: controller.signal
        });
        canonicalPreviewBuild.current = refreshed.build;
        setSnapshot((current) =>
          retainCurrentSnapshotAfterPreviewRefresh(current, refreshed.snapshot)
        );
        setNotice('Preview updated.');
      } finally {
        if (activePreviewRefresh.current === controller) activePreviewRefresh.current = undefined;
      }
    },
    [compile, previewPresentation]
  );
  const previewAIProposal = useCallback(
    async (input: AIProposalDecisionInput): Promise<void> => {
      activePreviewRefresh.current?.abort();
      setSelectedPreviewTelemetry(undefined);
      const visible = currentBuild.current;
      const current = currentSnapshot.current;
      if (visible?.revisionId === current?.source.revision.id)
        canonicalPreviewBuild.current = visible;
      const cached = stagedProposalBuild.current;
      const result =
        cached?.revisionId === input.candidateRevisionId
          ? cached
          : await window.selene.preview.buildAIProposal(input);
      if (!validBuild(result)) throw new Error('Preview host returned an invalid proposal build');
      stagedProposalBuild.current = result;
      await previewPresentation.present(result);
      setNotice(`Previewing AI proposal ${result.revisionId}.`);
    },
    [previewPresentation]
  );
  const previewCurrentRevision = useCallback(async (): Promise<void> => {
    const current = currentSnapshot.current;
    if (current === undefined) throw new Error('Current design snapshot is unavailable');
    activePreviewRefresh.current?.abort();
    setSelectedPreviewTelemetry(undefined);
    const cached = canonicalPreviewBuild.current;
    if (cached?.revisionId === current.source.revision.id) {
      await previewPresentation.present(cached);
      setNotice(`Viewing current design ${cached.revisionId}.`);
      return;
    }
    await render(current);
  }, [previewPresentation, render]);
  const setDeliveryBusy = useCallback((busy: boolean) => {
    deliveryActionInFlight.current = busy;
  }, []);
  const setProjectSwitchBusy = useCallback((busy: boolean) => {
    projectSwitchInFlight.current = busy;
    setProjectSwitching(busy);
  }, []);
  const openProject = useCallback(
    async (opened: ProjectOpenResult) => {
      try {
        if (publishStartInFlight.current || publishActiveRef.current)
          throw new Error(
            'Finish or cancel the active publish operation before switching projects.'
          );
        assertDesignerApiVersion(opened.snapshot.apiVersion);
        setNotice(`Opening ${opened.receipt.name}…`);
        publishGeneration.current += 1;
        canonicalPreviewBuild.current = undefined;
        stagedProposalBuild.current = undefined;
        setPublishId(undefined);
        setCompletedRemotePublication(undefined);
        setPublishStatus('No publish operation started for this project.');
        setSelectedPreviewTelemetry(undefined);
        activePreviewRefresh.current?.abort();
        activePreviewRefresh.current = undefined;
        previewPresentation.close();
        // The next frame must initialize from this exact host snapshot, even
        // when React has not committed the project switch yet.
        currentSnapshot.current = opened.snapshot;
        const nextBuild = await compile(opened.snapshot);
        setSnapshot(opened.snapshot);
        publishPreviewBuild(nextBuild);
        setNotice(`${opened.receipt.name} is ready.`);
      } catch (error) {
        setNotice(presentDesignerError(error, 'preview'));
        throw error;
      } finally {
        setProjectSwitchBusy(false);
      }
    },
    [compile, previewPresentation, publishPreviewBuild, setProjectSwitchBusy]
  );

  useEffect(() => {
    let disposed = false;
    try {
      if (window.selene.apiVersion !== DESKTOP_PRELOAD_API_VERSION)
        throw new Error(`Unsupported desktop preload API version: ${window.selene.apiVersion}`);
      assertDesignerApiVersion(window.selene.designer.apiVersion);
    } catch (error) {
      setNotice(presentDesignerError(error, 'workspace'));
      setSessionResolution('resolved');
      return;
    }
    void window.selene.workspace
      .resumeActiveProject()
      .then(async (opened) => {
        if (disposed) return;
        if (opened === undefined) {
          setNotice('Choose a local project or create a new design workspace.');
          return;
        }
        await openProject(opened);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setNotice(presentDesignerError(error, 'workspace'));
      })
      .finally(() => {
        if (!disposed) setSessionResolution('resolved');
      });
    void window.selene.designer
      .workspaceCockpitPreferences()
      .then((next) => {
        committedCockpitPreferences.current = next;
        desiredCockpitPreferences.current = next;
        setCockpitPreferences(next);
      })
      .catch((error: unknown) => setNotice(presentDesignerError(error, 'workspace')));
    const unsubscribeProgress = window.selene.designer.onProgress((event) => setProgress(event));
    return () => {
      disposed = true;
      unsubscribeProgress();
    };
  }, [openProject]);

  useEffect(() => {
    if (!publishId) return;
    const generation = publishGeneration.current;
    const timer = window.setInterval(
      () =>
        void window.selene.designer
          .generatedCodePublishOperation(publishId)
          .then((operation) => {
            if (publishGeneration.current !== generation) return;
            setPublishStatus(
              operation.receipt
                ? operation.receipt.mode === 'github-remote'
                  ? `Published ${operation.receipt.repository} at ${operation.receipt.commitSha}; stakeholder collaboration is ${operation.receipt.hostedReview.collaboration.status}.`
                  : `${operation.receipt.mode}: ${operation.receipt.status} (${operation.receipt.immutableId})`
                : operation.error
                  ? presentDesignerError(operation.error, 'publish')
                  : 'Publishing changes…'
            );
            if (operation.receipt?.mode === 'github-remote')
              setCompletedRemotePublication({ publishId, receipt: operation.receipt });
            if (operation.status !== 'running') {
              setPublishActive(false);
              window.clearInterval(timer);
            }
          })
          .catch((error: unknown) => {
            if (publishGeneration.current !== generation) return;
            setPublishActive(false);
            setPublishStatus(presentDesignerError(error, 'publish'));
            window.clearInterval(timer);
          }),
      350
    );
    return () => window.clearInterval(timer);
  }, [publishId]);

  const startPublish = useCallback(
    async (request: DesignerPublishConsentInput): Promise<void> => {
      if (projectSwitchInFlight.current || deliveryActionInFlight.current)
        throw new Error(
          'Finish the active project or design-delivery operation before starting a publish.'
        );
      if (publishStartInFlight.current || publishActive)
        throw new Error('A publish start is already active.');
      publishStartInFlight.current = true;
      publishGeneration.current += 1;
      setPublishStarting(true);
      setPublishId(undefined);
      setCompletedRemotePublication(undefined);
      setPublishStatus('Requesting host consent for the selected immutable publish target…');
      try {
        const consent = await window.selene.designer.requestGeneratedCodePublishConsent(request);
        const operation = await window.selene.designer.publishGeneratedCode({
          ...request,
          consentId: consent.consentId
        });
        setPublishId(operation.id);
        setPublishActive(true);
        setPublishStatus(
          request.mode === 'github-remote'
            ? 'Remote host operation started; waiting for its immutable receipt.'
            : 'Local immutable bundle validation started; no files will be retained.'
        );
      } catch (error) {
        setPublishStatus(presentDesignerError(error, 'publish'));
        throw error;
      } finally {
        publishStartInFlight.current = false;
        setPublishStarting(false);
      }
    },
    [publishActive]
  );
  const cancelPublish = useCallback(async (): Promise<void> => {
    if (publishStartInFlight.current)
      throw new Error(
        'Trusted host consent is pending; no publish operation can be cancelled yet.'
      );
    if (!publishActive || publishId === undefined) return;
    await window.selene.designer.cancelGeneratedCodePublish(publishId);
    setPublishStatus('Cancelling host publish operation…');
  }, [publishActive, publishId]);

  useEffect(
    () => () => {
      framePort.current?.close();
      framePort.current = null;
    },
    [build?.revisionId, build?.policy.nonce, build?.url]
  );

  useEffect(
    () => () => {
      activePreviewRefresh.current?.abort();
      activePreviewRefresh.current = undefined;
      activePreviewIdentity.current = undefined;
      previewPresentation.close();
    },
    [previewPresentation]
  );

  useEffect(() => {
    const state = snapshot && build && framePort.current ? runtimeState(snapshot) : undefined;
    if (state && build && framePort.current)
      framePort.current.postMessage({
        type: 'runtime-state',
        nonce: build.policy.nonce,
        origin: build.policy.origin,
        revisionId: build.revisionId,
        state
      });
  }, [build, snapshot]);

  useEffect(() => {
    if (
      !previewSelectionSuppressed.current &&
      snapshot?.selectedNodeId &&
      snapshot.source.revision.id === build?.revisionId &&
      build &&
      framePort.current
    )
      postPreviewInspect(framePort.current, build, snapshot.selectedNodeId);
  }, [
    build?.policy.nonce,
    build?.policy.origin,
    build?.revisionId,
    snapshot?.selectedNodeId,
    snapshot?.source.revision.id
  ]);

  const updateCanvasNavigation = useCallback((enabled: boolean) => {
    previewCanvasNavigation.current?.setEnabled(enabled);
    workspaceRoot.current?.setAttribute(
      'data-selene-preview-navigation',
      enabled ? 'design' : 'prototype'
    );
  }, []);
  const updatePreviewTargetCancel = useCallback((enabled: boolean) => {
    previewTargetCancel.current?.setEnabled(enabled);
  }, []);
  const clearPreviewSelection = useCallback(() => {
    setPreviewSelectionStage('cleared');
    const requestId = ++previewSelectionEpoch.current;
    previewSelectionClearLatestRequestId.current = requestId;
    previewSelectionSuppressed.current = true;
    // Do not leave a prior host selection visible while the authoritative IPC
    // clear is in flight. The host response below remains the durable source
    // of truth, but unsupported preview inspection can never retain a usable
    // renderer target during that round trip.
    const snapshotAtClear = currentSnapshot.current;
    if (snapshotAtClear?.selectedNodeId !== undefined) {
      const { selectedNodeId: _selectedNodeId, ...withoutSelectedNode } = snapshotAtClear;
      currentSnapshot.current = withoutSelectedNode;
    }
    setSnapshot((latest) => {
      if (latest?.selectedNodeId === undefined) return latest;
      const { selectedNodeId: _selectedNodeId, ...withoutSelectedNode } = latest;
      return withoutSelectedNode;
    });
    setSelectedPreviewTelemetry(undefined);
    setPreviewDirectSelectionAuthorized(false);
    setPreviewSelectionClearEpoch((current) => current + 1);
    if (previewSelectionClearInFlight.current) {
      previewSelectionClearTrailing.current = true;
      return;
    }
    const clearHostSelection = (clearRequestId: number): void => {
      const clearOperation = enqueuePreviewSelectionHostOperation(() =>
        window.selene.designer.clearSelectedNode()
      )
        .then((next) => {
          if (clearRequestId !== previewSelectionEpoch.current) return;
          setSnapshot(next);
        })
        .catch(() => {
          if (clearRequestId !== previewSelectionEpoch.current) return;
          setNotice(
            'The host could not clear the prior selection. Try selecting a mapped element again.'
          );
        });
      previewSelectionClearInFlight.current = clearOperation;
      void clearOperation.finally(() => {
        if (previewSelectionClearInFlight.current !== clearOperation) return;
        if (previewSelectionClearTrailing.current) {
          previewSelectionClearTrailing.current = false;
          clearHostSelection(previewSelectionClearLatestRequestId.current);
          return;
        }
        previewSelectionClearInFlight.current = undefined;
      });
    };
    clearHostSelection(requestId);
  }, [enqueuePreviewSelectionHostOperation, setPreviewSelectionStage]);

  useEffect(() => {
    const clearFromActiveFrame = (event: MessageEvent<unknown>) => {
      const activeBuild = currentBuild.current;
      const activeFrame = frame.current;
      if (!activeBuild || !activeFrame?.contentWindow || event.source !== activeFrame.contentWindow)
        return;
      const message = validatePreviewFrameMessage(event.data, {
        ...activeBuild.policy,
        revisionId: activeBuild.revisionId
      });
      if (!message) return;
      if (!acceptPreviewSelectionInteraction(message)) return;
      setPreviewChannelDiagnostic('fallback');
      if (message.type === 'select-node') {
        setPreviewSelectionStage('accepted-message');
        previewSelectionSuppressed.current = false;
        setSelectedPreviewTelemetry(undefined);
        setPreviewDirectSelectionAuthorized(false);
        const requestId = ++previewSelectionEpoch.current;
        const { nodeId, telemetry, revisionId } = message;
        window.selene.preview.postMessage(activeBuild.policy, message);
        void enqueuePreviewSelectionHostOperation(() => window.selene.designer.selectNode(nodeId))
          .then((next) => {
            if (
              requestId !== previewSelectionEpoch.current ||
              frame.current?.contentWindow !== event.source ||
              currentBuild.current?.revisionId !== revisionId
            )
              return;
            setSnapshot(next);
            if (next.selectedNodeId !== nodeId || next.source.revision.id !== revisionId) {
              setPreviewSelectionStage('host-failed');
              return;
            }
            setPreviewSelectionStage('host-confirmed');
            setSelectedPreviewTelemetry({
              provenance: 'authenticated-preview-node',
              nodeId,
              revisionId,
              values: telemetry
            });
            setPreviewDirectSelectionAuthorized(true);
            setPreviewSelectionStage('authorized');
          })
          .catch(() => {
            if (requestId !== previewSelectionEpoch.current) return;
            setPreviewSelectionStage('host-failed');
            reportPreviewInteractionFailure('select-node');
            setNotice(previewInteractionFailureNotice('select-node'));
          });
        return;
      }
      if (message.type !== 'clear-selection' && message.type !== 'inspect-element') return;
      // Both the sequenced clear envelope and its read-only inspection
      // diagnostic revoke selection. The clear queue makes duplicate port and
      // window delivery idempotent while preserving a trailing real gesture.
      clearPreviewSelection();
    };
    window.addEventListener('message', clearFromActiveFrame);
    return () => window.removeEventListener('message', clearFromActiveFrame);
  }, [
    acceptPreviewSelectionInteraction,
    clearPreviewSelection,
    enqueuePreviewSelectionHostOperation,
    setPreviewChannelDiagnostic,
    setPreviewSelectionStage
  ]);

  const workspaceActions = useMemo(
    () => ({
      render: async () => {
        if (!snapshot) throw new Error('The local workspace is still loading.');
        await render(snapshot);
      },
      markReadyForReview: window.selene.designer.markReadyForReview,
      markReadyForHandoff: window.selene.designer.markReadyForHandoff,
      exportHandoff: window.selene.designer.exportHandoff,
      exportProductHandoff: window.selene.designer.exportProductHandoff,
      configureProductShell: window.selene.designer.configureProductShell,
      diagnostics: window.selene.diagnostics
    }),
    [render, snapshot]
  );

  function connectPreviewFrame(loadedFrame: HTMLIFrameElement): void {
    const current = currentSnapshot.current;
    if (!build || !current || frame.current !== loadedFrame || !loadedFrame.contentWindow) return;
    const identity = previewIdentity(build);
    setPreviewChannelDiagnostic('connecting');
    setPreviewSelectionStage('idle');
    framePort.current?.close();
    previewSelectionInteractionSequence.current = 0;
    const channel = new MessageChannel();
    const channelIsActive = () =>
      isActivePreviewFrameEvent({
        activeIdentity: activePreviewIdentity.current,
        eventIdentity: identity,
        channelIsActive: framePort.current === channel.port1
      });
    previewSelectionEpoch.current += 1;
    channel.port1.onmessage = (event) => {
      if (!channelIsActive()) return;
      const message = validatePreviewFrameMessage(event.data, {
        ...build.policy,
        revisionId: build.revisionId
      });
      if (!message) return;
      if (!acceptPreviewSelectionInteraction(message)) return;
      setPreviewChannelDiagnostic('port');
      if (message.type === 'canvas-gesture') {
        const gesture = previewCanvasGesture({
          gesture: message.gesture,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          x: message.x,
          y: message.y
        });
        if (gesture)
          window.dispatchEvent(new CustomEvent(PREVIEW_CANVAS_GESTURE_EVENT, { detail: gesture }));
        return;
      }
      if (message.type === 'target-cancel') {
        window.dispatchEvent(new CustomEvent(PREVIEW_TARGET_CANCEL_EVENT));
        return;
      }
      if (message.type === 'runtime-error') {
        setSelectedPreviewTelemetry(undefined);
        const reason = message.message ?? 'The preview reported an unknown runtime error';
        if (!previewPresentation.failed(identity, 'iframe-runtime-failed', reason)) return;
        window.selene.preview.postMessage(build.policy, message);
        setNotice(
          presentDesignerError(
            new PreviewRefreshError('iframe-runtime-failed', build.revisionId, reason),
            'preview'
          )
        );
        return;
      }
      if (message.type === 'inspect-element') {
        // A diagnostic-only unsupported hit is still a fail-closed selection
        // revocation. Sequence fencing rejects any delayed mapped select.
        clearPreviewSelection();
        return;
      }
      if (message.type === 'clear-selection') {
        // This is the authoritative fail-closed revocation path.
        clearPreviewSelection();
        return;
      }
      if (message.type === 'inspect-node-result') {
        const currentSelection = currentSnapshot.current;
        if (
          previewSelectionSuppressed.current ||
          !currentSelection ||
          currentSelection.selectedNodeId !== message.nodeId ||
          currentSelection.source.revision.id !== message.revisionId
        )
          return;
        setSelectedPreviewTelemetry({
          provenance: 'authenticated-preview-node',
          nodeId: message.nodeId,
          revisionId: message.revisionId,
          values: message.telemetry
        });
        return;
      }
      window.selene.preview.postMessage(build.policy, message);
      if (message.type === 'select-node') {
        setPreviewSelectionStage('accepted-message');
        previewSelectionSuppressed.current = false;
        // Frame telemetry is untrusted until the host confirms the same durable
        // node and source revision. Do not pair it with an older selection
        // while that host round trip is pending.
        setSelectedPreviewTelemetry(undefined);
        setPreviewDirectSelectionAuthorized(false);
        const requestId = ++previewSelectionEpoch.current;
        const { nodeId, telemetry, revisionId } = message;
        void enqueuePreviewSelectionHostOperation(() => window.selene.designer.selectNode(nodeId))
          .then((next) => {
            if (!channelIsActive() || requestId !== previewSelectionEpoch.current) return;
            setSnapshot(next);
            if (next.selectedNodeId !== nodeId || next.source.revision.id !== revisionId) {
              setPreviewSelectionStage('host-failed');
              return;
            }
            setPreviewSelectionStage('host-confirmed');
            setSelectedPreviewTelemetry({
              provenance: 'authenticated-preview-node',
              nodeId,
              revisionId,
              values: telemetry
            });
            setPreviewDirectSelectionAuthorized(true);
            setPreviewSelectionStage('authorized');
          })
          .catch(() => {
            if (!channelIsActive() || requestId !== previewSelectionEpoch.current) return;
            setSelectedPreviewTelemetry(undefined);
            setPreviewSelectionStage('host-failed');
            reportPreviewInteractionFailure('select-node');
            setNotice(previewInteractionFailureNotice('select-node'));
          });
      }
      if (
        message.type === 'trigger-action' &&
        message.nodeId &&
        message.portId &&
        currentSnapshot.current &&
        runtimeState(currentSnapshot.current)
      )
        void window.selene.designer
          .runPrototypeAction({ nodeId: message.nodeId, portId: message.portId })
          .then((next) => {
            if (!channelIsActive()) return;
            currentSnapshot.current = next;
            const state = runtimeState(next);
            // Deliver the authoritative transition to the exact live frame
            // before reconciliation can replace it. This preserves a native
            // React click and makes back-to-back prototype actions reliable.
            if (state && framePort.current === channel.port1)
              channel.port1.postMessage({
                type: 'runtime-state',
                nonce: build.policy.nonce,
                origin: build.policy.origin,
                revisionId: build.revisionId,
                state
              });
            setSnapshot(next);
          })
          .catch(() => {
            if (!channelIsActive()) return;
            reportPreviewInteractionFailure('trigger-action');
            setNotice(previewInteractionFailureNotice('trigger-action'));
          });
      if (message.type === 'ready') {
        previewPresentation.ready(identity);
        if (framePort.current === channel.port1)
          previewCanvasNavigation.current?.previewAvailable();
        if (framePort.current === channel.port1) previewTargetCancel.current?.previewAvailable();
        const state = currentSnapshot.current ? runtimeState(currentSnapshot.current) : undefined;
        if (state && framePort.current === channel.port1)
          channel.port1.postMessage({
            type: 'runtime-state',
            nonce: build.policy.nonce,
            origin: build.policy.origin,
            revisionId: build.revisionId,
            state
          });
        const selectedNodeId = currentSnapshot.current?.selectedNodeId;
        if (
          !previewSelectionSuppressed.current &&
          selectedNodeId &&
          currentSnapshot.current?.source.revision.id === build.revisionId &&
          framePort.current === channel.port1
        )
          postPreviewInspect(channel.port1, build, selectedNodeId);
      }
      if (message.type === 'rendered') previewPresentation.rendered(identity);
    };
    channel.port1.start();
    framePort.current = channel.port1;
    loadedFrame.contentWindow.postMessage(
      {
        type: 'selene-preview-init',
        nonce: build.policy.nonce,
        revisionId: build.revisionId,
        enabled: previewCanvasNavigation.current?.current() ?? true,
        state: initialRuntimeState(current)
      },
      build.policy.origin,
      [channel.port2]
    );
  }

  function handlePreviewFrameError(failedFrame: HTMLIFrameElement): void {
    if (!build || frame.current !== failedFrame) return;
    setSelectedPreviewTelemetry(undefined);
    framePort.current?.close();
    framePort.current = null;
    setPreviewChannelDiagnostic('unavailable');
    previewCanvasNavigation.current?.previewUnavailable();
    previewTargetCancel.current?.previewUnavailable();
    previewPresentation.failed(
      previewIdentity(build),
      'iframe-load-failed',
      'The sandboxed preview frame could not load'
    );
  }

  const projectLaunchpadActions = useMemo(() => {
    const beginProjectSwitch = <Result,>(work: () => Promise<Result>): Promise<Result> => {
      if (
        projectSwitchInFlight.current ||
        publishStartInFlight.current ||
        deliveryActionInFlight.current ||
        publishActiveRef.current ||
        publishStartingRef.current
      )
        return Promise.reject(
          new Error('Finish or cancel the active publish operation before switching projects.')
        );
      setProjectSwitchBusy(true);
      return work().then(
        (result) => {
          if (result === undefined) setProjectSwitchBusy(false);
          return result;
        },
        (error: unknown) => {
          setProjectSwitchBusy(false);
          throw error;
        }
      );
    };
    return {
      listRecentProjects: window.selene.designer.listRecentProjects,
      openProject: (request: { readonly projectId: string }) =>
        beginProjectSwitch(() => window.selene.designer.openProject(request)),
      createProject: (request: {
        readonly id: string;
        readonly name: string;
        readonly template: 'blank' | 'dashboard' | 'review';
      }) => beginProjectSwitch(() => window.selene.designer.createProject(request)),
      chooseProjectToImport: () =>
        beginProjectSwitch(() => window.selene.designer.chooseProjectToImport()),
      diagnostics: {
        recovery: window.selene.diagnostics.recovery,
        resetRecovery: window.selene.diagnostics.resetRecovery
      }
    };
  }, [setProjectSwitchBusy]);

  if (!snapshot && sessionResolution === 'resolving')
    return (
      <main
        aria-busy="true"
        aria-labelledby="workspace-startup-title"
        className="renderer-recovery"
      >
        <section className="renderer-recovery__card">
          <span className="renderer-recovery__mark" aria-hidden="true">
            S
          </span>
          <p className="renderer-recovery__eyebrow">Selene desktop designer</p>
          <h1 id="workspace-startup-title">Restoring your workspace</h1>
          <p role="status">{notice}</p>
        </section>
      </main>
    );
  if (!snapshot)
    return (
      <main
        aria-label="Selene project launchpad"
        className="designer-workspace project-launchpad-shell sl-theme"
      >
        <ProjectLaunchpad
          actions={projectLaunchpadActions}
          mode="first-run"
          onProjectOpened={openProject}
          startupMessage={notice}
        />
      </main>
    );
  const savePrototypeGraph = (graph: DesignerSnapshot['editablePrototype']['graph']) => {
    const queued = graphSaveTail.current
      .catch(() => undefined)
      .then(() => window.selene.designer.savePrototypeGraph(graph));
    graphSaveTail.current = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  };
  const guidedActions = {
    selectAgent: window.selene.designer.selectAgent,
    configureTrustedAgent: window.selene.designer.configureTrustedAgent,
    snapshot: window.selene.designer.snapshot,
    inspectDesignSystem: window.selene.designer.inspectDesignSystem,
    setDesignSystemInputs: window.selene.designer.setDesignSystemInputs,
    setDesignLanguageInputs: window.selene.designer.setDesignLanguageInputs,
    ingestDesignLanguage: window.selene.designer.ingestDesignLanguage,
    chooseDesignLanguageToImport: window.selene.designer.chooseDesignLanguageToImport,
    refreshDesignLanguageSource: window.selene.designer.refreshDesignLanguageSource,
    chooseDesignLanguageSourceToRelink: window.selene.designer.chooseDesignLanguageSourceToRelink
  };
  const saveCockpitPreferences = (next: WorkspaceCockpitPreferences) => {
    desiredCockpitPreferences.current = next;
    if (cockpitPreferenceFlushActive.current) return;
    cockpitPreferenceFlushActive.current = true;
    const flush = async () => {
      while (true) {
        const requested = desiredCockpitPreferences.current;
        try {
          // oxlint-disable-next-line no-await-in-loop -- Preference writes are latest-wins but strictly serial to retain durable rollback order.
          const durable = await window.selene.designer.saveWorkspaceCockpitPreferences(requested);
          committedCockpitPreferences.current = durable;
          if (desiredCockpitPreferences.current === requested) {
            setCockpitPreferences(durable);
            return;
          }
        } catch (error) {
          if (desiredCockpitPreferences.current === requested) {
            setCockpitPreferences({ ...committedCockpitPreferences.current });
            setNotice(presentDesignerError(error, 'workspace'));
            return;
          }
        }
      }
    };
    void flush().finally(() => {
      cockpitPreferenceFlushActive.current = false;
    });
  };
  return (
    <main
      ref={workspaceRoot}
      className="designer-workspace sl-theme"
      aria-label="Selene desktop designer"
      data-selene-preview-channel={previewChannelState.current}
      data-selene-preview-direct-authorized={previewDirectSelectionAuthorized ? 'true' : 'false'}
      data-selene-preview-telemetry={selectedPreviewTelemetry?.provenance ?? 'none'}
    >
      <header className="workspace-topbar">
        <div className="workspace-project-identity">
          <span className="brand-mark">S</span>
          <span className="workspace-product-title">Selene</span>
          <span
            aria-label={`Active project: ${snapshot.source.projectId}`}
            className="project-kicker"
            title={snapshot.source.projectId}
          >
            Project · {snapshot.source.projectId}
          </span>
        </div>
        <div className="project-actions">
          <ProjectLaunchpad actions={projectLaunchpadActions} onProjectOpened={openProject} />
          <WorkspaceToolbar
            baseline={snapshot.baseline}
            {...(snapshot.productMap === undefined ? {} : { productMap: snapshot.productMap })}
            actions={workspaceActions}
            onSnapshot={setSnapshot}
            onStatus={setNotice}
            onDeliveryBusyChange={setDeliveryBusy}
            workspaceBlocked={projectSwitching}
            onExportHandoff={(contents) => download(contents, 'selene-desktop.handoff.json')}
            onExportProductHandoff={(contents) => download(contents, 'selene-product.handoff.json')}
            onExportDiagnostics={(contents) => download(contents, 'selene-crash-diagnostics.json')}
            publishActive={publishActive}
            publishStarting={publishStarting}
            publishStatus={publishStatus}
            {...(completedRemotePublication === undefined
              ? {}
              : { completedRemoteReceipt: completedRemotePublication.receipt })}
            onOpenCompletedReceipt={async () => {
              if (!completedRemotePublication) throw new Error('Completed receipt is unavailable.');
              await window.selene.designer.openGeneratedCodePublishReceipt(
                completedRemotePublication.publishId
              );
            }}
            onGitHubSetup={() => window.selene.designer.githubPublishSetup()}
            onPublish={startPublish}
            onCancelPublish={cancelPublish}
          />
        </div>
      </header>
      <div className="workspace-status-strip">
        <p className="workspace-notice" role="status">
          {safeDesignerNotice(notice, 'Workspace status is unavailable. Try again.')}
        </p>
        <p className="workspace-notice" aria-live="polite">
          {safeDesignerNotice(publishStatus, 'Publish status is unavailable. Try again.')}
        </p>
      </div>
      <DesktopCockpit
        snapshot={snapshot}
        {...(build === undefined ? {} : { build })}
        describePreview={window.selene.preview.describe}
        frame={frame}
        onFrameLoad={connectPreviewFrame}
        onFrameError={handlePreviewFrameError}
        onSnapshot={setSnapshot}
        onRender={render}
        onPreviewAIProposal={previewAIProposal}
        onPreviewCurrentRevision={previewCurrentRevision}
        onBuildStoryPreview={window.selene.preview.buildStory}
        onPreviewSelectionClear={clearPreviewSelection}
        onCanvasNavigationChange={updateCanvasNavigation}
        onPreviewTargetCancelChange={updatePreviewTargetCancel}
        manualTextEditor={window.selene.designer}
        {...(selectedPreviewTelemetry === undefined ? {} : { selectedPreviewTelemetry })}
        previewDirectSelectionAuthorized={previewDirectSelectionAuthorized}
        previewSelectionClearEpoch={previewSelectionClearEpoch}
        {...(progress === undefined ? {} : { progress })}
        preferences={cockpitPreferences}
        onPreferencesChange={saveCockpitPreferences}
        guidedActions={guidedActions}
        actions={{
          snapshot: window.selene.designer.snapshot,
          selectNode: (nodeId) => {
            previewSelectionEpoch.current += 1;
            previewSelectionSuppressed.current = false;
            setPreviewDirectSelectionAuthorized(false);
            return enqueuePreviewSelectionHostOperation(() =>
              window.selene.designer.selectNode(nodeId)
            );
          },
          selectAgent: window.selene.designer.selectAgent,
          requestAIChange: window.selene.designer.requestAIChange,
          acceptAIProposal: window.selene.designer.acceptAIProposal,
          rejectAIProposal: window.selene.designer.rejectAIProposal,
          cancelAIChange: window.selene.designer.cancel,
          undoLastAIChange: window.selene.designer.undoLastAIChange,
          undoLatestManualDesignEdit: window.selene.designer.undoLatestManualDesignEdit,
          addReviewThread: window.selene.designer.addReviewThread,
          resolveReviewThread: window.selene.designer.resolveReviewThread,
          replyToReviewThread: window.selene.designer.replyToReviewThread,
          addDeveloperAnnotation: window.selene.designer.addDeveloperAnnotation,
          savePrototypeGraph,
          retryPrototypeGraphHydration: window.selene.designer.retryPrototypeGraphHydration,
          recoverPrototypeGraphFromFixture: window.selene.designer.recoverPrototypeGraphFromFixture,
          setPrototypeMode: window.selene.designer.setPrototypeMode,
          startPrototypeScenario: window.selene.designer.startPrototypeScenario,
          resetPrototypeRun: window.selene.designer.resetPrototypeRun
        }}
      />
    </main>
  );
}
