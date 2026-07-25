import { createHash } from 'node:crypto';

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
  parseSnapshot,
  serializeSnapshot,
  type AIChangeRequest as CollaborationAIChangeRequest,
  type CollaborationSnapshot,
  type DeveloperAnnotation as CollaborationDeveloperAnnotation,
  type ReviewThread as CollaborationReviewThread
} from '@selene/collaboration';

import {
  DESIGNER_API_VERSION,
  type DesignerAgentSummary,
  type DesignSystemIntakeReceipt,
  type MarkdownIntakeReceipt,
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
  validateReviewThread,
  validateReviewThreadResolution,
  validateReviewThreadReply
} from '../shared/designer-api';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import type { DesktopDesignSystemIntake } from './designer-setup-host';
import type { LocalDesignerState } from './project-lifecycle';
import {
  DeterministicLocalPublishAdapter,
  FixturePublishConsentPort,
  createImmutablePublishBundle,
  PublishAdapterRegistry,
  PrototypeGraphPersistenceError,
  type GeneratedCodePublishPort,
  type ImmutablePublishBundle,
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

/** The local lifecycle is the only desktop persistence authority for collaboration state. */
export interface DesignerProjectStatePort {
  designerState(projectId: string): Promise<LocalDesignerState | undefined>;
  saveDesignerState(projectId: string, state: LocalDesignerState): Promise<void>;
  commitDesignerRevision(projectId: string, workspace: ReactSourceWorkspace, state: LocalDesignerState): Promise<unknown>;
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

export function createInitialWorkspace(projectId = 'desktop-designer'): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId,
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
      id: `${projectId}-r1`,
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

const localCollaborationOrganizationId = 'local-desktop';
const localCollaborationActorId = 'desktop-reviewer';

function collaborationAnchor(
  anchor: DesignerSnapshot['reviewThreads'][number]['anchor'],
  revisionFingerprint: string
) {
  const target =
    anchor.width !== undefined && anchor.height !== undefined
      ? { kind: 'region' as const, region: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height } }
      : { kind: 'point' as const, point: { x: anchor.x, y: anchor.y } };
  return {
    evidence: {
      artifactId: anchor.artifactId,
      screenId: anchor.screenId,
      revisionId: anchor.revisionId,
      revisionFingerprint,
      viewport: { ...anchor.viewport, zoom: 1 },
      scenarioId: anchor.scenarioId,
      stateId: anchor.state,
      ...(anchor.nodeRef === undefined ? {} : { nodeId: anchor.nodeRef })
    },
    target,
    lifecycle: 'current' as const
  };
}

function desktopAnchor(anchor: CollaborationReviewThread['anchor']): DesignerSnapshot['reviewThreads'][number]['anchor'] {
  const target = anchor.target.kind === 'point'
    ? { x: anchor.target.point.x, y: anchor.target.point.y }
    : anchor.target.region;
  return {
    ...target,
    artifactId: anchor.evidence.artifactId,
    screenId: anchor.evidence.screenId,
    scenarioId: anchor.evidence.scenarioId ?? 'owner-loading-desktop',
    state: anchor.evidence.stateId ?? 'default',
    revisionId: anchor.evidence.revisionId,
    viewport: {
      width: anchor.evidence.viewport.width,
      height: anchor.evidence.viewport.height
    },
    ...(anchor.evidence.nodeId === undefined ? {} : { nodeRef: anchor.evidence.nodeId })
  };
}

function currentAnchor(source: ReactSourceWorkspace): DesignerSnapshot['reviewThreads'][number]['anchor'] {
  return {
    x: 0,
    y: 0,
    artifactId: source.projectId,
    screenId: 'desktop-designer',
    scenarioId: enterpriseScenarioFixtures[0]?.id ?? 'owner-loading-desktop',
    state: enterpriseScenarioFixtures[0]?.state ?? 'default',
    revisionId: source.revision.id,
    viewport: { width: 1, height: 1 },
    nodeRef: 'designer.root'
  };
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function serializeValidatedPatch(patch: AgentSourcePatch): string {
  return JSON.stringify({
    operations: patch.operations.map((operation) => operation.type === 'write'
      ? { type: 'write', path: operation.path, content: operation.content }
      : { type: 'delete', path: operation.path }),
    dependencies: [...(patch.dependencies ?? [])],
    nodeIdMapping: patch.nodeIdMapping === undefined ? [] : Object.entries(patch.nodeIdMapping).sort(([left], [right]) => left.localeCompare(right))
  });
}

function toCollaborationDesignReviewState(state: DesignBaselineState): NonNullable<CollaborationSnapshot['designReviewState']> {
  return { format: 'selene-design-review-state/v1', projectId: state.projectId, readiness: state.readiness, ...(state.baseline === undefined ? {} : { baseline: state.baseline }), currency: state.currency, approvalsStale: state.approvalsStale, changesSinceBaseline: state.changesSinceBaseline };
}

function fromCollaborationDesignReviewState(state: CollaborationSnapshot['designReviewState'] | undefined, projectId: string): DesignBaselineState {
  if (state === undefined) return initialBaseline(projectId);
  return { projectId: state.projectId, readiness: state.readiness, ...(state.baseline === undefined ? {} : { baseline: state.baseline }), currency: state.currency, approvalsStale: state.approvalsStale, changesSinceBaseline: state.changesSinceBaseline };
}

function createCollaborationSnapshot(source: ReactSourceWorkspace, baseline: DesignBaselineState): CollaborationSnapshot {
  return {
    format: 'selene-collaboration/v2',
    project: { id: source.projectId, organizationId: localCollaborationOrganizationId, name: source.projectId },
    revisions: [{ id: source.revision.id, projectId: source.projectId, sequence: 1, content: source, contentSha256: digest(source), scenarioIds: enterpriseScenarioFixtures.map((scenario) => scenario.id), createdBy: localCollaborationActorId, createdAt: source.revision.createdAt }],
    threads: [], comments: [], reactions: [], approvals: [], reviewThreads: [], aiChangeRequests: [], developerAnnotations: [],
    designReviewState: toCollaborationDesignReviewState(baseline)
  };
}

interface HydratedDesignerState {
  readonly baseline: DesignBaselineState;
  readonly reviewThreads: readonly ReviewThread[];
  readonly artifactPins: readonly ArtifactPin[];
  readonly aiChangeRequests: readonly AIChangeRequest[];
  readonly developerAnnotations: readonly DeveloperHandoffAnnotation[];
}

function projectRendererState(snapshot: CollaborationSnapshot): HydratedDesignerState {
  const reviewThreads: ReviewThread[] = snapshot.reviewThreads.map((thread) => {
    const [first, ...replies] = thread.messages;
    if (first === undefined) throw new DesignerApplicationError('Saved review thread has no opening message.');
    return {
      id: thread.id,
      status: thread.lifecycle,
      anchor: desktopAnchor(thread.anchor),
      body: first.body,
      replies: replies.map((reply) => ({ id: reply.id, body: reply.body, author: reply.createdBy, createdAt: reply.createdAt })),
      author: thread.createdBy,
      createdAt: thread.createdAt,
      ...(thread.resolvedAt === undefined ? {} : { resolvedAt: thread.resolvedAt })
    };
  });
  const aiChangeRequests: AIChangeRequest[] = snapshot.aiChangeRequests.map((request) => ({
    id: request.id,
    agentId: request.provider.providerId,
    instruction: request.instruction,
    target: desktopAnchor(request.anchor),
    status: request.lifecycle,
    createdAt: request.createdAt,
    ...(request.result === undefined ? {} : { resultingRevisionId: request.result.revisionId }),
    ...(request.failureReason === undefined ? {} : { error: request.failureReason })
  }));
  const developerAnnotations: DeveloperHandoffAnnotation[] = snapshot.developerAnnotations.map((annotation) => ({
    id: annotation.id,
    category: annotation.category === 'development' ? 'implementation' : annotation.category === 'interaction' ? 'behavior' : annotation.category === 'content' ? 'visual' : 'accessibility',
    body: annotation.body,
    ...(annotation.anchor.evidence.nodeId === undefined ? {} : { nodeRef: annotation.anchor.evidence.nodeId }),
    createdAt: annotation.createdAt
  }));
  const artifactPins: ArtifactPin[] = snapshot.reviewThreads.map((thread) => ({
    id: thread.id,
    label: thread.messages[0]?.body ?? 'Review anchor',
    anchor: desktopAnchor(thread.anchor),
    createdAt: thread.createdAt
  }));
  return {
    baseline: fromCollaborationDesignReviewState(snapshot.designReviewState, snapshot.project.id),
    reviewThreads,
    artifactPins,
    aiChangeRequests,
    developerAnnotations
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
  private source = createInitialWorkspace();
  private baseline = initialBaseline(this.source.projectId);
  /** Canonical collaboration data is retained verbatim; desktop arrays are projections only. */
  private collaboration = createCollaborationSnapshot(this.source, this.baseline);
  private selectedAgentId: string | undefined;
  private selectedNodeId: string | undefined;
  private selectedScenarioId = enterpriseScenarioFixtures[0]?.id ?? '';
  private active: { readonly id: string; readonly controller: AbortController } | undefined;
  private sequence = 0;
  private readonly publishOperations = new Map<string, {
    readonly request: { readonly repository?: string; readonly title: string; readonly mode: 'local-preview' | 'github-remote'; readonly consentId: string };
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
  private graphOperation: Promise<void> = Promise.resolve();
  private projectGeneration = 0;
  private readonly publishers: PublishAdapterRegistry;
  /** In-memory, versioned staging provenance for the currently open lifecycle workspace. */
  private designInputProvenance: {
    readonly format: 'selene-desktop-current-workspace-design-inputs/v1';
    readonly projectId: string;
    readonly designSystem?: DesignSystemIntakeReceipt;
    readonly designLanguage?: MarkdownIntakeReceipt;
  } = { format: 'selene-desktop-current-workspace-design-inputs/v1', projectId: this.source.projectId };

  public constructor(
    private readonly handoffMetadata: HandoffMetadataPort,
    private readonly diagnostics: CrashDiagnosticSink | undefined,
    private readonly graphPersistence: PrototypeGraphPersistencePort,
    private readonly setupIntake: DesktopDesignSystemIntake,
    publisher: GeneratedCodePublishPort | readonly GeneratedCodePublishPort[] = new DeterministicLocalPublishAdapter(),
    private readonly publishConsent: TrustedPublishConsentPort = new FixturePublishConsentPort(),
    private readonly projectState: DesignerProjectStatePort | undefined = undefined
  ) { this.publishers = new PublishAdapterRegistry(Array.isArray(publisher) ? publisher : [publisher]); }

  public inspectDesignSystem(value: unknown): Promise<DesignSystemIntakeReceipt> { return this.enqueueGraphOperation(async () => {
    const receipt = await this.setupIntake.inspectPackage(value);
    this.designInputProvenance = { ...this.designInputProvenance, projectId: this.source.projectId, designSystem: structuredClone(receipt) };
    return receipt;
  }); }
  public ingestDesignLanguage(value: unknown): Promise<MarkdownIntakeReceipt> { return this.enqueueGraphOperation(async () => {
    const receipt = await this.setupIntake.ingestMarkdown(value);
    this.designInputProvenance = { ...this.designInputProvenance, projectId: this.source.projectId, designLanguage: structuredClone(receipt) };
    return receipt;
  }); }

  /** Switch only at the host lifecycle boundary; renderers cannot choose a filesystem path. */
  private enqueueGraphOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.graphOperation.catch(() => undefined).then(operation);
    this.graphOperation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async persistProjectState(): Promise<void> {
    if (this.projectState === undefined) return;
    const projectId = this.source.projectId;
    const generation = this.projectGeneration;
    await this.projectState.saveDesignerState(projectId, {
      format: 'selene-local-designer-state/v1',
      version: 1,
      baseline: this.baseline,
      collaborationSnapshot: serializeSnapshot(this.collaboration)
    });
    if (this.projectGeneration !== generation || this.source.projectId !== projectId)
      throw new DesignerApplicationError('Project changed while its local collaboration state was being saved.');
  }

  private async persistAppliedRevision(): Promise<void> {
    if (this.projectState === undefined) return;
    await this.projectState.commitDesignerRevision(this.source.projectId, this.source, {
      format: 'selene-local-designer-state/v1', version: 1, baseline: this.baseline,
      collaborationSnapshot: serializeSnapshot(this.collaboration)
    });
  }

  /** User-visible success is withheld until the lifecycle's serialized durable commit succeeds. */
  private persistProjectStateSerialized(): Promise<void> {
    return this.enqueueGraphOperation(() => this.persistProjectState());
  }

  private async hydrateProjectState(projectId: string): Promise<void> {
    if (this.projectState === undefined) return;
    const stored = await this.projectState.designerState(projectId);
    if (stored === undefined) return;
    const snapshot = parseSnapshot(stored.collaborationSnapshot);
    if (snapshot.project.id !== projectId)
      throw new DesignerApplicationError('Saved collaboration state belongs to another project.');
    const latest = snapshot.revisions.reduce((current, revision) =>
      current === undefined || revision.sequence > current.sequence ? revision : current,
    undefined as CollaborationSnapshot['revisions'][number] | undefined);
    if (latest !== undefined && (latest.id !== this.source.revision.id || latest.contentSha256 !== digest(this.source)))
      throw new DesignerApplicationError('Saved collaboration revision does not match the lifecycle workspace.');
    this.collaboration = snapshot;
    const hydrated = projectRendererState(snapshot);
    this.baseline = hydrated.baseline;
    this.reviewThreads.splice(0, this.reviewThreads.length, ...hydrated.reviewThreads);
    this.artifactPins.splice(0, this.artifactPins.length, ...hydrated.artifactPins);
    this.aiChangeRequests.splice(0, this.aiChangeRequests.length, ...hydrated.aiChangeRequests);
    this.developerAnnotations.splice(0, this.developerAnnotations.length, ...hydrated.developerAnnotations);
  }

  private replaceCollaboration(snapshot: CollaborationSnapshot): void {
    this.collaboration = snapshot;
    this.baseline = fromCollaborationDesignReviewState(snapshot.designReviewState, this.source.projectId);
  }

  private appendCanonicalReview(thread: ReviewThread): void {
    const canonical: CollaborationReviewThread = {
      id: thread.id, projectId: this.source.projectId, anchor: this.canonicalAnchor(thread.anchor),
      messages: [{ id: `${thread.id}:message`, body: thread.body, createdBy: thread.author, createdAt: thread.createdAt, mentionedUserIds: [], reactions: [], readBy: [] }],
      deepLink: `/projects/${encodeURIComponent(this.source.projectId)}/reviews/${encodeURIComponent(thread.id)}`,
      lifecycle: 'open', createdBy: thread.author, createdAt: thread.createdAt
    };
    this.replaceCollaboration({ ...this.collaboration, reviewThreads: [...this.collaboration.reviewThreads, canonical] });
  }

  private updateCanonicalBaseline(): void {
    this.replaceCollaboration({ ...this.collaboration, designReviewState: toCollaborationDesignReviewState(this.baseline) });
  }

  private canonicalAnchor(anchor: DesignerSnapshot['reviewThreads'][number]['anchor']) {
    const revision = this.collaboration.revisions.find((item) => item.id === anchor.revisionId);
    if (revision === undefined)
      throw new DesignerApplicationError('Collaboration anchor references a revision that is not retained.');
    return collaborationAnchor(anchor, revision.contentSha256);
  }

  private captureMutationState() {
    return {
      source: this.source, baseline: this.baseline, collaboration: this.collaboration,
      reviewThreads: [...this.reviewThreads], artifactPins: [...this.artifactPins],
      aiChangeRequests: [...this.aiChangeRequests], developerAnnotations: [...this.developerAnnotations],
      activity: [...this.activity], active: this.active
    };
  }

  private restoreMutationState(state: ReturnType<DesktopDesignerApplicationService['captureMutationState']>): void {
    this.source = state.source; this.baseline = state.baseline; this.collaboration = state.collaboration;
    this.reviewThreads.splice(0, this.reviewThreads.length, ...state.reviewThreads);
    this.artifactPins.splice(0, this.artifactPins.length, ...state.artifactPins);
    this.aiChangeRequests.splice(0, this.aiChangeRequests.length, ...state.aiChangeRequests);
    this.developerAnnotations.splice(0, this.developerAnnotations.length, ...state.developerAnnotations);
    this.activity.splice(0, this.activity.length, ...state.activity);
    this.active = state.active;
  }

  private async mutateDurably<T>(operation: () => Promise<T>): Promise<T> {
    const before = this.captureMutationState();
    try { return await operation(); } catch (error) { this.restoreMutationState(before); throw error; }
  }

  public openProjectWorkspace(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(async () => {
    try { validateReactSourceWorkspace(value as ReactSourceWorkspace); }
    catch { throw new DesignerApplicationError('Project workspace is invalid.'); }
    const workspace = structuredClone(value as ReactSourceWorkspace);
    if (this.active !== undefined)
      throw new DesignerApplicationError('Cancel the active agent request before switching projects.');
    if (this.graphHydration.state === 'recovery-required')
      throw new DesignerApplicationError('Resolve the current graph recovery before opening another project.');
    const prior = {
      source: this.source, collaboration: this.collaboration, baseline: this.baseline,
      reviewThreads: [...this.reviewThreads], artifactPins: [...this.artifactPins],
      aiChangeRequests: [...this.aiChangeRequests], developerAnnotations: [...this.developerAnnotations],
      selectedNodeId: this.selectedNodeId, selectedScenarioId: this.selectedScenarioId,
      graph: this.graph, graphRevision: this.graphRevision, graphHydration: this.graphHydration,
      graphMode: this.graphMode, prototypeRuntime: this.prototypeRuntime, generation: this.projectGeneration,
      designInputProvenance: this.designInputProvenance,
      activity: [...this.activity]
    };
    try {
    this.projectGeneration += 1;
    this.source = workspace;
    // Collaboration is project-scoped. Until the host persistence adapter hydrates a
    // project record, never carry pins, threads, AI history, or annotations across projects.
    this.reviewThreads.splice(0);
    this.artifactPins.splice(0);
    this.aiChangeRequests.splice(0);
    this.developerAnnotations.splice(0);
    this.baseline = initialBaseline(workspace.projectId);
    this.collaboration = createCollaborationSnapshot(workspace, this.baseline);
    this.designInputProvenance = { format: 'selene-desktop-current-workspace-design-inputs/v1', projectId: workspace.projectId };
    this.selectedNodeId = undefined;
    this.selectedScenarioId = enterpriseScenarioFixtures[0]?.id ?? '';
    this.graphMode = 'edit';
    this.prototypeRuntime = undefined;
    await this.hydrateProjectState(workspace.projectId);
    await this.hydratePrototypeGraphUnlocked();
    this.activity.unshift(`Opened lifecycle project ${workspace.projectId}.`);
    return this.snapshot();
    } catch (error) {
      this.source = prior.source; this.collaboration = prior.collaboration; this.baseline = prior.baseline;
      this.reviewThreads.splice(0, this.reviewThreads.length, ...prior.reviewThreads);
      this.artifactPins.splice(0, this.artifactPins.length, ...prior.artifactPins);
      this.aiChangeRequests.splice(0, this.aiChangeRequests.length, ...prior.aiChangeRequests);
      this.developerAnnotations.splice(0, this.developerAnnotations.length, ...prior.developerAnnotations);
      this.selectedNodeId = prior.selectedNodeId; this.selectedScenarioId = prior.selectedScenarioId;
      this.graph = prior.graph; this.graphRevision = prior.graphRevision; this.graphHydration = prior.graphHydration;
      this.graphMode = prior.graphMode; this.prototypeRuntime = prior.prototypeRuntime; this.projectGeneration = prior.generation;
      this.designInputProvenance = prior.designInputProvenance;
      this.activity.splice(0, this.activity.length, ...prior.activity);
      this.activity.unshift(`Project persistence recovery is required: ${error instanceof Error ? error.message : 'unknown error.'}`);
      throw error;
    }
  }); }

  /** Main-process composition can register any adapter implementing this narrow port. */
  public registerAgent(adapter: DesignerAgentAdapter): void {
    const id = validateDesignerIdentifier(adapter.descriptor.id, 'agent id');
    if (!adapter.descriptor.label.trim())
      throw new DesignerApplicationError('agent label is required');
    if (this.agents.has(id)) throw new DesignerApplicationError(`agent already registered: ${id}`);
    this.agents.set(id, adapter);
    this.selectedAgentId ??= id;
  }
  private async hydratePrototypeGraphUnlocked(): Promise<DesignerSnapshot['prototypeGraphHydration']> {
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
      this.graphHydration = {
        state: 'recovery-required',
        message,
        ...(error instanceof PrototypeGraphPersistenceError && typeof error.recoveryId === 'string'
          ? { recovery: { recoveryId: error.recoveryId } }
          : {})
      };
      this.activity.unshift(`Saved flow graph needs recovery. ${message}`);
      return this.graphHydration;
    }
  }

  public hydratePrototypeGraph(): Promise<DesignerSnapshot['prototypeGraphHydration']> {
    return this.enqueueGraphOperation(() => this.hydratePrototypeGraphUnlocked());
  }

  public subscribe(listener: (event: DesignerProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public snapshot(): DesignerSnapshot {
    if (this.selectedAgentId === undefined)
      throw new DesignerApplicationError('no agents are registered');
    const projected = projectRendererState(this.collaboration);
    return structuredClone({
      apiVersion: DESIGNER_API_VERSION,
      agents: [...this.agents.values()].map((agent) => agent.descriptor),
      selectedAgentId: this.selectedAgentId,
      source: this.source,
      nodes: this.source.nodes,
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      reviewThreads: projected.reviewThreads,
      artifactPins: projected.artifactPins,
      aiChangeRequests: projected.aiChangeRequests,
      developerAnnotations: projected.developerAnnotations,
      scenarios: enterpriseScenarioFixtures,
      selectedScenarioId: this.selectedScenarioId,
      baseline: projected.baseline,
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
  public savePrototypeGraph(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(async () => {
    if (this.graphHydration.state === 'recovery-required')
      throw new DesignerApplicationError('Saved graph recovery is required before edits can be persisted.');
    const graph = parsePrototypeGraph(value); const projectId = this.source.projectId; const revision = this.graphRevision; const generation = this.projectGeneration;
    const saved = await this.graphPersistence.compareAndSwap(projectId, revision, graph);
    if (this.projectGeneration !== generation || this.source.projectId !== projectId || this.graphRevision !== revision)
      throw new DesignerApplicationError('Saved graph belongs to a project that is no longer active.');
    this.graph = saved.graph;
    this.graphRevision = saved.revision;
    this.graphHydration = { state: 'persisted' };
    this.prototypeRuntime = undefined;
    this.activity.unshift(`Saved flow graph revision ${this.graphRevision}.`);
    return this.snapshot();
  }); }

  public retryPrototypeGraphHydration(): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(async () => {
    await this.hydratePrototypeGraphUnlocked();
    return this.snapshot();
  }); }

  public recoverPrototypeGraphFromFixture(): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(async () => {
    if (this.graphHydration.state !== 'recovery-required')
      throw new DesignerApplicationError('No graph recovery is required.');
    const result = await this.graphPersistence.recoverFromFixture(this.source.projectId, editablePrototype);
    this.graph = result.saved.graph;
    this.graphRevision = result.saved.revision;
    this.prototypeRuntime = undefined;
    this.graphMode = 'edit';
    this.graphHydration = {
      state: 'persisted',
      recovery: result.receipt
    };
    this.activity.unshift(`Recovered the fixture at revision ${result.saved.revision}; preserved ${result.receipt.recoveryId}.`);
    return this.snapshot();
  }); }

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
  private async captureImmutablePublishBundle(): Promise<ImmutablePublishBundle> {
    const metadata = await this.handoffMetadata.load();
    return createImmutablePublishBundle({
      projectId: this.source.projectId,
      source: this.source,
      prototype: { graph: this.graph, revision: this.graphRevision },
      scenarios: enterpriseScenarioFixtures,
      collaborationSnapshot: serializeSnapshot(this.collaboration),
      designInputProvenance: this.designInputProvenance,
      componentCatalog: { entries: [{ component: 'App', href: 'local://component-catalog/App' }] },
      packageProvenance: metadata
    });
  }
  private publishConsentBinding(request: { readonly repository?: string; readonly title: string; readonly mode: 'local-preview' | 'github-remote' }, bundle: ImmutablePublishBundle, adapter: GeneratedCodePublishPort) {
    return { repository: request.repository, title: request.title, projectId: bundle.projectId, sourceRevisionId: bundle.sourceRevisionId, graphRevision: bundle.graphRevision, bundleDigest: bundle.bundleDigest, mode: request.mode, adapterId: adapter.id } as const;
  }
  public requestGeneratedCodePublishConsent(value: unknown): Promise<{ readonly consentId: string }> {
    const candidate = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const request = validateDesignerPublish({ ...candidate, consentId: 'placeholder' });
    return this.enqueueGraphOperation(async () => {
      const adapter = this.publishers.select(request.mode);
      const bundle = await this.captureImmutablePublishBundle();
      return this.publishConsent.request(this.publishConsentBinding(request, bundle, adapter));
    });
  }

  public publishGeneratedCode(value: unknown): { readonly id: string; readonly status: 'running' } {
    const request = validateDesignerPublish(value);
    const id = `publish-${++this.sequence}`;
    const controller = new AbortController();
    const operation = { request, controller, status: 'running' as const, progress: ['Queued host-owned publish.'] };
    this.publishOperations.set(id, operation);
    void (async () => {
      try {
        const prepared = await this.enqueueGraphOperation(async () => {
          const adapter = this.publishers.select(request.mode);
          const bundle = await this.captureImmutablePublishBundle();
          await this.publishConsent.consume(request.consentId, this.publishConsentBinding(request, bundle, adapter));
          return { adapter, bundle };
        });
        const receipt = await prepared.adapter.publish(
          { repository: request.repository, title: request.title, mode: request.mode, bundle: prepared.bundle },
          { signal: controller.signal, progress: (message) => { operation.progress = [...operation.progress, message]; } }
        );
        operation.status = 'succeeded'; operation.receipt = receipt;
        this.activity.unshift(`${receipt.mode === 'github-remote' ? 'Remote publish' : 'Local immutable bundle'} ${receipt.immutableId} is available.`);
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
  public addReviewThread(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(() => this.mutateDurably(async () => {
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
      status: 'open',
      body: discussion.body,
      replies: [],
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
    this.appendCanonicalReview(this.reviewThreads.at(-1)!);
    await this.persistProjectState(); return this.snapshot();
  })); }
  /** Resolution is explicit and reversible; it never mutates an artifact pin or AI target. */
  public resolveReviewThread(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(() => this.mutateDurably(async () => {
    const request = validateReviewThreadResolution(value);
    const projectedThreads = projectRendererState(this.collaboration).reviewThreads;
    const index = projectedThreads.findIndex((thread) => thread.id === request.id);
    if (index < 0) throw new DesignerApplicationError(`unknown review thread: ${request.id}`);
    const thread = projectedThreads[index]!;
    if ((thread.status === 'resolved') === request.resolved) return this.snapshot();
    const { resolvedAt: _previousResolution, ...unresolvedThread } = thread;
    const nextThread = request.resolved
      ? { ...thread, status: 'resolved' as const, resolvedAt: new Date().toISOString() }
      : { ...unresolvedThread, status: 'open' as const };
    const canonical = this.collaboration.reviewThreads.find((item) => item.id === request.id);
    if (canonical !== undefined)
      this.replaceCollaboration({ ...this.collaboration, reviewThreads: this.collaboration.reviewThreads.map((item) => {
        if (item.id !== request.id) return item;
        if (request.resolved) return { ...item, lifecycle: 'resolved', resolvedAt: nextThread.resolvedAt!, resolvedBy: localCollaborationActorId };
        const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = item;
        return { ...open, lifecycle: 'open' };
      }) });
    this.activity.unshift(`${request.resolved ? 'Resolved' : 'Reopened'} spatial discussion ${request.id}.`);
    await this.persistProjectState(); return this.snapshot();
  })); }
  public replyToReviewThread(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(() => this.mutateDurably(async () => {
    const request = validateReviewThreadReply(value);
    const projectedThreads = projectRendererState(this.collaboration).reviewThreads;
    const index = projectedThreads.findIndex((thread) => thread.id === request.id);
    if (index < 0) throw new DesignerApplicationError(`unknown review thread: ${request.id}`);
    const thread = projectedThreads[index]!;
    if (thread.status === 'resolved') throw new DesignerApplicationError('Reopen the review thread before replying.');
    const reply = { id: `${thread.id}-reply-${thread.replies.length + 1}`, body: request.body, author: 'Desktop reviewer', createdAt: new Date().toISOString() };
    this.replaceCollaboration({ ...this.collaboration, reviewThreads: this.collaboration.reviewThreads.map((item) => item.id !== request.id ? item : { ...item, messages: [...item.messages, { id: reply.id, body: reply.body, createdBy: reply.author, createdAt: reply.createdAt, parentMessageId: item.messages[0]!.id, mentionedUserIds: [], reactions: [], readBy: [] }] }) });
    this.activity.unshift(`Replied to spatial discussion ${request.id}.`);
    await this.persistProjectState(); return this.snapshot();
  })); }
  /** Developer annotations are categorised handoff directions, distinct from discussion threads. */
  public addDeveloperAnnotation(value: unknown): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(() => this.mutateDurably(async () => {
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
    const saved = this.developerAnnotations.at(-1)!;
    const category = saved.category === 'implementation' ? 'development' : saved.category === 'behavior' ? 'interaction' : saved.category === 'visual' ? 'content' : 'accessibility';
    this.replaceCollaboration({ ...this.collaboration, developerAnnotations: [...this.collaboration.developerAnnotations, { id: saved.id, projectId: this.source.projectId, anchor: this.canonicalAnchor(currentAnchor(this.source)), category, body: saved.body, createdBy: localCollaborationActorId, createdAt: saved.createdAt }] });
    this.activity.unshift(`Added ${annotation.category} developer annotation.`);
    await this.persistProjectState(); return this.snapshot();
  })); }

  /** Runs a local AI request through the selected adapter and records its complete lifecycle. */
  public async requestAIChange(value: unknown): Promise<DesignerSnapshot> {
    const start = await this.enqueueGraphOperation(() => this.mutateDurably(async () => {
      const input = validateAIChangeRequest(value);
      if (this.active !== undefined)
        throw new DesignerApplicationError('an agent request is already running');
      const selected = this.agents.get(input.agentId);
      if (selected === undefined) throw new DesignerApplicationError(`unknown agent: ${input.agentId}`);
      const selectedScenario = enterpriseScenarioFixtures.find((item) => item.id === this.selectedScenarioId);
      if (selectedScenario === undefined) throw new DesignerApplicationError('selected scenario is unavailable');
      const id = requestId(++this.sequence); const controller = new AbortController();
      const projectId = this.source.projectId; const generation = this.projectGeneration; const sourceRevisionId = this.source.revision.id;
      const target = { ...input.target, artifactId: projectId, screenId: 'desktop-designer', scenarioId: selectedScenario.id, state: selectedScenario.state, revisionId: sourceRevisionId };
      this.active = { id, controller };
      const createdAt = new Date().toISOString();
      this.aiChangeRequests.push({ id, agentId: input.agentId, instruction: input.instruction, target, status: 'running', createdAt });
      this.replaceCollaboration({ ...this.collaboration, aiChangeRequests: [...this.collaboration.aiChangeRequests, { id, projectId, anchor: this.canonicalAnchor(target), instruction: input.instruction, provider: { providerId: input.agentId, capability: 'react.revise' }, baseRevision: { id: sourceRevisionId, fingerprint: digest(this.source) }, lifecycle: 'running', createdBy: localCollaborationActorId, createdAt, updatedAt: createdAt }] });
      await this.persistProjectState();
      return { input, adapter: selected, scenario: selectedScenario, id, controller, projectId, generation, sourceRevisionId, target };
    }));
    const { input, adapter, scenario, id, controller, projectId, generation, sourceRevisionId, target } = start;
    this.emit({
      requestId: id,
      agentId: input.agentId,
      stage: 'started',
      message: 'Agent request started.'
    });
    let appliedCommitFailed = false;
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
      if (this.projectGeneration !== generation || this.source.projectId !== projectId || this.source.revision.id !== sourceRevisionId)
        throw new DesignerApplicationError('Agent result belongs to a project that is no longer active.');
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: 'applying',
        message: 'Validating source patch.'
      });
      return await this.enqueueGraphOperation(() => this.mutateDurably(async () => {
      if (this.projectGeneration !== generation || this.source.projectId !== projectId || this.source.revision.id !== sourceRevisionId)
        throw new DesignerApplicationError('Agent result belongs to a project that is no longer active.');
      const beforeApply = this.captureMutationState();
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
          beforeRevision: { id: previous.revision.id, fingerprint: digest(previous) },
          currentRevision: { id: this.source.revision.id, fingerprint: digest(this.source) },
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
      const revision = { id: this.source.revision.id, projectId, sequence: this.collaboration.revisions.length + 1, parentRevisionId: previous.revision.id, content: this.source, contentSha256: digest(this.source), scenarioIds: enterpriseScenarioFixtures.map((item) => item.id), createdBy: input.agentId, createdAt: this.source.revision.createdAt };
      this.replaceCollaboration({ ...this.collaboration, revisions: [...this.collaboration.revisions, revision], designReviewState: toCollaborationDesignReviewState(this.baseline), aiChangeRequests: this.collaboration.aiChangeRequests.map((request) => request.id !== id ? request : { ...request, lifecycle: 'applied', updatedAt: this.source.revision.createdAt, result: { revisionId: revision.id, revisionFingerprint: revision.contentSha256, diff: serializeValidatedPatch(patch), completedAt: this.source.revision.createdAt } }) });
      this.updateRequest(id, { status: 'applied', resultingRevisionId: this.source.revision.id });
      try {
        await this.persistAppliedRevision();
      } catch (error) {
        appliedCommitFailed = true;
        this.restoreMutationState(beforeApply);
        throw error;
      }
      this.activity.unshift(`Applied ${this.source.revision.id}: ${patch.summary}`);
      this.emit({
        requestId: id,
        agentId: input.agentId,
        stage: 'completed',
        message: 'Validated revision applied.'
      });
      return this.snapshot();
      }));
    } catch (error) {
      if (appliedCommitFailed) throw error;
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
      this.replaceCollaboration({ ...this.collaboration, aiChangeRequests: this.collaboration.aiChangeRequests.map((request) => request.id !== id ? request : { ...request, lifecycle: cancelled ? 'cancelled' : 'failed', updatedAt: new Date().toISOString(), ...(cancelled ? {} : { failureReason: error instanceof Error ? error.message : 'Agent request failed.' }) }) });
      await this.persistProjectStateSerialized();
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

  public markReadyForReview(): Promise<DesignerSnapshot> {
    return this.markReady('review');
  }

  public markReadyForHandoff(): Promise<DesignerSnapshot> {
    return this.markReady('handoff');
  }

  /** A review and a developer handoff are distinct immutable design baselines. */
  private markReady(intent: BaselineIntent): Promise<DesignerSnapshot> { return this.enqueueGraphOperation(() => this.mutateDurably(async () => {
    this.baseline = executeDesignBaselineCommand(this.baseline, {
      type: 'mark-ready',
      intent,
      baseline: {
        id: `baseline-${intent}-${this.source.revision.id}`,
        projectId: this.source.projectId,
        revision: { id: this.source.revision.id, fingerprint: digest(this.source) },
        intent,
        createdAt: new Date().toISOString(),
        createdBy: 'desktop-reviewer'
      }
    });
    this.activity.unshift(`Marked ${this.source.revision.id} ready for ${intent}.`);
    this.updateCanonicalBaseline();
    await this.persistProjectState(); return this.snapshot();
  })); }

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
