import { useEffect, useRef, useState } from 'react';

import { DesktopCockpit } from './cockpit/desktop-cockpit';
import { WorkspaceControls } from './cockpit/workspace-controls';
import { type PreviewRuntimeState, validatePreviewFrameMessage } from '../../shared/preview-channel';
import { assertDesignerApiVersion, type DesignerProgress, type DesignerSnapshot } from '../../shared/designer-api';

type BuildResult = Awaited<ReturnType<Window['selene']['preview']['build']>>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBuild(value: unknown): value is BuildResult {
  if (!record(value) || !record(value.policy) || typeof value.url !== 'string' || typeof value.revisionId !== 'string') return false;
  const policy = value.policy;
  if (policy.origin !== 'selene-preview://local' || typeof policy.nonce !== 'string' || typeof policy.maxMessageBytes !== 'number' || typeof policy.csp !== 'string') return false;
  try { const url = new URL(value.url); return url.protocol === 'selene-preview:' && url.hostname === 'local' && /^\/[A-Za-z0-9_-]{1,128}\/index\.html$/.test(url.pathname) && !url.search && !url.hash; }
  catch { return false; }
}

function runtimeState(snapshot: DesignerSnapshot): PreviewRuntimeState | undefined {
  const runtime = snapshot.editablePrototype.runtime;
  return runtime ? { activeNodeId: runtime.activeNodeId, ...(runtime.activeStateId ? { activeStateId: runtime.activeStateId } : {}), ...(runtime.activeOverlayId ? { activeOverlayId: runtime.activeOverlayId } : {}), activePathTransitionIds: runtime.activePathTransitionIds.slice(0, 256) } : undefined;
}

/** Electron orchestration only: all product visuals live in DesktopCockpit. */
export function App() {
  const [snapshot, setSnapshot] = useState<DesignerSnapshot>();
  const [build, setBuild] = useState<BuildResult>();
  const [notice, setNotice] = useState('Loading desktop designer…');
  const [progress, setProgress] = useState<DesignerProgress>();
  const [publishStatus, setPublishStatus] = useState('No publish operation started.');
  const [publishId, setPublishId] = useState<string>();
  const [repository, setRepository] = useState('owner/desktop-design');
  const [publishTitle, setPublishTitle] = useState('Review generated desktop flow');
  const frame = useRef<HTMLIFrameElement>(null);
  const framePort = useRef<MessagePort>();
  const graphSaveTail = useRef<Promise<void>>(Promise.resolve());

  async function render(next: DesignerSnapshot): Promise<void> {
    const result = await window.selene.preview.build(next.source);
    if (!validBuild(result)) throw new Error('Preview host returned an invalid preview build');
    setBuild(result);
  }

  useEffect(() => {
    try { assertDesignerApiVersion(window.selene.designer.apiVersion); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Designer API is incompatible.'); return; }
    void window.selene.designer.snapshot().then(async (next) => { assertDesignerApiVersion(next.apiVersion); setSnapshot(next); await render(next); setNotice('Validated local workspace ready.'); }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Designer failed to load.'));
    return window.selene.designer.onProgress((event) => setProgress(event));
  }, []);

  useEffect(() => {
    if (!publishId) return;
    const timer = window.setInterval(() => void window.selene.designer.generatedCodePublishOperation(publishId).then((operation) => {
      setPublishStatus(operation.receipt ? `${operation.receipt.kind}: ${operation.receipt.status} (${operation.receipt.immutableId})` : operation.error ? `${operation.error.code}: ${operation.error.message}` : operation.progress.at(-1) ?? 'Running host operation.');
      if (operation.status !== 'running') window.clearInterval(timer);
    }).catch(() => window.clearInterval(timer)), 350);
    return () => window.clearInterval(timer);
  }, [publishId]);

  useEffect(() => () => { framePort.current?.close(); framePort.current = undefined; }, [build?.revisionId]);

  useEffect(() => {
    const state = snapshot && build && framePort.current ? runtimeState(snapshot) : undefined;
    if (state && build && framePort.current) framePort.current.postMessage({ type: 'runtime-state', nonce: build.policy.nonce, origin: build.policy.origin, revisionId: build.revisionId, state });
  }, [build, snapshot]);

  function connectPreviewFrame(): void {
    if (!build || !frame.current?.contentWindow) return;
    framePort.current?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      if (framePort.current !== channel.port1) return;
      const message = validatePreviewFrameMessage(event.data, build.policy);
      if (!message || message.revisionId !== build.revisionId) return;
      window.selene.preview.postMessage(build.policy, message);
      if (message.type === 'select-node' && message.nodeId) void window.selene.designer.selectNode(message.nodeId).then(setSnapshot).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not select preview node.'));
      if (message.type === 'trigger-action' && message.nodeId && message.portId) void window.selene.designer.runPrototypeAction({ nodeId: message.nodeId, portId: message.portId }).then((next) => { setSnapshot(next); const state = runtimeState(next); if (state && framePort.current === channel.port1) channel.port1.postMessage({ type: 'runtime-state', nonce: build.policy.nonce, origin: build.policy.origin, revisionId: build.revisionId, state }); }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Preview action failed.'));
      if (message.type === 'runtime-error') setNotice(`Preview error: ${message.message ?? 'unknown error'}`);
      if (message.type === 'ready') { const state = snapshot ? runtimeState(snapshot) : undefined; if (state && framePort.current === channel.port1) channel.port1.postMessage({ type: 'runtime-state', nonce: build.policy.nonce, origin: build.policy.origin, revisionId: build.revisionId, state }); }
    };
    channel.port1.start();
    frame.current.contentWindow.postMessage({ type: 'selene-preview-init', nonce: build.policy.nonce, revisionId: build.revisionId }, build.policy.origin, [channel.port2]);
    framePort.current = channel.port1;
  }

  if (!snapshot) return <main className="designer-workspace">{notice}</main>;
  const savePrototypeGraph = (graph: DesignerSnapshot['editablePrototype']['graph']) => {
    const queued = graphSaveTail.current.catch(() => undefined).then(() => window.selene.designer.savePrototypeGraph(graph));
    graphSaveTail.current = queued.then(() => undefined, () => undefined);
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
  return <main className="designer-workspace" aria-label="Selene desktop designer">
    <header className="workspace-topbar"><div><span className="brand-mark">S</span><span className="project-kicker">Desktop production designer</span></div><div className="project-actions">
      <WorkspaceControls actions={{ render: () => render(snapshot), markReadyForReview: window.selene.designer.markReadyForReview, markReadyForHandoff: window.selene.designer.markReadyForHandoff, exportHandoff: window.selene.designer.exportHandoff, diagnostics: window.selene.diagnostics }} onSnapshot={setSnapshot} onStatus={setNotice} />
      <label>GitHub repository<input value={repository} onChange={(event) => setRepository(event.currentTarget.value)} /></label><label>Review title<input value={publishTitle} onChange={(event) => setPublishTitle(event.currentTarget.value)} /></label>
      <button type="button" onClick={() => void window.selene.designer.requestGeneratedCodePublishConsent({ repository, title: publishTitle }).then(({ consentId }) => window.selene.designer.publishGeneratedCode({ repository, title: publishTitle, consentId })).then((operation) => { setPublishId(operation.id); setPublishStatus('Host operation started; waiting for its immutable receipt.'); }).catch((error: unknown) => setPublishStatus(error instanceof Error ? error.message : 'Publish operation failed.'))}>Request hosted review</button>
      {publishId ? <button type="button" onClick={() => void window.selene.designer.cancelGeneratedCodePublish(publishId).then(() => setPublishStatus('Cancelling host publish operation…')).catch((error: unknown) => setPublishStatus(error instanceof Error ? error.message : 'Could not cancel publish operation.'))}>Cancel publish</button> : null}
    </div></header>
    <p className="workspace-notice" role="status">{notice}</p><p className="workspace-notice" aria-live="polite">{publishStatus}</p>
    <DesktopCockpit snapshot={snapshot} build={build} frame={frame} onFrameLoad={connectPreviewFrame} onSnapshot={setSnapshot} onRender={render} onProjectOpened={async (opened) => { setSnapshot(opened.snapshot); setBuild(undefined); await render(opened.snapshot); }} progress={progress} guidedActions={guidedActions} actions={{ selectAgent: window.selene.designer.selectAgent, requestAIChange: window.selene.designer.requestAIChange, addArtifactPin: window.selene.designer.addArtifactPin, addReviewThread: window.selene.designer.addReviewThread, resolveReviewThread: window.selene.designer.resolveReviewThread, replyToReviewThread: window.selene.designer.replyToReviewThread, addDeveloperAnnotation: window.selene.designer.addDeveloperAnnotation, savePrototypeGraph, retryPrototypeGraphHydration: window.selene.designer.retryPrototypeGraphHydration, recoverPrototypeGraphFromFixture: window.selene.designer.recoverPrototypeGraphFromFixture, setPrototypeMode: window.selene.designer.setPrototypeMode, resetPrototypeRun: window.selene.designer.resetPrototypeRun }} />
  </main>;
}
