import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

import { PrototypeFlowCanvas } from '@selene/ui/prototype';

import type {
  AIChangeRequestInput,
  ArtifactPinInput,
  DesignerProgress,
  DesignerSnapshot,
  DeveloperAnnotationInput,
  ProjectOpenResult,
  ReviewThreadInput,
  ReviewThreadReplyInput,
  ReviewThreadResolutionInput,
  SpatialTargetInput
} from '../../../shared/designer-api';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { PreviewSurface, type PreviewBuild } from './preview-surface';

export const inspectorTabs = ['inspect', 'flow', 'reviews', 'handoff', 'setup'] as const;
export type InspectorTab = (typeof inspectorTabs)[number];
const paneMinimum = 220;
const paneMaximum = 520;
function clampPane(value: number): number { return Math.min(paneMaximum, Math.max(paneMinimum, Math.round(value))); }

export interface DesktopCockpitActions {
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  addArtifactPin(input: ArtifactPinInput): Promise<DesignerSnapshot>;
  addReviewThread(input: ReviewThreadInput): Promise<DesignerSnapshot>;
  resolveReviewThread(input: ReviewThreadResolutionInput): Promise<DesignerSnapshot>;
  replyToReviewThread(input: ReviewThreadReplyInput): Promise<DesignerSnapshot>;
  addDeveloperAnnotation(input: DeveloperAnnotationInput): Promise<DesignerSnapshot>;
  savePrototypeGraph(graph: DesignerSnapshot['editablePrototype']['graph']): Promise<DesignerSnapshot>;
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
  readonly onProjectOpened: (opened: ProjectOpenResult) => Promise<void>;
  readonly actions: DesktopCockpitActions;
  readonly guidedActions: GuidedSetupActions;
  readonly progress?: DesignerProgress;
  /** Storybook and recovery surfaces can present an exact initial workstation state. */
  readonly initialLeftCollapsed?: boolean;
  readonly initialRightCollapsed?: boolean;
  readonly initialInspectorTab?: InspectorTab;
  readonly initialSelectedThreadId?: string;
}

function targetAt(element: HTMLElement, clientX: number, clientY: number): SpatialTargetInput | undefined {
  const box = element.getBoundingClientRect();
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return undefined;
  return { x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)), viewport: { width: Math.round(box.width), height: Math.round(box.height) } };
}

/** The production renderer cockpit. Host authority arrives only through typed actions. */
export function DesktopCockpit({ snapshot, build, frame, onFrameLoad, onSnapshot, onRender, onProjectOpened, actions, guidedActions, progress, initialLeftCollapsed = false, initialRightCollapsed = false, initialInspectorTab = 'inspect', initialSelectedThreadId }: DesktopCockpitProps) {
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [annotation, setAnnotation] = useState('Preserve keyboard focus after this change.');
  const [target, setTarget] = useState<SpatialTargetInput>();
  const [targeting, setTargeting] = useState(false);
  const [selectedArtifactPinId, setSelectedArtifactPinId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(initialSelectedThreadId);
  const [reviewBody, setReviewBody] = useState('Verify this spatial region.');
  const [replyBody, setReplyBody] = useState('Acknowledged; follow-up recorded.');
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');
  const [leftCollapsed, setLeftCollapsed] = useState(initialLeftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(initialRightCollapsed);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(initialInspectorTab);
  const [leftWidth, setLeftWidth] = useState(300);
  const [rightWidth, setRightWidth] = useState(340);
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);
  const resizing = useRef<'left' | 'right' | undefined>(undefined);
  const selectedScenario = snapshot.scenarios.find((item) => item.id === snapshot.selectedScenarioId);
  const selectedThread = snapshot.reviewThreads.find((thread) => thread.id === selectedThreadId);
  const selectArtifactPin = (id: string) => {
    setSelectedArtifactPinId(id);
    const pin = snapshot.artifactPins.find((item) => item.id === id);
    const thread = pin === undefined ? undefined : snapshot.reviewThreads.find((item) => item.anchor.revisionId === pin.anchor.revisionId && item.anchor.x === pin.anchor.x && item.anchor.y === pin.anchor.y);
    setSelectedThreadId(thread?.id);
  };
  const selectThread = (id: string) => {
    setSelectedThreadId(id);
    const thread = snapshot.reviewThreads.find((item) => item.id === id);
    const pin = thread === undefined ? undefined : snapshot.artifactPins.find((item) => item.anchor.revisionId === thread.anchor.revisionId && item.anchor.x === thread.anchor.x && item.anchor.y === thread.anchor.y);
    setSelectedArtifactPinId(pin?.id);
  };
  const beginResize = (side: 'left' | 'right') => (event: PointerEvent<HTMLDivElement>) => {
    if ((side === 'left' && leftCollapsed) || (side === 'right' && rightCollapsed)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = side;
  };
  const updateResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizing.current === 'left') setLeftWidth(clampPane(event.clientX));
    if (resizing.current === 'right') setRightWidth(clampPane(window.innerWidth - event.clientX));
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizing.current = undefined;
  };
  const resizeWithKeyboard = (side: 'left' | 'right') => (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
    if (delta === 0) return;
    event.preventDefault();
    if (side === 'left') setLeftWidth((value) => clampPane(value + delta));
    else setRightWidth((value) => clampPane(value - delta));
  };
  useEffect(() => () => { resizing.current = undefined; }, []);
  const apply = (work: Promise<DesignerSnapshot>, message?: string) => void work.then(onSnapshot).then(() => message && setGraphSaveStatus(message)).catch((error: unknown) => setGraphSaveStatus(error instanceof Error ? error.message : 'Host operation failed.'));
  const saveGraph = (graph: DesignerSnapshot['editablePrototype']['graph']) => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required') return;
    setGraphSaveStatus('Saving graph revision…');
    apply(actions.savePrototypeGraph(graph), 'Saved graph revision.');
  };
  return (
    <div className="workspace-layout" style={{ '--workspace-left-rail': `${leftWidth}px`, '--workspace-right-rail': `${rightWidth}px` } as CSSProperties} data-left-collapsed={leftCollapsed || undefined} data-right-collapsed={rightCollapsed || undefined}>
      <aside className="conversation-rail" aria-label="AI conversation">
        <button className="pane-toggle" type="button" aria-pressed={leftCollapsed} onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? 'Show AI rail' : 'Hide AI rail'}</button>
        {leftCollapsed ? null : <>
        <section className="conversation-history" aria-label="AI conversation history"><h2>AI conversation</h2><p className="agent-message"><span>AI</span>Use target mode to focus the next change on a preview region.</p>{snapshot.aiChangeRequests.length === 0 ? <p className="conversation-history__empty">No saved requests in this project yet.</p> : snapshot.aiChangeRequests.slice(-6).reverse().map((request) => <p className="conversation-history__item" key={request.id}><strong>{request.status}</strong>{request.instruction}</p>)}{progress ? <p aria-live="polite">{progress.stage}: {progress.message}</p> : null}</section>
        <section className="conversation-composer" aria-label="AI change composer"><label>Configured agent<select aria-label="Configured agent" value={snapshot.selectedAgentId} onChange={(event) => void actions.selectAgent(event.currentTarget.value).then(onSnapshot).catch((error: unknown) => setGraphSaveStatus(error instanceof Error ? error.message : 'Could not select agent.'))}>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label>
          <label>Instruction<textarea aria-label="AI change instruction" value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} /></label>
          <button type="button" onClick={() => setTargeting((value) => !value)}>{targeting ? 'Targeting enabled: click or drag preview' : 'Target a point or region'}</button>
          <p>{target ? `Spatial AI target: ${(target.x * 100).toFixed(0)}%, ${(target.y * 100).toFixed(0)}%` : 'Select target mode to create an AI change request.'}</p>
          <button type="button" disabled={!target} onClick={() => { if (!target) return; void actions.requestAIChange({ agentId: snapshot.selectedAgentId, instruction, target }).then(async (next) => { onSnapshot(next); await onRender(next); setGraphSaveStatus(`Applied ${next.source.revision.id}.`); }).catch((error: unknown) => setGraphSaveStatus(error instanceof Error ? error.message : 'AI request failed.')); }}>Send targeted change</button>
          <button type="button" disabled={!target} onClick={() => { if (!target) return; void actions.addArtifactPin({ label: 'Pinned visual region', anchor: target }).then((next) => { onSnapshot(next); const pin = next.artifactPins.at(-1); setSelectedArtifactPinId(pin?.id); const thread = pin === undefined ? undefined : next.reviewThreads.find((item) => item.anchor.revisionId === pin.anchor.revisionId && item.anchor.x === pin.anchor.x && item.anchor.y === pin.anchor.y); setSelectedThreadId(thread?.id); setGraphSaveStatus('Pinned artifact region.'); }).catch((error: unknown) => setGraphSaveStatus(error instanceof Error ? error.message : 'Could not pin artifact region.')); }}>Pin selected artifact region</button>
          <label>Review thread<textarea aria-label="Review thread body" value={reviewBody} onChange={(event) => setReviewBody(event.currentTarget.value)} /></label>
          <button type="button" disabled={!target} onClick={() => { if (!target) return; apply(actions.addReviewThread({ body: reviewBody, anchor: target })); }}>Add spatial review thread</button>
        </section>
        </>}
      </aside>
      <div className="workspace-pane-resizer" role="separator" aria-label="Resize AI conversation rail" aria-orientation="vertical" aria-valuemin={paneMinimum} aria-valuemax={paneMaximum} aria-valuenow={leftWidth} tabIndex={leftCollapsed ? -1 : 0} onPointerDown={beginResize('left')} onPointerMove={updateResize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={() => { resizing.current = undefined; }} onKeyDown={resizeWithKeyboard('left')} />
      <PreviewSurface build={build} revisionId={snapshot.source.revision.id} readiness={snapshot.baseline.readiness} frame={frame} onFrameLoad={onFrameLoad} targeting={targeting} target={target} onTargetPointerDown={(event: PointerEvent<HTMLButtonElement>) => { const start = targetAt(event.currentTarget, event.clientX, event.clientY); if (!start) return; event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = start; setTarget(start); }} onTargetPointerUp={(event: PointerEvent<HTMLButtonElement>) => { const start = dragStart.current; const end = targetAt(event.currentTarget, event.clientX, event.clientY); dragStart.current = undefined; if (start && end) { const right = Math.max(start.x, end.x); const bottom = Math.max(start.y, end.y); const region = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: right - Math.min(start.x, end.x), height: bottom - Math.min(start.y, end.y), viewport: start.viewport }; setTarget(region.width === 0 && region.height === 0 ? start : region); } setTargeting(false); }} onTargetPointerCancel={() => { dragStart.current = undefined; setTargeting(false); }} onTargetClick={(event: PointerEvent<HTMLButtonElement>) => { if (event.detail !== 0) return; const box = event.currentTarget.getBoundingClientRect(); setTarget(targetAt(event.currentTarget, box.left + box.width / 2, box.top + box.height / 2)); setTargeting(false); }} pins={snapshot.artifactPins} selectedPinId={selectedArtifactPinId} onSelectPin={selectArtifactPin} selectedThread={selectedThread} replyBody={replyBody} onReplyBodyChange={setReplyBody} onReplyThread={(id, body) => apply(actions.replyToReviewThread({ id, body }))} onResolveThread={(id, resolved) => apply(actions.resolveReviewThread({ id, resolved }))} onCloseThread={() => setSelectedThreadId(undefined)} />
      <div className="workspace-pane-resizer" role="separator" aria-label="Resize inspector rail" aria-orientation="vertical" aria-valuemin={paneMinimum} aria-valuemax={paneMaximum} aria-valuenow={rightWidth} tabIndex={rightCollapsed ? -1 : 0} onPointerDown={beginResize('right')} onPointerMove={updateResize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={() => { resizing.current = undefined; }} onKeyDown={resizeWithKeyboard('right')} />
      <aside className="inspector" aria-label="Progressive inspector">
        <button className="pane-toggle" type="button" aria-pressed={rightCollapsed} onClick={() => setRightCollapsed((value) => !value)}>{rightCollapsed ? 'Show inspector' : 'Hide inspector'}</button>
        {rightCollapsed ? null : <>
        <div className="inspector-tabs" role="tablist" aria-label="Workspace inspector">
          {inspectorTabs.map((tab) => <button key={tab} role="tab" type="button" aria-selected={inspectorTab === tab} aria-controls={`inspector-${tab}`} id={`inspector-tab-${tab}`} onClick={() => setInspectorTab(tab)}>{tab === 'inspect' ? 'Inspect' : tab[0]!.toUpperCase() + tab.slice(1)}</button>)}
        </div>
        {inspectorTab === 'inspect' ? <section id="inspector-inspect" role="tabpanel" aria-labelledby="inspector-tab-inspect"><h2>Selection</h2><p>{selectedScenario?.title} · {selectedScenario?.state}</p><p>{selectedScenario?.navigation.map((step) => step.route).join(' → ')}</p><h2>Design baseline</h2><p>{snapshot.baseline.readiness} / {snapshot.baseline.currency}</p><p>{snapshot.baseline.changesSinceBaseline.length} changes since {snapshot.baseline.baseline?.intent ?? 'design'} baseline</p>{snapshot.baseline.approvalsStale ? <p>Prior approvals are stale.</p> : null}<h2>Component catalog</h2>{snapshot.componentCatalog.entries.map((entry) => <p key={entry.component}>{entry.component}</p>)}</section> : null}
        {inspectorTab === 'flow' ? <section id="inspector-flow" role="tabpanel" aria-labelledby="inspector-tab-flow"><h2>Saved prototype flow</h2><p>Revision {snapshot.editablePrototype.revision} is persisted by the local host.</p><p aria-live="polite">{graphSaveStatus}</p>
          {snapshot.prototypeGraphHydration.state === 'recovery-required' ? <section className="workspace-notice" role="alert"><p>{snapshot.prototypeGraphHydration.message}</p>{snapshot.prototypeGraphHydration.recovery ? <p>Recovery receipt: {snapshot.prototypeGraphHydration.recovery.recoveryId} ({snapshot.prototypeGraphHydration.recovery.capturedBytes ?? 0} bytes preserved).</p> : null}<p>Edits are read-only until the saved artifact is retried or explicitly recovered.</p><button type="button" onClick={() => apply(actions.retryPrototypeGraphHydration())}>Retry saved graph</button><button type="button" onClick={() => apply(actions.recoverPrototypeGraphFromFixture())}>Recover from fixture</button></section> : null}
          <button type="button" disabled={snapshot.prototypeGraphHydration.state === 'recovery-required'} onClick={() => apply(actions.setPrototypeMode(snapshot.editablePrototype.mode === 'edit' ? 'run' : 'edit'))}>{snapshot.editablePrototype.mode === 'edit' ? 'Run saved flow' : 'Edit saved flow'}</button>
          {snapshot.editablePrototype.mode === 'edit' ? <PrototypeFlowCanvas graph={snapshot.editablePrototype.graph} onGraphChange={snapshot.prototypeGraphHydration.state === 'recovery-required' ? undefined : saveGraph} readOnly={snapshot.prototypeGraphHydration.state === 'recovery-required'} /> : <div><p>Run mode is bound to the saved revision and cannot mutate ports or edges.</p><button type="button" onClick={() => apply(actions.resetPrototypeRun())}>Reset scenario</button>{snapshot.editablePrototype.runtime ? <PrototypeFlowCanvas graph={snapshot.editablePrototype.graph} activeNodeIds={[snapshot.editablePrototype.runtime.activeNodeId]} activeTransitionIds={snapshot.editablePrototype.runtime.activePathTransitionIds} readOnly /> : null}</div>}
        </section> : null}
        {inspectorTab === 'reviews' ? <section id="inspector-reviews" role="tabpanel" aria-labelledby="inspector-tab-reviews"><h2>Spatial review threads</h2>{snapshot.reviewThreads.map((thread) => <button className="review-thread-row" key={thread.id} type="button" aria-pressed={selectedThreadId === thread.id} onClick={() => selectThread(thread.id)}><strong>{thread.status}</strong><span>{thread.body}</span><small>{thread.replies.length} replies</small></button>)}<h2>Artifact pins</h2>{snapshot.artifactPins.map((pin) => <button key={pin.id} type="button" aria-pressed={selectedArtifactPinId === pin.id} onClick={() => selectArtifactPin(pin.id)}>{pin.label}: {Math.round(pin.anchor.x * 100)}%, {Math.round(pin.anchor.y * 100)}%</button>)}</section> : null}
        {inspectorTab === 'handoff' ? <section id="inspector-handoff" role="tabpanel" aria-labelledby="inspector-tab-handoff"><h2>Developer handoff</h2><label>Add implementation direction<textarea aria-label="Developer annotation" value={annotation} onChange={(event) => setAnnotation(event.currentTarget.value)} /></label><button type="button" onClick={() => apply(actions.addDeveloperAnnotation({ category: 'accessibility', body: annotation }))}>Add direction</button>{snapshot.developerAnnotations.length === 0 ? <p>No handoff annotations yet.</p> : snapshot.developerAnnotations.map((item) => <p key={item.id}><strong>{item.category}</strong> · {item.body}</p>)}<h2>Request history</h2>{snapshot.aiChangeRequests.map((request) => <p key={request.id}>{request.status}: {request.instruction}</p>)}</section> : null}
        {inspectorTab === 'setup' ? <section id="inspector-setup" role="tabpanel" aria-labelledby="inspector-tab-setup"><GuidedSetupPanel snapshot={snapshot} onSnapshot={onSnapshot} onProjectOpened={onProjectOpened} actions={guidedActions} /></section> : null}
        </>}
      </aside>
    </div>
  );
}
