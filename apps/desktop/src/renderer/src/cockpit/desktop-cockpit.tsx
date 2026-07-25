import { useRef, useState, type PointerEvent, type RefObject } from 'react';

import { PrototypeFlowCanvas } from '@selene/ui/prototype';

import type {
  AIChangeRequestInput,
  ArtifactPinInput,
  DesignerProgress,
  DesignerSnapshot,
  DeveloperAnnotationInput,
  ProjectOpenResult,
  SpatialTargetInput
} from '../../../shared/designer-api';
import { GuidedSetupPanel, type GuidedSetupActions } from './guided-setup-panel';
import { PreviewSurface, type PreviewBuild } from './preview-surface';

export interface DesktopCockpitActions {
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
  addArtifactPin(input: ArtifactPinInput): Promise<DesignerSnapshot>;
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
}

function targetAt(element: HTMLElement, clientX: number, clientY: number): SpatialTargetInput | undefined {
  const box = element.getBoundingClientRect();
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return undefined;
  return { x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)), viewport: { width: Math.round(box.width), height: Math.round(box.height) } };
}

/** The production renderer cockpit. Host authority arrives only through typed actions. */
export function DesktopCockpit({ snapshot, build, frame, onFrameLoad, onSnapshot, onRender, onProjectOpened, actions, guidedActions, progress }: DesktopCockpitProps) {
  const [instruction, setInstruction] = useState('Clarify the primary action.');
  const [annotation, setAnnotation] = useState('Preserve keyboard focus after this change.');
  const [target, setTarget] = useState<SpatialTargetInput>();
  const [targeting, setTargeting] = useState(false);
  const [selectedArtifactPinId, setSelectedArtifactPinId] = useState<string>();
  const [graphSaveStatus, setGraphSaveStatus] = useState('Saved graph is current.');
  const dragStart = useRef<SpatialTargetInput | undefined>(undefined);
  const selectedScenario = snapshot.scenarios.find((item) => item.id === snapshot.selectedScenarioId);
  const apply = (work: Promise<DesignerSnapshot>, message?: string) => void work.then(onSnapshot).then(() => message && setGraphSaveStatus(message)).catch((error: unknown) => setGraphSaveStatus(error instanceof Error ? error.message : 'Host operation failed.'));
  const saveGraph = (graph: DesignerSnapshot['editablePrototype']['graph']) => {
    if (snapshot.prototypeGraphHydration.state === 'recovery-required') return;
    setGraphSaveStatus('Saving graph revision…');
    apply(actions.savePrototypeGraph(graph), 'Saved graph revision.');
  };
  return (
    <div className="workspace-layout">
      <aside className="conversation-rail">
        <h2>AI change request</h2>
        <label>Configured agent<select aria-label="Configured agent" value={snapshot.selectedAgentId} onChange={(event) => void actions.selectAgent(event.currentTarget.value).then(onSnapshot)}>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label>
        <label>Instruction<textarea aria-label="AI change instruction" value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)} /></label>
        <button type="button" onClick={() => setTargeting((value) => !value)}>{targeting ? 'Targeting enabled: click or drag preview' : 'Target a point or region'}</button>
        <p>{target ? `Spatial AI target: ${(target.x * 100).toFixed(0)}%, ${(target.y * 100).toFixed(0)}%` : 'Select target mode to create an AI change request.'}</p>
        <button type="button" disabled={!target} onClick={() => { if (!target) return; void actions.requestAIChange({ agentId: snapshot.selectedAgentId, instruction, target }).then(async (next) => { onSnapshot(next); await onRender(next); }).catch(() => undefined); }}>Send targeted change</button>
        <button type="button" disabled={!target} onClick={() => { if (!target) return; void actions.addArtifactPin({ label: 'Pinned visual region', anchor: target }).then((next) => { onSnapshot(next); setSelectedArtifactPinId(next.artifactPins.at(-1)?.id); }); }}>Pin selected artifact region</button>
        {progress ? <p aria-live="polite">{progress.stage}: {progress.message}</p> : null}
        <h2>Developer handoff annotation</h2><textarea aria-label="Developer annotation" value={annotation} onChange={(event) => setAnnotation(event.currentTarget.value)} />
        <button type="button" onClick={() => apply(actions.addDeveloperAnnotation({ category: 'accessibility', body: annotation }))}>Add direction</button>
      </aside>
      <PreviewSurface build={build} revisionId={snapshot.source.revision.id} readiness={snapshot.baseline.readiness} frame={frame} onFrameLoad={onFrameLoad} targeting={targeting} target={target} onTargetPointerDown={(event: PointerEvent<HTMLButtonElement>) => { const start = targetAt(event.currentTarget, event.clientX, event.clientY); if (!start) return; event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = start; setTarget(start); }} onTargetPointerUp={(event: PointerEvent<HTMLButtonElement>) => { const start = dragStart.current; const end = targetAt(event.currentTarget, event.clientX, event.clientY); dragStart.current = undefined; if (start && end) { const right = Math.max(start.x, end.x); const bottom = Math.max(start.y, end.y); const region = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: right - Math.min(start.x, end.x), height: bottom - Math.min(start.y, end.y), viewport: start.viewport }; setTarget(region.width === 0 && region.height === 0 ? start : region); } setTargeting(false); }} onTargetPointerCancel={() => { dragStart.current = undefined; setTargeting(false); }} onTargetClick={(event: PointerEvent<HTMLButtonElement>) => { if (event.detail !== 0) return; const box = event.currentTarget.getBoundingClientRect(); setTarget(targetAt(event.currentTarget, box.left + box.width / 2, box.top + box.height / 2)); setTargeting(false); }} pins={snapshot.artifactPins} selectedPinId={selectedArtifactPinId} onSelectPin={setSelectedArtifactPinId} />
      <aside className="inspector">
        <section><h2>Saved prototype flow</h2><p>Revision {snapshot.editablePrototype.revision} is persisted by the local host.</p><p aria-live="polite">{graphSaveStatus}</p>
          {snapshot.prototypeGraphHydration.state === 'recovery-required' ? <section className="workspace-notice" role="alert"><p>{snapshot.prototypeGraphHydration.message}</p><p>Edits are read-only until the saved artifact is retried or explicitly recovered.</p><button type="button" onClick={() => apply(actions.retryPrototypeGraphHydration())}>Retry saved graph</button><button type="button" onClick={() => apply(actions.recoverPrototypeGraphFromFixture())}>Recover from fixture</button></section> : null}
          <button type="button" disabled={snapshot.prototypeGraphHydration.state === 'recovery-required'} onClick={() => apply(actions.setPrototypeMode(snapshot.editablePrototype.mode === 'edit' ? 'run' : 'edit'))}>{snapshot.editablePrototype.mode === 'edit' ? 'Run saved flow' : 'Edit saved flow'}</button>
          {snapshot.editablePrototype.mode === 'edit' ? <PrototypeFlowCanvas graph={snapshot.editablePrototype.graph} onGraphChange={snapshot.prototypeGraphHydration.state === 'recovery-required' ? undefined : saveGraph} readOnly={snapshot.prototypeGraphHydration.state === 'recovery-required'} /> : <div><p>Run mode is bound to the saved revision and cannot mutate ports or edges.</p><button type="button" onClick={() => apply(actions.resetPrototypeRun())}>Reset scenario</button>{snapshot.editablePrototype.runtime ? <PrototypeFlowCanvas graph={snapshot.editablePrototype.graph} activeNodeIds={[snapshot.editablePrototype.runtime.activeNodeId]} activeTransitionIds={snapshot.editablePrototype.runtime.activePathTransitionIds} readOnly /> : null}</div>}
        </section>
        <GuidedSetupPanel snapshot={snapshot} onSnapshot={onSnapshot} onProjectOpened={onProjectOpened} actions={guidedActions} />
        <section><h2>Accessible scenario inspector</h2><p>{selectedScenario?.title} · {selectedScenario?.state}</p><p>{selectedScenario?.navigation.map((step) => step.route).join(' → ')}</p></section>
        <section><h2>Persistent artifact pins</h2>{snapshot.artifactPins.map((pin) => <button key={pin.id} type="button" aria-pressed={selectedArtifactPinId === pin.id} onClick={() => setSelectedArtifactPinId(pin.id)}>{pin.label}: {Math.round(pin.anchor.x * 100)}%, {Math.round(pin.anchor.y * 100)}%</button>)}</section>
        <section><h2>Review threads</h2>{snapshot.reviewThreads.map((thread) => <p key={thread.id}>Open: {thread.body}</p>)}</section>
        <section><h2>Component catalog metadata</h2>{snapshot.componentCatalog.entries.map((entry) => <p key={entry.component}>{entry.component}</p>)}</section>
        <section><h2>Request history</h2>{snapshot.aiChangeRequests.map((request) => <p key={request.id}>{request.status}: {request.instruction}</p>)}</section>
        <section aria-label="Design baseline status"><h2>Design baseline</h2><p>{snapshot.baseline.readiness} / {snapshot.baseline.currency}</p><p>{snapshot.baseline.changesSinceBaseline.length} changes since {snapshot.baseline.baseline?.intent ?? 'design'} baseline</p>{snapshot.baseline.approvalsStale ? <p>Prior approvals are stale.</p> : null}</section>
      </aside>
    </div>
  );
}
