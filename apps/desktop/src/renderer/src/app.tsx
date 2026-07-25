import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { PrototypeFlowCanvas } from '@selene/ui/prototype';

import {
  type PreviewRuntimeState,
  validatePreviewFrameMessage
} from '../../shared/preview-channel';

import {
  assertDesignerApiVersion,
  type DesignerProgress,
  type DesignerSnapshot,
  type SpatialTargetInput
} from '../../shared/designer-api';

type BuildResult = Awaited<ReturnType<Window['selene']['preview']['build']>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreviewPolicy(value: unknown): value is BuildResult['policy'] {
  if (!isRecord(value)) return false;
  return (
    typeof value.origin === 'string' &&
    value.origin === 'selene-preview://local' &&
    typeof value.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(value.nonce) &&
    typeof value.maxMessageBytes === 'number' &&
    Number.isSafeInteger(value.maxMessageBytes) &&
    value.maxMessageBytes >= 256 &&
    value.maxMessageBytes <= 64 * 1024 &&
    typeof value.csp === 'string'
  );
}

function isPreviewUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'selene-preview:' &&
      url.hostname === 'local' &&
      /^\/[A-Za-z0-9_-]{1,128}\/index\.html$/.test(url.pathname) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isPreviewBuild(value: unknown): value is BuildResult {
  if (!isRecord(value) || !isPreviewPolicy(value.policy)) return false;
  return (
    typeof value.revisionId === 'string' &&
    value.revisionId.length > 0 &&
    value.revisionId.length <= 128 &&
    isPreviewUrl(value.url)
  );
}

function previewRuntimeState(snapshot: DesignerSnapshot): PreviewRuntimeState | undefined {
  const runtime = snapshot.editablePrototype.runtime;
  if (!runtime) return undefined;
  return {
    activeNodeId: runtime.activeNodeId,
    ...(runtime.activeStateId ? { activeStateId: runtime.activeStateId } : {}),
    ...(runtime.activeOverlayId ? { activeOverlayId: runtime.activeOverlayId } : {}),
    activePathTransitionIds: runtime.activePathTransitionIds.slice(0, 256)
  };
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
  const x = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  const y = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
  return { x, y, viewport: { width: Math.round(box.width), height: Math.round(box.height) } };
}

function targetFromEvent(event: PointerEvent<HTMLElement>): SpatialTargetInput | undefined {
  return targetAt(event.currentTarget, event.clientX, event.clientY);
}

function regionFrom(start: SpatialTargetInput, end: SpatialTargetInput): SpatialTargetInput {
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: right - Math.min(start.x, end.x),
    height: bottom - Math.min(start.y, end.y),
    viewport: start.viewport
  };
}

function download(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Trusted overlay owns spatial input; the sandboxed frame only renders compiled source. */
export function App() {
  const [snapshot, setSnapshot] = useState<DesignerSnapshot>();
  const [build, setBuild] = useState<BuildResult>();
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [annotation, setAnnotation] = useState('Preserve keyboard focus after this change.');
  const [target, setTarget] = useState<SpatialTargetInput>();
  const [targeting, setTargeting] = useState(false);
  const [notice, setNotice] = useState('Loading desktop designer…');
  const [progress, setProgress] = useState<DesignerProgress>();
  const [diagnosticsConsent, setDiagnosticsConsent] = useState<'unknown' | 'granted' | 'denied'>(
    'unknown'
  );
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [repository, setRepository] = useState('owner/desktop-design');
  const [publishTitle, setPublishTitle] = useState('Review generated desktop flow');
  const [publishStatus, setPublishStatus] = useState('No publish operation started.');
  const [publishId, setPublishId] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  const framePort = useRef<MessagePort>();
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);
  const graphSaveTail = useRef<Promise<void>>(Promise.resolve());
  const lastGraph = useRef<DesignerSnapshot['editablePrototype']['graph']>();
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');

  function saveGraph(graph: DesignerSnapshot['editablePrototype']['graph']): void {
    if (snapshot?.prototypeGraphHydration.state === 'recovery-required') {
      setGraphSaveStatus('Graph recovery is required before changes can be saved.');
      return;
    }
    lastGraph.current = graph;
    setGraphSaveStatus('Saving graph revision…');
    graphSaveTail.current = graphSaveTail.current
      .catch(() => undefined)
      .then(() => window.selene.designer.savePrototypeGraph(graph))
      .then((next) => {
        setSnapshot(next);
        setGraphSaveStatus(`Saved graph revision ${next.editablePrototype.revision}.`);
      })
      .catch((error: unknown) =>
        setGraphSaveStatus(error instanceof Error ? `${error.message} Retry is available.` : 'Graph save failed. Retry is available.')
      );
  }

  useEffect(() => {
    if (!publishId) return;
    const timer = window.setInterval(() => {
      void window.selene.designer.generatedCodePublishOperation(publishId).then((operation) => {
        const detail = operation.receipt
          ? `${operation.receipt.kind}: ${operation.receipt.status} (${operation.receipt.immutableId})`
          : operation.error
            ? `${operation.error.code}: ${operation.error.message}`
            : operation.progress.at(-1) ?? 'Running host operation.';
        setPublishStatus(detail);
        if (operation.status !== 'running') window.clearInterval(timer);
      });
    }, 350);
    return () => window.clearInterval(timer);
  }, [publishId]);

  async function render(next: DesignerSnapshot): Promise<void> {
    const result = await window.selene.preview.build(next.source);
    if (!isPreviewBuild(result)) throw new Error('Preview host returned an invalid preview build');
    setBuild(result);
  }

  useEffect(() => {
    try {
      assertDesignerApiVersion(window.selene.designer.apiVersion);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Designer API version is incompatible.');
      return;
    }
    void window.selene.designer
      .snapshot()
      .then(async (next) => {
        assertDesignerApiVersion(next.apiVersion);
        setSnapshot(next);
        await render(next);
        setNotice('Validated local workspace ready.');
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : 'Designer failed to load.')
      );
    void window.selene.diagnostics
      .consent()
      .then((consent) => setDiagnosticsConsent(consent.user))
      .catch(() => setNotice('Diagnostics consent could not be loaded.'));
    void window.selene.diagnostics
      .recovery()
      .then((recovery) => setRecoveryActive(recovery.active))
      .catch(() => setNotice('Crash recovery state could not be loaded.'));
    return window.selene.designer.onProgress((event) => setProgress(event));
  }, []);

  useEffect(
    () => () => {
      framePort.current?.close();
      framePort.current = undefined;
    },
    [build?.revisionId]
  );

  useEffect(() => {
    if (!snapshot || !build || !framePort.current) return;
    const state = previewRuntimeState(snapshot);
    if (!state) return;
    framePort.current.postMessage({
      type: 'runtime-state',
      nonce: build.policy.nonce,
      origin: build.policy.origin,
      revisionId: build.revisionId,
      state
    });
  }, [build, snapshot]);

  function connectPreviewFrame(): void {
    if (!build || !frame.current?.contentWindow) return;
    framePort.current?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      if (framePort.current !== channel.port1) return;
      const message = validatePreviewFrameMessage(event.data, build.policy);
      if (!message || message.revisionId !== build.revisionId) return;
      // Port messages are still audited by main, which revalidates against the
      // artifact registry before any diagnostics sink observes them.
      window.selene.preview.postMessage(build.policy, message);
      if (message.type === 'select-node' && message.nodeId)
        void window.selene.designer.selectNode(message.nodeId).then(setSnapshot).catch(() => undefined);
      if (message.type === 'trigger-action' && message.nodeId && message.portId)
        void window.selene.designer.runPrototypeAction({ nodeId: message.nodeId, portId: message.portId }).then((next) => {
          setSnapshot(next);
          const state = previewRuntimeState(next);
          if (state && framePort.current === channel.port1)
            channel.port1.postMessage({ type: 'runtime-state', nonce: build.policy.nonce, origin: build.policy.origin, revisionId: build.revisionId, state });
        }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Preview action failed.'));
      if (message.type === 'runtime-error')
        setNotice(`Preview error: ${message.message ?? 'unknown error'}`);
      if (message.type === 'ready') {
        setNotice('Generated React preview rendered in a sandboxed frame.');
        const state = snapshot ? previewRuntimeState(snapshot) : undefined;
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

  if (!snapshot) return <main className="designer-workspace">{notice}</main>;
  const selectedScenario = snapshot.scenarios.find(
    (item) => item.id === snapshot.selectedScenarioId
  );
  return (
    <main className="designer-workspace" aria-label="Selene desktop designer">
      <header className="workspace-topbar">
        <div>
          <span className="brand-mark">S</span>
          <span className="project-kicker">Desktop production designer</span>
        </div>
        <div className="project-actions">
          <button
            type="button"
            disabled={recoveryActive}
            onClick={() =>
              void render(snapshot).catch((error: unknown) =>
                setNotice(error instanceof Error ? error.message : 'Render failed.')
              )
            }
          >
            Render revision
          </button>
          <button
            type="button"
            onClick={() => void window.selene.designer.markReadyForReview().then(setSnapshot)}
          >
            Ready for review
          </button>
          <button
            type="button"
            onClick={() => void window.selene.designer.markReadyForHandoff().then(setSnapshot)}
          >
            Ready for handoff
          </button>
          <button
            type="button"
            onClick={() =>
              void window.selene.designer
                .exportHandoff()
                .then((handoff) => download(handoff, 'selene-desktop.handoff.json'))
                .catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'Export failed.')
                )
            }
          >
            Export handoff
          </button>
          <label>
            GitHub repository
            <input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} />
          </label>
          <label>
            Review title
            <input value={publishTitle} onChange={(event) => setPublishTitle(event.currentTarget.value)} />
          </label>
          <button
            type="button"
            onClick={() =>
              void window.selene.designer
                .requestGeneratedCodePublishConsent({ repository, title: publishTitle })
                .then(({ consentId }) =>
                  window.selene.designer.publishGeneratedCode({
                    repository,
                    title: publishTitle,
                    consentId
                  })
                )
                .then((operation) => {
                  setPublishId(operation.id);
                  setPublishStatus('Host operation started; waiting for its immutable receipt.');
                })
                .catch((error: unknown) =>
                  setPublishStatus(error instanceof Error ? error.message : 'Publish operation failed.')
                )
            }
          >
            Request hosted review
          </button>
          {publishId ? (
            <button type="button" onClick={() => void window.selene.designer.cancelGeneratedCodePublish(publishId)}>
              Cancel publish
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              void window.selene.diagnostics
                .export()
                .then((bundle) => {
                  download(JSON.stringify(bundle, null, 2), 'selene-crash-diagnostics.json');
                  setNotice('Exported local crash diagnostics.');
                })
                .catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'Diagnostics export failed.')
                )
            }
          >
            Export diagnostics
          </button>
          <label>
            <input
              type="checkbox"
              checked={diagnosticsConsent === 'granted'}
              onChange={(event) =>
                void window.selene.diagnostics
                  .setConsent(event.currentTarget.checked ? 'granted' : 'denied')
                  .then((consent) => {
                    setDiagnosticsConsent(consent.user);
                    setNotice(
                      consent.user === 'granted'
                        ? 'Local crash diagnostics enabled. Nothing is sent automatically.'
                        : 'Local crash diagnostics disabled and queued events deleted.'
                    );
                  })
                  .catch((error: unknown) =>
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : 'Diagnostics consent could not be saved.'
                    )
                  )
              }
            />
            Store local crash diagnostics on this device
          </label>
          <button
            type="button"
            onClick={() =>
              void window.selene.diagnostics
                .delete()
                .then(() => setNotice('Deleted local crash diagnostics.'))
                .catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'Diagnostics delete failed.')
                )
            }
          >
            Delete diagnostics
          </button>
        </div>
      </header>
      {recoveryActive ? (
        <section className="workspace-notice" role="alert">
          <strong>Crash recovery is active.</strong> Generated preview builds are paused after
          repeated failed starts. Local diagnostics remain private and can be exported or deleted.
          <button
            type="button"
            onClick={() =>
              void window.selene.diagnostics
                .resetRecovery()
                .then(() => {
                  setRecoveryActive(false);
                  setNotice('Crash recovery reset. You can render a revision again.');
                })
                .catch((error: unknown) =>
                  setNotice(
                    error instanceof Error ? error.message : 'Crash recovery could not be reset.'
                  )
                )
            }
          >
            Resume previews
          </button>
        </section>
      ) : null}
      <p className="workspace-notice" role="status">
        {notice}
      </p>
      <p className="workspace-notice" aria-live="polite">
        {publishStatus}
      </p>
      <div className="workspace-layout">
        <aside className="conversation-rail">
          <h2>AI change request</h2>
          <label>
            Configured agent
            <select
              aria-label="Configured agent"
              value={snapshot.selectedAgentId}
              onChange={(event) =>
                void window.selene.designer.selectAgent(event.currentTarget.value).then(setSnapshot)
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
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
            />
          </label>
          <button type="button" onClick={() => setTargeting((value) => !value)}>
            {targeting ? 'Targeting enabled: click or drag preview' : 'Target a point or region'}
          </button>
          <p>
            {target
              ? `Spatial target: ${(target.x * 100).toFixed(0)}%, ${(target.y * 100).toFixed(0)}%`
              : 'Select target mode to create an AI change request.'}
          </p>
          <button
            type="button"
            disabled={!target}
            onClick={() => {
              if (!target) return;
              void window.selene.designer
                .requestAIChange({ agentId: snapshot.selectedAgentId, instruction, target })
                .then(async (next) => {
                  setSnapshot(next);
                  await render(next);
                  setNotice(`Applied ${next.source.revision.id}.`);
                })
                .catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'AI request failed.')
                );
            }}
          >
            Send targeted change
          </button>
          <button
            type="button"
            disabled={!target}
            onClick={() => {
              if (!target) return;
              void window.selene.designer
                .addArtifactPin({ label: 'Pinned visual region', anchor: target })
                .then((next) => {
                  setSnapshot(next);
                  setNotice('Pinned the artifact region independently from the AI target.');
                });
            }}
          >
            Pin selected artifact region
          </button>
          {progress ? (
            <p aria-live="polite">
              {progress.stage}: {progress.message}
            </p>
          ) : null}
          <h2>Developer handoff annotation</h2>
          <textarea
            aria-label="Developer annotation"
            value={annotation}
            onChange={(event) => setAnnotation(event.currentTarget.value)}
          />
          <button
            type="button"
            onClick={() =>
              void window.selene.designer
                .addDeveloperAnnotation({ category: 'accessibility', body: annotation })
                .then(setSnapshot)
            }
          >
            Add direction
          </button>
        </aside>
        <section className="preview-pane">
          <div className="preview-toolbar">
            <span>Compiled React artifact</span>
            <code>{snapshot.source.revision.id}</code>
            <span>{snapshot.baseline.readiness}</span>
          </div>
          <div style={{ position: 'relative' }}>
            {build ? (
              <iframe
                ref={frame}
                title="Generated React preview frame"
                src={build.url}
                onLoad={connectPreviewFrame}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                style={{ border: '1px solid #ccd', height: 360, width: '100%' }}
              />
            ) : null}
            {targeting ? (
              <button
                aria-label="Select a spatial change target in the preview"
                type="button"
                onPointerDown={(event) => {
                  const start = targetFromEvent(event);
                  if (!start) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragStart.current = start;
                  setTarget(start);
                }}
                onPointerUp={(event) => {
                  const start = dragStart.current;
                  const end = targetFromEvent(event);
                  dragStart.current = undefined;
                  if (start && end) {
                    const region = regionFrom(start, end);
                    setTarget(region.width === 0 && region.height === 0 ? start : region);
                  }
                  setTargeting(false);
                }}
                onPointerCancel={() => {
                  dragStart.current = undefined;
                  setTargeting(false);
                }}
                onClick={(event) => {
                  // Keyboard and assistive-technology activation has no pointer coordinates;
                  // use the preview centre as a deterministic, editable starting point.
                  if (event.detail !== 0) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  const centre = targetAt(
                    event.currentTarget,
                    box.left + box.width / 2,
                    box.top + box.height / 2
                  );
                  if (centre) setTarget(centre);
                  setTargeting(false);
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  cursor: 'crosshair',
                  border: 0,
                  background: 'transparent',
                  padding: 0
                }}
              />
            ) : null}
            {target ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: `${target.x * 100}%`,
                  top: `${target.y * 100}%`,
                  width: `${(target.width ?? 0.02) * 100}%`,
                  height: `${(target.height ?? 0.02) * 100}%`,
                  border: '2px solid #7c3aed',
                  pointerEvents: 'none'
                }}
              />
            ) : null}
          </div>
        </section>
        <aside className="inspector">
          <section>
            <h2>Saved prototype flow</h2>
            <p>Revision {snapshot.editablePrototype.revision} is persisted by the local host.</p>
            <p aria-live="polite">{graphSaveStatus}</p>
            {snapshot.prototypeGraphHydration.state === 'recovery-required' ? (
              <section className="workspace-notice" role="alert">
                <p>{snapshot.prototypeGraphHydration.message}</p>
                {snapshot.prototypeGraphHydration.recovery ? (
                  <p>Recovery receipt: {snapshot.prototypeGraphHydration.recovery.recoveryId}</p>
                ) : null}
                <p>Edits are read-only until the saved artifact is retried or explicitly recovered.</p>
                <button
                  type="button"
                  onClick={() =>
                    void window.selene.designer
                      .retryPrototypeGraphHydration()
                      .then(setSnapshot)
                      .catch((error: unknown) =>
                        setGraphSaveStatus(
                          error instanceof Error ? error.message : 'Could not retry saved graph recovery.'
                        )
                      )
                  }
                >
                  Retry saved graph
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void window.selene.designer
                      .recoverPrototypeGraphFromFixture()
                      .then((next) => {
                        setSnapshot(next);
                        const receipt = next.prototypeGraphHydration.recovery;
                        setGraphSaveStatus(
                          receipt
                            ? `Recovered fixture; preserved ${receipt.recoveryId} (${receipt.capturedBytes ?? 0} bytes).`
                            : 'Recovered fixture with a host receipt.'
                        );
                      })
                      .catch((error: unknown) =>
                        setGraphSaveStatus(
                          error instanceof Error ? error.message : 'Fixture recovery could not be completed.'
                        )
                      )
                  }
                >
                  Recover from fixture
                </button>
              </section>
            ) : null}
            <button type="button" disabled={!lastGraph.current || snapshot.prototypeGraphHydration.state === 'recovery-required'} onClick={() => lastGraph.current && saveGraph(lastGraph.current)}>
              Retry graph save
            </button>
            <button
              type="button"
              disabled={snapshot.prototypeGraphHydration.state === 'recovery-required'}
              onClick={() =>
                void window.selene.designer
                  .setPrototypeMode(snapshot.editablePrototype.mode === 'edit' ? 'run' : 'edit')
                  .then((next) => {
                    setSnapshot(next);
                    setNotice(
                      next.editablePrototype.mode === 'run'
                        ? 'Run mode uses the saved flow graph.'
                        : 'Edit mode restored for the saved flow graph.'
                    );
                  })
              }
            >
              {snapshot.editablePrototype.mode === 'edit' ? 'Run saved flow' : 'Edit saved flow'}
            </button>
            {snapshot.editablePrototype.mode === 'edit' ? (
              <PrototypeFlowCanvas
                graph={snapshot.editablePrototype.graph}
                onGraphChange={
                  snapshot.prototypeGraphHydration.state === 'recovery-required' ? undefined : saveGraph
                }
                readOnly={snapshot.prototypeGraphHydration.state === 'recovery-required'}
              />
            ) : (
              <div>
                <p>Run mode is bound to the saved revision and cannot mutate ports or edges.</p>
                <button type="button" onClick={() => void window.selene.designer.resetPrototypeRun().then(setSnapshot)}>
                  Reset scenario
                </button>
                {snapshot.editablePrototype.runtime ? (
                  <>
                    <p>Active node: {snapshot.editablePrototype.runtime.activeNodeId}</p>
                    <PrototypeFlowCanvas
                      graph={snapshot.editablePrototype.graph}
                      activeNodeIds={[snapshot.editablePrototype.runtime.activeNodeId]}
                      activeTransitionIds={snapshot.editablePrototype.runtime.activePathTransitionIds}
                      readOnly
                    />
                  </>
                ) : null}
              </div>
            )}
          </section>
          <section>
            <h2>Guided local setup</h2>
            <ol>
              <li>Choose a trusted custom agent command and grant only declared capabilities.</li>
              <li>Review the npm package manifest and lockfile before enabling an adapter.</li>
              <li>Import Markdown as data, then select a template to create a local project.</li>
            </ol>
            <p>Setup remains host-owned; generated code and credentials never enter the preview frame.</p>
          </section>
          <section>
            <h2>Accessible scenario inspector</h2>
            <p>
              {selectedScenario?.title} · {selectedScenario?.state}
            </p>
            <p>{selectedScenario?.navigation.map((step) => step.route).join(' → ')}</p>
          </section>
          <section>
            <h2>Persistent artifact pins</h2>
            {snapshot.artifactPins.map((pin) => (
              <p key={pin.id}>
                {pin.label}: {Math.round(pin.anchor.x * 100)}%, {Math.round(pin.anchor.y * 100)}%
              </p>
            ))}
          </section>
          <section>
            <h2>Component catalog metadata</h2>
            {snapshot.componentCatalog.entries.map((entry) => (
              <p key={entry.component}>{entry.component}</p>
            ))}
          </section>
          <section>
            <h2>Request history</h2>
            {snapshot.aiChangeRequests.map((request) => (
              <p key={request.id}>
                {request.status}: {request.instruction}
              </p>
            ))}
          </section>
          <section aria-label="Design baseline status">
            <h2>Design baseline</h2>
            <p>
              {snapshot.baseline.readiness} / {snapshot.baseline.currency}
            </p>
            <p>
              {snapshot.baseline.changesSinceBaseline.length} changes since{' '}
              {snapshot.baseline.baseline?.intent === 'review'
                ? 'review baseline'
                : snapshot.baseline.baseline?.intent === 'handoff'
                  ? 'handoff baseline'
                  : 'design baseline'}
            </p>
            {snapshot.baseline.approvalsStale ? (
              <p>Prior {snapshot.baseline.baseline?.intent ?? 'design'} approvals are stale.</p>
            ) : null}
            {snapshot.baseline.changesSinceBaseline.length > 0 ? (
              <ul
                aria-label={`Changes since ${snapshot.baseline.baseline?.intent ?? 'design'} baseline`}
              >
                {snapshot.baseline.changesSinceBaseline.map((change) => (
                  <li key={change.id}>{change.reason}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </aside>
      </div>
    </main>
  );
}
