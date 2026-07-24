import { type PointerEvent, useEffect, useRef, useState } from 'react';

import type {
  DesignerProgress,
  DesignerSnapshot,
  SpatialTargetInput
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

function isFrameMessage(
  value: unknown,
  build: BuildResult
): value is {
  type: 'ready' | 'select-node' | 'rendered' | 'runtime-error';
  nonce: string;
  origin: string;
  revisionId: string;
  nodeId?: string;
  message?: string;
} {
  if (!isRecord(value)) return false;
  return (
    (value.type === 'ready' ||
      value.type === 'select-node' ||
      value.type === 'rendered' ||
      value.type === 'runtime-error') &&
    value.nonce === build.policy.nonce &&
    value.origin === build.policy.origin &&
    value.revisionId === build.revisionId &&
    (value.nodeId === undefined || typeof value.nodeId === 'string') &&
    (value.message === undefined || typeof value.message === 'string')
  );
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

function download(contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'selene-desktop.handoff.json';
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
  const frame = useRef<HTMLIFrameElement>(null);
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);

  async function render(next: DesignerSnapshot): Promise<void> {
    const result = await window.selene.preview.build(next.source);
    if (!isPreviewBuild(result)) throw new Error('Preview host returned an invalid preview build');
    setBuild(result);
  }

  useEffect(() => {
    void window.selene.designer
      .snapshot()
      .then(async (next) => {
        setSnapshot(next);
        await render(next);
        setNotice('Validated local workspace ready.');
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : 'Designer failed to load.')
      );
    return window.selene.designer.onProgress((event) => setProgress(event));
  }, []);

  useEffect(() => {
    if (build === undefined) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || !isFrameMessage(event.data, build))
        return;
      window.selene.preview.postMessage(build.policy, event.data);
      if (event.data.type === 'select-node' && event.data.nodeId !== undefined)
        void window.selene.designer
          .selectNode(event.data.nodeId)
          .then(setSnapshot)
          .catch(() => undefined);
      if (event.data.type === 'runtime-error')
        setNotice(`Preview error: ${event.data.message ?? 'unknown error'}`);
      if (event.data.type === 'ready')
        setNotice('Generated React preview rendered in a sandboxed frame.');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [build]);

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
                .then(download)
                .catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'Export failed.')
                )
            }
          >
            Export handoff
          </button>
        </div>
      </header>
      <p className="workspace-notice" role="status">
        {notice}
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
            <h2>Prototype flow graph</h2>
            {snapshot.prototype.flow.nodes.map((node) => (
              <p key={node.id}>
                {node.title} / {node.states.join(', ')}
              </p>
            ))}
            {snapshot.prototype.flow.connections.map((connection) => (
              <p className="node-id" key={connection.id}>
                {connection.actionPort} →{' '}
                {connection.transition.kind === 'navigate'
                  ? connection.transition.toScreenId
                  : connection.transition.kind}
              </p>
            ))}
            <small>
              Compiled action ports execute these typed transitions; this is not a component
              catalog.
            </small>
          </section>
          <section>
            <h2>Accessible scenario inspector</h2>
            <p>
              {selectedScenario?.title} · {selectedScenario?.state}
            </p>
            <p>{selectedScenario?.navigation.map((step) => step.route).join(' → ')}</p>
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
