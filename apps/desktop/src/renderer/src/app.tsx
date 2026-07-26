import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DesktopCockpit } from './cockpit/desktop-cockpit';
import { ProjectLaunchpad } from './cockpit/project-launchpad';
import { WorkspaceToolbar } from './cockpit/workspace-toolbar';
import {
  isActivePreviewFrameEvent,
  PreviewPresentationCoordinator,
  PreviewRefreshError,
  refreshPreviewRevision,
  type PreviewPresentationIdentity
} from './cockpit/preview-refresh';
import {
  type PreviewRuntimeState,
  validatePreviewFrameMessage
} from '../../shared/preview-channel';
import {
  assertDesignerApiVersion,
  defaultWorkspaceCockpitPreferences,
  type DesignerProgress,
  type DesignerPublishConsentInput,
  type ProjectOpenResult,
  type DesignerSnapshot,
  type GeneratedCodePublishReceipt,
  type WorkspaceCockpitPreferences
} from '../../shared/designer-api';
import { DESKTOP_PRELOAD_API_VERSION } from '../../shared/desktop-api';

type BuildResult = Awaited<ReturnType<Window['selene']['preview']['build']>>;

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

/** Electron orchestration only: all product visuals live in DesktopCockpit. */
export function App() {
  const [snapshot, setSnapshot] = useState<DesignerSnapshot>();
  const [build, setBuild] = useState<BuildResult>();
  const [notice, setNotice] = useState('Loading desktop designer…');
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
  const framePort = useRef<MessagePort | null>(null);
  const activePreviewIdentity = useRef<PreviewPresentationIdentity | undefined>(undefined);
  const activePreviewRefresh = useRef<AbortController | undefined>(undefined);
  const publishPreviewBuild = useCallback((nextBuild: BuildResult) => {
    framePort.current?.close();
    framePort.current = null;
    activePreviewIdentity.current = previewIdentity(nextBuild);
    setBuild(nextBuild);
  }, []);
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
  const compile = useCallback(
    async (next: DesignerSnapshot, signal?: AbortSignal): Promise<BuildResult> => {
      if (signal?.aborted)
        throw new PreviewRefreshError(
          'refresh-aborted',
          next.source.revision.id,
          'The refresh was cancelled before compilation'
        );
      const result = await window.selene.preview.build(next.source);
      if (signal?.aborted)
        throw new PreviewRefreshError(
          'refresh-aborted',
          next.source.revision.id,
          'The refresh was cancelled during compilation'
        );
      if (!validBuild(result)) throw new Error('Preview host returned an invalid preview build');
      return result;
    },
    []
  );
  const render = useCallback(
    async (next: DesignerSnapshot): Promise<void> => {
      activePreviewRefresh.current?.abort();
      const controller = new AbortController();
      activePreviewRefresh.current = controller;
      try {
        const refreshed = await refreshPreviewRevision({
          snapshot: next,
          compile,
          present: (nextBuild, signal) => previewPresentation.present(nextBuild, signal),
          retargetSelection: async (accepted, revisionId) => {
            if (!accepted.selectedNodeId) return accepted;
            const retargeted = await window.selene.designer.selectNode(accepted.selectedNodeId);
            if (retargeted.source.revision.id !== revisionId)
              throw new Error(`Host selection belongs to ${retargeted.source.revision.id}`);
            return retargeted;
          },
          signal: controller.signal
        });
        setSnapshot(refreshed.snapshot);
      } finally {
        if (activePreviewRefresh.current === controller) activePreviewRefresh.current = undefined;
      }
    },
    [compile, previewPresentation]
  );
  const setDeliveryBusy = useCallback((busy: boolean) => {
    deliveryActionInFlight.current = busy;
  }, []);
  const setProjectSwitchBusy = useCallback((busy: boolean) => {
    projectSwitchInFlight.current = busy;
    setProjectSwitching(busy);
  }, []);

  useEffect(() => {
    try {
      if (window.selene.apiVersion !== DESKTOP_PRELOAD_API_VERSION)
        throw new Error(`Unsupported desktop preload API version: ${window.selene.apiVersion}`);
      assertDesignerApiVersion(window.selene.designer.apiVersion);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Designer API is incompatible.');
      return;
    }
    setNotice('Choose a local project or create a new design workspace.');
    void window.selene.designer
      .workspaceCockpitPreferences()
      .then((next) => {
        committedCockpitPreferences.current = next;
        desiredCockpitPreferences.current = next;
        setCockpitPreferences(next);
      })
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : 'Workspace preferences could not be loaded.'
        )
      );
    return window.selene.designer.onProgress((event) => setProgress(event));
  }, []);

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
                  ? `${operation.error.code}: ${operation.error.message}`
                  : (operation.progress.at(-1) ?? 'Running host operation.')
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
            setPublishStatus(
              error instanceof Error
                ? `Publish status unavailable: ${error.message}`
                : 'Publish status unavailable.'
            );
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
        setPublishStatus(
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Publish was not started.'
        );
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

  const workspaceActions = useMemo(
    () => ({
      render: async () => {
        if (!snapshot) throw new Error('The local workspace is still loading.');
        await render(snapshot);
      },
      markReadyForReview: window.selene.designer.markReadyForReview,
      markReadyForHandoff: window.selene.designer.markReadyForHandoff,
      exportHandoff: window.selene.designer.exportHandoff,
      diagnostics: window.selene.diagnostics
    }),
    [render, snapshot]
  );

  function connectPreviewFrame(loadedFrame: HTMLIFrameElement): void {
    if (!build || frame.current !== loadedFrame || !loadedFrame.contentWindow) return;
    const identity = previewIdentity(build);
    framePort.current?.close();
    const channel = new MessageChannel();
    const channelIsActive = () =>
      isActivePreviewFrameEvent({
        activeIdentity: activePreviewIdentity.current,
        eventIdentity: identity,
        channelIsActive: framePort.current === channel.port1
      });
    channel.port1.onmessage = (event) => {
      if (!channelIsActive()) return;
      const message = validatePreviewFrameMessage(event.data, {
        ...build.policy,
        revisionId: build.revisionId
      });
      if (!message) return;
      if (message.type === 'runtime-error') {
        const reason = message.message ?? 'The preview reported an unknown runtime error';
        if (!previewPresentation.failed(identity, 'iframe-runtime-failed', reason)) return;
        window.selene.preview.postMessage(build.policy, message);
        setNotice(
          new PreviewRefreshError('iframe-runtime-failed', build.revisionId, reason).message
        );
        return;
      }
      window.selene.preview.postMessage(build.policy, message);
      if (message.type === 'select-node' && message.nodeId)
        void window.selene.designer
          .selectNode(message.nodeId)
          .then((next) => {
            if (channelIsActive()) setSnapshot(next);
          })
          .catch((error: unknown) =>
            channelIsActive()
              ? setNotice(error instanceof Error ? error.message : 'Could not select preview node.')
              : undefined
          );
      if (message.type === 'trigger-action' && message.nodeId && message.portId)
        void window.selene.designer
          .runPrototypeAction({ nodeId: message.nodeId, portId: message.portId })
          .then((next) => {
            if (!channelIsActive()) return;
            setSnapshot(next);
            const state = runtimeState(next);
            if (state && framePort.current === channel.port1)
              channel.port1.postMessage({
                type: 'runtime-state',
                nonce: build.policy.nonce,
                origin: build.policy.origin,
                revisionId: build.revisionId,
                state
              });
          })
          .catch((error: unknown) =>
            channelIsActive()
              ? setNotice(error instanceof Error ? error.message : 'Preview action failed.')
              : undefined
          );
      if (message.type === 'ready') {
        previewPresentation.ready(identity);
        const state = snapshot ? runtimeState(snapshot) : undefined;
        if (state && framePort.current === channel.port1)
          channel.port1.postMessage({
            type: 'runtime-state',
            nonce: build.policy.nonce,
            origin: build.policy.origin,
            revisionId: build.revisionId,
            state
          });
      }
      if (message.type === 'rendered') previewPresentation.rendered(identity);
    };
    channel.port1.start();
    loadedFrame.contentWindow.postMessage(
      { type: 'selene-preview-init', nonce: build.policy.nonce, revisionId: build.revisionId },
      build.policy.origin,
      [channel.port2]
    );
    framePort.current = channel.port1;
  }

  function handlePreviewFrameError(failedFrame: HTMLIFrameElement): void {
    if (!build || frame.current !== failedFrame) return;
    framePort.current?.close();
    framePort.current = null;
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
        setPublishId(undefined);
        setCompletedRemotePublication(undefined);
        setPublishStatus('No publish operation started for this project.');
        activePreviewRefresh.current?.abort();
        activePreviewRefresh.current = undefined;
        previewPresentation.close();
        const nextBuild = await compile(opened.snapshot);
        setSnapshot(opened.snapshot);
        publishPreviewBuild(nextBuild);
        setNotice(`${opened.receipt.name} is ready.`);
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : 'The project preview could not compile.'
        );
        throw error;
      } finally {
        setProjectSwitchBusy(false);
      }
    },
    [compile, previewPresentation, publishPreviewBuild, setProjectSwitchBusy]
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
            setNotice(
              error instanceof Error
                ? `Workspace preference save failed: ${error.message}`
                : 'Workspace preference save failed.'
            );
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
    <main className="designer-workspace sl-theme" aria-label="Selene desktop designer">
      <header className="workspace-topbar">
        <div className="workspace-project-identity">
          <span className="brand-mark">S</span>
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
            actions={workspaceActions}
            onSnapshot={setSnapshot}
            onStatus={setNotice}
            onDeliveryBusyChange={setDeliveryBusy}
            workspaceBlocked={projectSwitching}
            onExportHandoff={(contents) => download(contents, 'selene-desktop.handoff.json')}
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
          {notice}
        </p>
        <p className="workspace-notice" aria-live="polite">
          {publishStatus}
        </p>
      </div>
      <DesktopCockpit
        snapshot={snapshot}
        {...(build === undefined ? {} : { build })}
        frame={frame}
        onFrameLoad={connectPreviewFrame}
        onFrameError={handlePreviewFrameError}
        onSnapshot={setSnapshot}
        onRender={render}
        {...(progress === undefined ? {} : { progress })}
        preferences={cockpitPreferences}
        onPreferencesChange={saveCockpitPreferences}
        guidedActions={guidedActions}
        actions={{
          snapshot: window.selene.designer.snapshot,
          selectAgent: window.selene.designer.selectAgent,
          requestAIChange: window.selene.designer.requestAIChange,
          cancelAIChange: window.selene.designer.cancel,
          undoLastAIChange: window.selene.designer.undoLastAIChange,
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
