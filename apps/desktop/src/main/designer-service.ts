import {
  applyAgentSourcePatch,
  createGeneratedDesignHandoff,
  enterpriseScenarioFixtures,
  executeDesignBaselineCommand,
  parsePrototypeGraph,
  PrototypeRuntime,
  serializeGeneratedDesignHandoff,
  type AgentSourcePatch,
  type BaselineIntent,
  type DesignBaselineState,
  type EnterpriseScenario,
  type ReactSourceWorkspace
} from '@selene/core';

import {
  DESIGNER_API_VERSION,
  type DesignerAgentSummary,
  type DeveloperHandoffAnnotation,
  type DesignerProgress,
  type DesignerSnapshot,
  type AIChangeRequest,
  type ArtifactPin,
  type ReviewThread,
  type PrototypeFlowGraph,
  validateDeveloperAnnotation,
  validateAIChangeRequest,
  validateDesignerIdentifier,
  validateDesignerPublish,
  validatePrototypeRunAction,
  validateArtifactPin,
  validateReviewThread
} from '../shared/designer-api';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import {
  DeterministicLocalPublishAdapter,
  FixturePublishConsentPort,
  type GeneratedCodePublishPort,
  type PrototypeGraphPersistencePort,
  type TrustedPublishConsentPort
} from './designer-host-ports';

export interface DesignerAgentAdapter {
  readonly descriptor: DesignerAgentSummary;
  propose(input: {
    readonly instruction: string;
    readonly target: AIChangeRequest['target'];
    readonly workspace: ReactSourceWorkspace;
    readonly scenario: EnterpriseScenario;
    readonly signal: AbortSignal;
    readonly progress: (message: string) => void;
  }): Promise<AgentSourcePatch>;
}

export interface HandoffMetadataPort {
  load(): Promise<{
    readonly packageManager: string;
    readonly lockfile: { readonly path: string; readonly checksum: string };
    readonly packages: readonly { readonly name: string; readonly version: string }[];
    readonly dependencies: readonly { readonly name: string; readonly version: string }[];
  }>;
}

export class DesignerApplicationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DesignerApplicationError';
  }
}

interface PreviewScreenData {
  readonly id: string;
  readonly route: string;
  readonly title: string;
  readonly summary: string;
  readonly action: string;
  readonly actionPort: string;
  readonly nextScreenId: string;
}

/** Typed boundary for content that must remain data, never executable TSX. */
interface PreviewDataArtifact {
  readonly format: 'selene-desktop-preview-data/v1';
  readonly initialScreenId: string;
  readonly screens: readonly PreviewScreenData[];
}

const previewAppSource =
  "import {useEffect,useState} from 'react'; import './preview.css'; import data from './preview-data.json';\nexport default function App(){const [screenId,setScreenId]=useState(data.initialScreenId);useEffect(()=>{const onRuntime=(event)=>{const id=event.detail?.activeNodeId;if(typeof id==='string'&&data.screens.some(item=>item.id===id)){const next=data.screens.find(item=>item.id===id);window.history.replaceState({screen:id},'',next.route);setScreenId(id)}};window.addEventListener('selene-runtime-state',onRuntime);return()=>window.removeEventListener('selene-runtime-state',onRuntime)},[]);const screen=data.screens.find(item=>item.id===screenId)??data.screens[0];if(!screen)throw new Error('Preview data is missing a screen');return <main data-selene-node-id=\"designer.root\"><h1 data-selene-node-id=\"designer.title\">{screen.title}</h1><p data-selene-node-id=\"designer.summary\">{screen.summary}</p><button data-selene-node-id=\"designer.action\" data-selene-flow-node={screen.id} data-selene-action-port={screen.actionPort}>{screen.action}</button></main>}\n";

function serializePreviewData(data: PreviewDataArtifact): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function previewDataFor(
  instruction: string,
  scenario: {
    readonly state: string;
    readonly fixture: Pick<EnterpriseScenario['fixture'], 'heading' | 'summary'>;
  }
): string {
  return serializePreviewData({
    format: 'selene-desktop-preview-data/v1',
    initialScreenId: 'dashboard',
    screens: [
      {
        id: 'dashboard',
        route: '/',
        title: scenario.fixture.heading,
        summary: `${scenario.state}: ${scenario.fixture.summary}`,
        action: instruction,
        actionPort: 'open-orders',
        nextScreenId: 'orders'
      },
      {
        id: 'orders',
        route: '/orders',
        title: 'Orders',
        summary: 'Deterministic fixture: no orders need attention.',
        action: 'Back to dashboard',
        actionPort: 'back',
        nextScreenId: 'orders'
      }
    ]
  });
}

function initialWorkspace(): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId: 'desktop-designer',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: previewAppSource
      },
      {
        path: 'src/preview-data.json',
        language: 'json',
        content: previewDataFor('Open orders', {
          state: 'default',
          fixture: {
            heading: 'Dashboard',
            summary: 'Deterministic fixture: 12 orders need attention.'
          }
        })
      },
      {
        path: 'src/preview.css',
        language: 'css',
        content:
          'main{font-family:system-ui;padding:2rem;max-width:48rem}button{padding:.6rem 1rem}\n'
      }
    ],
    dependencies: ['react', 'react-dom', 'react-dom/client'],
    nodes: [
      { nodeId: 'designer.action', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.root', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.summary', path: 'src/App.tsx', exportName: 'default' },
      { nodeId: 'designer.title', path: 'src/App.tsx', exportName: 'default' }
    ],
    revision: {
      id: 'desktop-r1',
      createdAt: '2026-07-24T00:00:00.000Z',
      summary: 'Initial desktop designer source'
    }
  };
}

function initialBaseline(projectId: string): DesignBaselineState {
  return {
    projectId,
    readiness: 'draft',
    currency: 'none',
    changesSinceBaseline: [],
    approvalsStale: false
  };
}

function requestId(number: number): string {
  return `desktop-request-${number}`;
}

const prototypeFlow: PrototypeFlowGraph = {
  format: 'selene-prototype-flow/v1',
  nodes: [
    { id: 'dashboard', kind: 'screen', title: 'Dashboard', states: ['default'] },
    { id: 'orders', kind: 'screen', title: 'Orders', states: ['empty'] }
  ],
  connections: [
    {
      id: 'dashboard-to-orders',
      fromNodeId: 'dashboard',
      actionPort: 'designer.action',
      transition: { kind: 'navigate', toScreenId: 'orders' }
    }
  ]
};

const editablePrototype = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  project: { projectId: 'desktop-designer', owner: 'Desktop design' },
  revision: { id: 'desktop-flow-r1', createdAt: '2026-07-24T00:00:00.000Z', summary: 'Desktop flow' },
  handoff: { status: 'draft', owner: 'Desktop design', summary: 'Local editable product flow' },
  nodes: [
    { id: 'dashboard', kind: 'screen', label: 'Dashboard', route: '/', position: { x: 0, y: 0 }, ports: [{ id: 'open-orders', label: 'Open orders', trigger: 'click' }, { id: 'open-review', label: 'Review details', trigger: 'click' }] },
    { id: 'orders', kind: 'screen', label: 'Orders', route: '/orders', position: { x: 340, y: 0 }, ports: [{ id: 'back', label: 'Back', trigger: 'click' }] },
    { id: 'review-overlay', kind: 'overlay', label: 'Review details', dismissible: true, position: { x: 160, y: 260 }, ports: [{ id: 'dismiss', label: 'Dismiss', trigger: 'click' }] },
    { id: 'loading', kind: 'state', label: 'Loading', parentId: 'dashboard', position: { x: 0, y: 260 }, ports: [] }
  ],
  transitions: [
    { id: 'dashboard-orders', kind: 'navigate', from: { nodeId: 'dashboard', portId: 'open-orders' }, to: { nodeId: 'orders' } },
    { id: 'dashboard-review', kind: 'open-overlay', from: { nodeId: 'dashboard', portId: 'open-review' }, to: { nodeId: 'review-overlay' } },
    { id: 'orders-back', kind: 'back', from: { nodeId: 'orders', portId: 'back' } },
    { id: 'review-close', kind: 'close-overlay', from: { nodeId: 'review-overlay', portId: 'dismiss' }, to: { nodeId: 'review-overlay' } }
  ],
  scenarios: [{ id: 'desktop-review', name: 'Desktop review', startNodeId: 'dashboard', initialStateId: 'loading', expectedPath: ['dashboard', 'review-overlay'] }],
  fixtures: { owner: 'Desktop design' }
});

/**
 * Main-process application layer. It depends on agent and handoff ports, never
 * Electron, Vite, or a particular agent vendor, so it is directly testable.
 */
export class DesktopDesignerApplicationService {
  private readonly agents = new Map<string, DesignerAgentAdapter>();
  private readonly listeners = new Set<(event: DesignerProgress) => void>();
  private readonly reviewThreads: ReviewThread[] = [];
  private readonly artifactPins: ArtifactPin[] = [];
  private readonly aiChangeRequests: AIChangeRequest[] = [];
  private readonly developerAnnotations: DeveloperHandoffAnnotation[] = [
    {
      id: 'annotation-1',
      category: 'accessibility',
      body: 'Keep the primary action reachable by keyboard after source revisions.',
      nodeRef: 'designer.action',
      createdAt: '2026-07-24T00:00:00.000Z'
    }
  ];
  private readonly activity: string[] = ['Validated React workspace is ready for review.'];
  private source = initialWorkspace();
  private baseline = initialBaseline(this.source.projectId);
  private selectedAgentId: string | undefined;
  private selectedNodeId: string | undefined;
  private selectedScenarioId = enterpriseScenarioFixtures[0]?.id ?? '';
  private active: { readonly id: string; readonly controller: AbortController } | undefined;
  private sequence = 0;
  private readonly publishOperations = new Map<string, {
    readonly request: { readonly repository: string; readonly title: string; readonly consentId: string };
    readonly controller: AbortController;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    progress: readonly string[];
    receipt?: Awaited<ReturnType<GeneratedCodePublishPort['publish']>>;
    error?: { readonly code: string; readonly message: string };
  }>();
  private graph = editablePrototype;
  private graphMode: 'edit' | 'run' = 'edit';
  private graphRevision = 0;
  private prototypeRuntime: PrototypeRuntime | undefined;
  private graphHydration: DesignerSnapshot['prototypeGraphHydration'] = { state: 'missing' };

  public constructor(
    private readonly handoffMetadata: HandoffMetadataPort,
    private readonly diagnostics?: CrashDiagnosticSink,
    private readonly graphPersistence: PrototypeGraphPersistencePort,
    private readonly publisher: GeneratedCodePublishPort = new DeterministicLocalPublishAdapter(),
    private readonly publishConsent: TrustedPublishConsentPort = new FixturePublishConsentPort()
  ) {}

  /** Main-process composition can register any adapter implementing this narrow port. */
  public registerAgent(adapter: DesignerAgentAdapter): void {
    const id = validateDesignerIdentifier(adapter.descriptor.id, 'agent id');
    if (!adapter.descriptor.label.trim())
      throw new DesignerApplicationError('agent label is required');
    if (this.agents.has(id)) throw new DesignerApplicationError(`agent already registered: ${id}`);
    this.agents.set(id, adapter);
    this.selectedAgentId ??= id;
  }
  public async hydratePrototypeGraph(): Promise<DesignerSnapshot['prototypeGraphHydration']> {
    try {
      const saved = await this.graphPersistence.read(this.source.projectId);
      if (saved) {
        this.graph = saved.graph;
        this.graphRevision = saved.revision;
        this.graphHydration = { state: 'persisted' };
        this.activity.unshift(`Hydrated saved flow graph revision ${saved.revision}.`);
        return this.graphHydration;
      }
      this.graph = editablePrototype;
      this.graphRevision = 0;
      this.graphHydration = { state: 'missing' };
      this.activity.unshift('No saved flow graph exists; initialized the local fixture at revision 0.');
      return this.graphHydration;
    } catch (error) {
      this.graph = editablePrototype;
      this.graphRevision = 0;
      const message = error instanceof Error ? error.message : 'Saved graph could not be read.';
      this.graphHydration = { state: 'recovery-required', message };
      this.activity.unshift(`Saved flow graph needs recovery. ${message}`);
      return this.graphHydration;
    }
  }

  public subscribe(listener: (event: DesignerProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public snapshot(): DesignerSnapshot {
    if (this.selectedAgentId === undefined)
      throw new DesignerApplicationError('no agents are registered');
    return structuredClone({
      apiVersion: DESIGNER_API_VERSION,
      agents: [...this.agents.values()].map((agent) => agent.descriptor),
      selectedAgentId: this.selectedAgentId,
      source: this.source,
      nodes: this.source.nodes,
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      reviewThreads: [...this.reviewThreads],
      artifactPins: [...this.artifactPins],
      aiChangeRequests: [...this.aiChangeRequests],
      developerAnnotations: [...this.developerAnnotations],
      scenarios: enterpriseScenarioFixtures,
      selectedScenarioId: this.selectedScenarioId,
      baseline: this.baseline,
      prototype: { flow: prototypeFlow, currentScreenId: 'dashboard' },
      editablePrototype: { graph: this.graph, mode: this.graphMode, revision: this.graphRevision, ...(this.prototypeRuntime ? { runtime: this.prototypeRuntime.snapshot() } : {}) },
      prototypeGraphHydration: this.graphHydration,
      componentCatalog: { entries: [{ component: 'App', href: 'local://component-catalog/App' }] },
      activity: [...this.activity]
    });
  }

  public selectAgent(value: unknown): DesignerSnapshot {
    const id = validateDesignerIdentifier(value, 'agentId');
    if (!this.agents.has(id)) throw new DesignerApplicationError(`unknown agent: ${id}`);
    this.selectedAgentId = id;
    this.activity.unshift(`Selected ${id}.`);
    return this.snapshot();
  }

  public selectScenario(value: unknown): DesignerSnapshot {
    const id = validateDesignerIdentifier(value, 'scenarioId');
    if (!enterpriseScenarioFixtures.some((scenario) => scenario.id === id))
      throw new DesignerApplicationError(`unknown scenario: ${id}`);
    this.selectedScenarioId = id;
    this.activity.unshift(`Loaded scenario ${id}.`);
    return this.snapshot();
  }

  public selectNode(value: unknown): DesignerSnapshot {
    const nodeId = validateDesignerIdentifier(value, 'nodeId');
    if (!this.source.nodes.some((node) => node.nodeId === nodeId))
      throw new DesignerApplicationError(`unknown source node: ${nodeId}`);
    this.selectedNodeId = nodeId;
    return this.snapshot();
  }

  /** Renderer submits a complete portable graph; parsing rejects malformed ports and edges atomically. */
  public async savePrototypeGraph(value: unknown): Promise<DesignerSnapshot> {
    if (this.graphHydration.state === 'recovery-required')
      throw new DesignerApplicationError('Saved graph recovery is required before edits can be persisted.');
    const graph = parsePrototypeGraph(value);
    const saved = await this.graphPersistence.compareAndSwap(this.source.projectId, this.graphRevision, graph);
    this.graph = saved.graph;
    this.graphRevision = saved.revision;
    this.graphHydration = { state: 'persisted' };
    this.prototypeRuntime = undefined;
    this.activity.unshift(`Saved flow graph revision ${this.graphRevision}.`);
    return this.snapshot();
  }

  public async retryPrototypeGraphHydration(): Promise<DesignerSnapshot> {
    await this.hydratePrototypeGraph();
    return this.snapshot();
  }

  public async recoverPrototypeGraphFromFixture(): Promise<DesignerSnapshot> {
    if (this.graphHydration.state !== 'recovery-required')
      throw new DesignerApplicationError('No graph recovery is required.');
    const result = await this.graphPersistence.recoverFromFixture(this.source.projectId, editablePrototype);
    this.graph = result.saved.graph;
    this.graphRevision = result.saved.revision;
    this.prototypeRuntime = undefined;
    this.graphMode = 'edit';
    this.graphHydration = {
      state: 'persisted',
      recoveryReceipt: result.receipt
    };
    this.activity.unshift(`Recovered the fixture at revision ${result.saved.revision}; preserved ${result.receipt.recoveryId}.`);
    return this.snapshot();
  }

  public setPrototypeMode(value: unknown): DesignerSnapshot {
    if (value !== 'edit' && value !== 'run') throw new DesignerApplicationError('prototype mode is invalid');
    this.graphMode = value;
    this.prototypeRuntime = value === 'run' ? new PrototypeRuntime(this.graph) : undefined;
    this.activity.unshift(`${value === 'run' ? 'Running' : 'Editing'} the host-owned flow graph.`);
    return this.snapshot();
  }
  public runPrototypeAction(value: unknown): DesignerSnapshot {
    if (this.graphMode !== 'run' || !this.prototypeRuntime) throw new DesignerApplicationError('prototype is not in run mode');
    const action = validatePrototypeRunAction(value);
    this.prototypeRuntime.dispatch({ type: 'trigger', ...action });
    return this.snapshot();
  }
  public resetPrototypeRun(): DesignerSnapshot {
    if (this.graphMode !== 'run') throw new DesignerApplicationError('prototype is not in run mode');
    this.prototypeRuntime = new PrototypeRuntime(this.graph);
    return this.snapshot();
  }

  /** Capability/consent-gated adapter owns publication; renderer receives an immutable receipt only. */
  public requestGeneratedCodePublishConsent(value: unknown): Promise<{ readonly consentId: string }> {
    const candidate = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const request = validateDesignerPublish({ ...candidate, consentId: 'placeholder' });
    return this.publishConsent.request({ repository: request.repository, title: request.title, projectId: this.source.projectId, graphRevision: this.graphRevision, adapterKind: this.publisher.receiptKind });
  }

  public publishGeneratedCode(value: unknown): { readonly id: string; readonly status: 'running' } {
    const request = validateDesignerPublish(value);
    const id = `publish-${++this.sequence}`;
    const controller = new AbortController();
    const operation = { request, controller, status: 'running' as const, progress: ['Queued host-owned publish.'] };
    this.publishOperations.set(id, operation);
    void (async () => {
      try {
        await this.publishConsent.consume(request.consentId, { repository: request.repository, title: request.title, projectId: this.source.projectId, graphRevision: this.graphRevision, adapterKind: this.publisher.receiptKind });
        const receipt = await this.publisher.publish(
        { ...request, graphRevision: this.graphRevision, consent: { publishGeneratedCode: true, hostedReview: true } },
        { signal: controller.signal, progress: (message) => { operation.progress = [...operation.progress, message]; } }
      );
        operation.status = 'succeeded'; operation.receipt = receipt;
        this.activity.unshift(`${receipt.kind === 'remote' ? 'Remote publish' : 'Local preview'} receipt ${receipt.immutableId} is ready.`);
      } catch (error) {
        operation.status = controller.signal.aborted ? 'cancelled' : 'failed';
        const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN';
        operation.error = { code, message: error instanceof Error ? error.message : 'Publish failed.' };
      }
    })();
    return { id, status: 'running' };
  }

  public cancelGeneratedCodePublish(value: unknown): void {
    const id = validateDesignerIdentifier(value, 'publishId');
    const operation = this.publishOperations.get(id);
    if (operation?.status !== 'running') throw new DesignerApplicationError(`no active publish: ${id}`);
    operation.controller.abort();
  }
  public publishOperation(value: unknown) {
    const id = validateDesignerIdentifier(value, 'publishId');
    const operation = this.publishOperations.get(id);
    if (!operation) throw new DesignerApplicationError(`unknown publish: ${id}`);
    return structuredClone({ id, status: operation.status, progress: operation.progress, receipt: operation.receipt, error: operation.error });
  }

  /** Review threads are distinct deployed-artifact discussion data; node metadata is optional. */
  public addReviewThread(value: unknown): DesignerSnapshot {
    const discussion = validateReviewThread(value);
    if (
      discussion.anchor.nodeRef !== undefined &&
      !this.source.nodes.some((node) => node.nodeId === discussion.anchor.nodeRef)
    )
      throw new DesignerApplicationError(
        `discussion references unknown node: ${discussion.anchor.nodeRef}`
      );
    const scenario = enterpriseScenarioFixtures.find((item) => item.id === this.selectedScenarioId);
    if (scenario === undefined)
      throw new DesignerApplicationError('selected scenario is unavailable');
    this.reviewThreads.push({
      id: `review-${this.reviewThreads.length + 1}`,
      body: discussion.body,
      author: 'Desktop reviewer',
      createdAt: new Date().toISOString(),
      anchor: {
        ...discussion.anchor,
        artifactId: this.source.projectId,
        screenId: 'desktop-designer',
        scenarioId: scenario.id,
        state: scenario.state,
        revisionId: this.source.revision.id
      }
    });
    this.activity.unshift('Added a spatial discussion thread.');
    return this.snapshot();
  }
  public addArtifactPin(value: unknown): DesignerSnapshot {
    const input = validateArtifactPin(value);
    const scenario = enterpriseScenarioFixtures.find((item) => item.id === this.selectedScenarioId);
    if (!scenario) throw new DesignerApplicationError('selected scenario is unavailable');
    this.artifactPins.push({ id: `pin-${this.artifactPins.length + 1}`, label: input.label, createdAt: new Date().toISOString(), anchor: { ...input.anchor, artifactId: this.source.projectId, screenId: 'desktop-designer', scenarioId: scenario.id, state: scenario.state, revisionId: this.source.revision.id } });
    this.activity.unshift('Added an immutable spatial artifact pin.'); return this.snapshot();
  }

  /** Developer annotations are categorised handoff directions, distinct from discussion threads. */
  public addDeveloperAnnotation(value: unknown): DesignerSnapshot {
    const annotation = validateDeveloperAnnotation(value);
    if (
      annotation.nodeRef !== undefined &&
      !this.source.nodes.some((node) => node.nodeId === annotation.nodeRef)
    )
      throw new DesignerApplicationError(
        `annotation references unknown node: ${annotation.nodeRef}`
      );
    this.developerAnnotations.push({
      id: `annotation-${this.developerAnnotations.length + 1}`,
      ...annotation,
      createdAt: new Date().toISOString()
    });
    this.activity.unshift(`Added ${annotation.category} developer annotation.`);
    return this.snapshot();
  }

  /** Runs a local AI request through the selected adapter and records its complete lifecycle. */
  public async requestAIChange(value: unknown): Promise<DesignerSnapshot> {
    const input = validateAIChangeRequest(value);
    if (this.active !== undefined)
      throw new DesignerApplicationError('an agent request is already running');
    const adapter = this.agents.get(input.agentId);
    if (adapter === undefined)
      throw new DesignerApplicationError(`unknown agent: ${input.agentId}`);
    const scenario = enterpriseScenarioFixtures.find((item) => item.id === this.selectedScenarioId);
    if (scenario === undefined)
      throw new DesignerApplicationError('selected scenario is unavailable');
    const id = requestId(++this.sequence);
    const controller = new AbortController();
    this.active = { id, controller };
    const target = {
      ...input.target,
      artifactId: this.source.projectId,
      screenId: 'desktop-designer',
      scenarioId: scenario.id,
      state: scenario.state,
      revisionId: this.source.revision.id
    };
    this.aiChangeRequests.push({
      id,
      agentId: input.agentId,
      instruction: input.instruction,
      target,
      status: 'queued',
      createdAt: new Date().toISOString()
    });
    this.updateRequest(id, { status: 'running' });
    this.emit({
      requestId: id,
      agentId: input.agentId,
      stage: 'started',
      message: 'Agent request started.'
    });
    try {
      const patch = await adapter.propose({
        instruction: input.instruction,
        target,
        workspace: this.source,
        scenario,
        signal: controller.signal,
        progress: (message) =>
          this.emit({ requestId: id, agentId: input.agentId, stage: 'thinking', message })
      });
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: 'applying',
        message: 'Validating source patch.'
      });
      const previous = this.source;
      this.source = applyAgentSourcePatch(previous, patch, {
        id: `desktop-r${this.sequence + 1}`,
        createdAt: new Date().toISOString()
      });
      this.baseline = executeDesignBaselineCommand(this.baseline, {
        type: 'apply-design-mutation',
        change: {
          id: `design-change-${this.sequence}`,
          kind: 'source',
          beforeRevision: { id: previous.revision.id, fingerprint: previous.revision.id },
          currentRevision: { id: this.source.revision.id, fingerprint: this.source.revision.id },
          affected: {
            projectId: this.source.projectId,
            screenIds: ['desktop-designer'],
            routePaths: ['/'],
            scenarioIds: [scenario.id],
            componentIds: ['App'],
            stableNodeIds: this.source.nodes.map((node) => node.nodeId)
          },
          evidence: [{ description: `Validated desktop preview for ${scenario.title}.` }],
          provenance: { kind: 'agent', agentId: input.agentId, promptDigest: `local:${id}` },
          occurredAt: new Date().toISOString(),
          reason: patch.summary
        }
      });
      this.updateRequest(id, { status: 'applied', resultingRevisionId: this.source.revision.id });
      this.activity.unshift(`Applied ${this.source.revision.id}: ${patch.summary}`);
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: 'completed',
        message: 'Validated revision applied.'
      });
      return this.snapshot();
    } catch (error) {
      // The diagnostics boundary receives the hostile error object only to discard it.
      // Persisting diagnostic failures must never replace the original operation result.
      try {
        await this.diagnostics?.capture('service', 'operation-failure', error);
      } catch {
        // Local recovery remains available even when its optional persistence is unavailable.
      }
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.updateRequest(id, {
        status: cancelled ? 'cancelled' : 'failed',
        ...(cancelled
          ? {}
          : { error: error instanceof Error ? error.message : 'Agent request failed.' })
      });
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: cancelled ? 'cancelled' : 'error',
        message: cancelled
          ? 'Agent request cancelled.'
          : error instanceof Error
            ? error.message
            : 'Agent request failed.'
      });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  public cancel(value: unknown): void {
    const id = validateDesignerIdentifier(value, 'requestId');
    if (this.active?.id !== id) throw new DesignerApplicationError(`no active request: ${id}`);
    this.active.controller.abort();
  }

  public markReadyForReview(): DesignerSnapshot {
    return this.markReady('review');
  }

  public markReadyForHandoff(): DesignerSnapshot {
    return this.markReady('handoff');
  }

  /** A review and a developer handoff are distinct immutable design baselines. */
  private markReady(intent: BaselineIntent): DesignerSnapshot {
    this.baseline = executeDesignBaselineCommand(this.baseline, {
      type: 'mark-ready',
      intent,
      baseline: {
        id: `baseline-${intent}-${this.source.revision.id}`,
        projectId: this.source.projectId,
        revision: { id: this.source.revision.id, fingerprint: this.source.revision.id },
        intent,
        createdAt: new Date().toISOString(),
        createdBy: 'desktop-reviewer'
      }
    });
    this.activity.unshift(`Marked ${this.source.revision.id} ready for ${intent}.`);
    return this.snapshot();
  }

  public async exportHandoff(): Promise<string> {
    const metadata = await this.handoffMetadata.load();
    return serializeGeneratedDesignHandoff(
      createGeneratedDesignHandoff({
        workspace: this.source,
        baseline: this.baseline,
        comments: [],
        developerDirections: this.developerAnnotations.map(
          (annotation) => `[${annotation.category}] ${annotation.body}`
        ),
        reproducibility: metadata,
        project: {
          id: this.source.projectId,
          owner: 'desktop-design',
          status: this.baseline.readiness,
          routes: ['/'],
          storybook: [{ component: 'App', url: 'local://component-catalog/App' }],
          acceptanceCriteria: ['Render validated TSX', 'Preserve stable component-node metadata']
        },
        agentInstructions: ['Use the selected scenario and preserve stable node IDs.']
      })
    );
  }

  private emit(event: DesignerProgress): void {
    for (const listener of this.listeners) listener(event);
  }

  private updateRequest(
    id: string,
    updates: Pick<AIChangeRequest, 'status'> &
      Partial<Pick<AIChangeRequest, 'resultingRevisionId' | 'error'>>
  ): void {
    const index = this.aiChangeRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      const current = this.aiChangeRequests[index];
      if (current === undefined) return;
      this.aiChangeRequests[index] = {
        id: current.id,
        agentId: current.agentId,
        instruction: current.instruction,
        target: current.target,
        createdAt: current.createdAt,
        status: updates.status,
        ...(updates.resultingRevisionId === undefined
          ? current.resultingRevisionId === undefined
            ? {}
            : { resultingRevisionId: current.resultingRevisionId }
          : { resultingRevisionId: updates.resultingRevisionId }),
        ...(updates.error === undefined
          ? current.error === undefined
            ? {}
            : { error: current.error }
          : { error: updates.error })
      };
    }
  }
}

/** Deterministic adapter for local demos and tests; it uses the same service boundary as any custom adapter. */
export class DeterministicDesignerFixtureAdapter implements DesignerAgentAdapter {
  public readonly descriptor: DesignerAgentSummary = {
    id: 'fixture-designer',
    label: 'Deterministic fixture designer',
    capabilities: ['react.revise', 'scenario-aware']
  };

  public async propose(
    input: Parameters<DesignerAgentAdapter['propose']>[0]
  ): Promise<AgentSourcePatch> {
    input.progress(`Using ${input.scenario.title}.`);
    await Promise.resolve();
    if (input.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
    return {
      summary: `Fixture agent revised the design for ${input.scenario.id}.`,
      operations: [
        {
          type: 'write',
          path: 'src/App.tsx',
          content: previewAppSource
        },
        {
          type: 'write',
          path: 'src/preview-data.json',
          content: previewDataFor(input.instruction, input.scenario)
        }
      ]
    };
  }
}
