import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DesktopCockpit } from './cockpit/desktop-cockpit';
import { WorkspaceToolbar } from './cockpit/workspace-toolbar';
import {
  type PreviewRuntimeState,
  validatePreviewFrameMessage
} from '../../shared/preview-channel';
import {
  assertDesignerApiVersion,
  defaultWorkspaceCockpitPreferences,
  type DesignerProgress,
  type DesignerPublishConsentInput,
  type DesignerSnapshot,
  type GeneratedCodePublishReceipt,
  type WorkspaceCockpitPreferences
} from '../../shared/designer-api';

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
  const [completedRemoteReceipt, setCompletedRemoteReceipt] =
    useState<Extract<GeneratedCodePublishReceipt, { readonly mode: 'github-remote' }>>();
  const [cockpitPreferences, setCockpitPreferences] = useState<WorkspaceCockpitPreferences>(
    defaultWorkspaceCockpitPreferences
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const framePort = useRef<MessagePort | null>(null);
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

  const render = useCallback(async (next: DesignerSnapshot): Promise<void> => {
    const result = await window.selene.preview.build(next.source);
    if (!validBuild(result)) throw new Error('Preview host returned an invalid preview build');
    setBuild(result);
  }, []);

  useEffect(() => {
    try {
      assertDesignerApiVersion(window.selene.designer.apiVersion);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Designer API is incompatible.');
      return;
    }
    void window.selene.designer
      .snapshot()
      .then((next) => {
        assertDesignerApiVersion(next.apiVersion);
        setSnapshot(next);
        setNotice('Local workspace loaded. Compiling the React preview…');
        return next;
      })
      .then(render)
      .then(() => {
        setNotice('Validated local workspace ready.');
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : 'Designer failed to load.')
      );
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
  }, [render]);

  useEffect(() => {
    if (!publishId) return;
    const timer = window.setInterval(
      () =>
        void window.selene.designer
          .generatedCodePublishOperation(publishId)
          .then((operation) => {
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
              setCompletedRemoteReceipt(operation.receipt);
            if (operation.status !== 'running') {
              setPublishActive(false);
              window.clearInterval(timer);
            }
          })
          .catch((error: unknown) => {
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
      if (publishStartInFlight.current || publishActive)
        throw new Error('A publish start is already active.');
      publishStartInFlight.current = true;
      setPublishStarting(true);
      setPublishId(undefined);
      setCompletedRemoteReceipt(undefined);
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
    [build?.revisionId]
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

  function connectPreviewFrame(): void {
    if (!build || !frame.current?.contentWindow) return;
    framePort.current?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      if (framePort.current !== channel.port1) return;
      const message = validatePreviewFrameMessage(event.data, {
        ...build.policy,
        revisionId: build.revisionId
      });
      if (!message) return;
      window.selene.preview.postMessage(build.policy, message);
      if (message.type === 'select-node' && message.nodeId)
        void window.selene.designer
          .selectNode(message.nodeId)
          .then(setSnapshot)
          .catch((error: unknown) =>
            setNotice(error instanceof Error ? error.message : 'Could not select preview node.')
          );
      if (message.type === 'trigger-action' && message.nodeId && message.portId)
        void window.selene.designer
          .runPrototypeAction({ nodeId: message.nodeId, portId: message.portId })
          .then((next) => {
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
            setNotice(error instanceof Error ? error.message : 'Preview action failed.')
          );
      if (message.type === 'runtime-error')
        setNotice(`Preview error: ${message.message ?? 'unknown error'}`);
      if (message.type === 'ready') {
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
    };
    channel.port1.start();
    frame.current.contentWindow.postMessage(
      { type: 'selene-preview-init', nonce: build.policy.nonce, revisionId: build.revisionId },
      build.policy.origin,
      [channel.port2]
    );
    framePort.current = channel.port1;
  }

  if (!snapshot)
    return (
      <main className="designer-workspace workspace-loading" aria-busy="true">
        <section role="status">
          <span className="workspace-loading__mark" aria-hidden="true">
            S
          </span>
          <strong>Preparing your local design workspace</strong>
          <p>{notice}</p>
        </section>
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
    ingestDesignLanguage: window.selene.designer.ingestDesignLanguage,
    createProject: window.selene.designer.createProject,
    importProject: window.selene.designer.importProject
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
    <main className="designer-workspace" aria-label="Selene desktop designer">
      <header className="workspace-topbar">
        <div>
          <span className="brand-mark">S</span>
          <span className="project-kicker">Desktop production designer</span>
        </div>
        <div className="project-actions">
          <WorkspaceToolbar
            actions={workspaceActions}
            onSnapshot={setSnapshot}
            onStatus={setNotice}
            onExportHandoff={(contents) => download(contents, 'selene-desktop.handoff.json')}
            onExportDiagnostics={(contents) => download(contents, 'selene-crash-diagnostics.json')}
            publishActive={publishActive}
            publishStarting={publishStarting}
            publishStatus={publishStatus}
            {...(completedRemoteReceipt === undefined ? {} : { completedRemoteReceipt })}
            onOpenCompletedReceipt={async () => {
              if (!publishId) throw new Error('Completed receipt is unavailable.');
              await window.selene.designer.openGeneratedCodePublishReceipt(publishId);
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
        onSnapshot={setSnapshot}
        onRender={render}
        onProjectOpened={async (opened) => {
          setSnapshot(opened.snapshot);
          setBuild(undefined);
          await render(opened.snapshot);
        }}
        {...(progress === undefined ? {} : { progress })}
        preferences={cockpitPreferences}
        onPreferencesChange={saveCockpitPreferences}
        guidedActions={guidedActions}
        actions={{
          selectAgent: window.selene.designer.selectAgent,
          requestAIChange: window.selene.designer.requestAIChange,
          addReviewThread: window.selene.designer.addReviewThread,
          resolveReviewThread: window.selene.designer.resolveReviewThread,
          replyToReviewThread: window.selene.designer.replyToReviewThread,
          addDeveloperAnnotation: window.selene.designer.addDeveloperAnnotation,
          savePrototypeGraph,
          retryPrototypeGraphHydration: window.selene.designer.retryPrototypeGraphHydration,
          recoverPrototypeGraphFromFixture: window.selene.designer.recoverPrototypeGraphFromFixture,
          setPrototypeMode: window.selene.designer.setPrototypeMode,
          resetPrototypeRun: window.selene.designer.resetPrototypeRun
        }}
      />
    </main>
  );
}
