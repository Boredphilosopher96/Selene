/**
 * Immutable design-baseline bookkeeping. This is deliberately separate from
 * package/release changelogs: it describes the generated design a reviewer or
 * receiving developer is being asked to evaluate.
 */
export type DesignReadiness = 'draft' | 'ready-for-review' | 'ready-for-handoff';
export type BaselineIntent = 'review' | 'handoff';
export type BaselineCurrency = 'current' | 'stale' | 'none';
export type DesignChangeKind =
  | 'source'
  | 'design-system'
  | 'token'
  | 'template'
  | 'dependency'
  | 'visual';

export interface DesignRevisionReference {
  readonly id: string;
  readonly fingerprint: string;
}

export interface DesignBaseline {
  readonly id: string;
  readonly revision: DesignRevisionReference;
  readonly intent: BaselineIntent;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface DesignChangeScope {
  readonly projectId: string;
  readonly screenIds: readonly string[];
  readonly routePaths: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly componentIds: readonly string[];
  readonly stableNodeIds: readonly string[];
}

export interface VisualEvidence {
  readonly description: string;
  readonly href?: string;
  readonly checksum?: string;
}

export type DesignChangeProvenance =
  | { readonly kind: 'actor'; readonly actorId: string }
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      /** Store a digest/reference, never raw potentially sensitive prompt text. */
      readonly promptDigest: string;
    };

/** A generated-design delta a reviewer must explicitly reconsider. */
export interface SemanticDesignChange {
  readonly id: string;
  readonly kind: DesignChangeKind;
  readonly beforeRevision: DesignRevisionReference;
  readonly currentRevision: DesignRevisionReference;
  readonly affected: DesignChangeScope;
  readonly evidence: readonly VisualEvidence[];
  readonly provenance: DesignChangeProvenance;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface DesignBaselineState {
  readonly readiness: DesignReadiness;
  readonly baseline?: DesignBaseline;
  readonly currency: BaselineCurrency;
  /** Exact design deltas since `baseline`; never package release notes. */
  readonly changesSinceBaseline: readonly SemanticDesignChange[];
  /** A stale baseline requires explicit reviewer/handoff approval again. */
  readonly approvalsStale: boolean;
}

export interface DesignBaselineTransition {
  readonly state: DesignBaselineState;
  readonly baseline?: DesignBaseline;
}

export type DesignBaselineCommand =
  | {
      readonly type: 'mark-ready';
      readonly intent: BaselineIntent;
      readonly baseline: DesignBaseline;
    }
  | { readonly type: 'apply-design-mutation'; readonly change: SemanticDesignChange }
  | {
      readonly type: 'record-collaboration-activity';
      readonly activity: {
        readonly type: string;
        readonly occurredAt: string;
        readonly actorId?: string;
      };
    };

export interface DesignBaselineWorkflowPort {
  /** Hosts make this write transactional with their generated design revision. */
  save(state: DesignBaselineState): Promise<void>;
  /** Collaboration remains auditable even though it cannot dirty the design baseline. */
  appendCollaborationAudit(activity: {
    readonly type: string;
    readonly occurredAt: string;
    readonly actorId?: string;
  }): Promise<void>;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

function verifyReference(reference: DesignRevisionReference, name: string): void {
  requireText(reference.id, `${name}.id`);
  requireText(reference.fingerprint, `${name}.fingerprint`);
}

/** Validates an event before it can become a durable, developer-facing delta. */
export function validateSemanticDesignChange(change: SemanticDesignChange): void {
  requireText(change.id, 'change.id');
  requireText(change.reason, 'change.reason');
  requireText(change.occurredAt, 'change.occurredAt');
  if (Number.isNaN(Date.parse(change.occurredAt)))
    throw new Error('change.occurredAt must be ISO time');
  verifyReference(change.beforeRevision, 'change.beforeRevision');
  verifyReference(change.currentRevision, 'change.currentRevision');
  if (change.beforeRevision.id === change.currentRevision.id)
    throw new Error('design changes must advance the design revision');
  requireText(change.affected.projectId, 'change.affected.projectId');
  for (const [name, values] of Object.entries({
    screenIds: change.affected.screenIds,
    routePaths: change.affected.routePaths,
    scenarioIds: change.affected.scenarioIds,
    componentIds: change.affected.componentIds,
    stableNodeIds: change.affected.stableNodeIds
  })) {
    unique(values, `change.affected.${name}`);
  }
  if (change.evidence.length === 0) throw new Error('design changes require visual evidence');
  for (const evidence of change.evidence) requireText(evidence.description, 'evidence.description');
  if (change.provenance.kind === 'actor')
    requireText(change.provenance.actorId, 'provenance.actorId');
  else {
    requireText(change.provenance.agentId, 'provenance.agentId');
    requireText(change.provenance.promptDigest, 'provenance.promptDigest');
  }
}

/**
 * Marks a design ready and creates the immutable baseline in the same pure
 * transition. Hosts persist this returned value atomically with the revision.
 */
export function markDesignReady(
  state: DesignBaselineState,
  intent: BaselineIntent,
  baseline: DesignBaseline
): DesignBaselineTransition {
  verifyReference(baseline.revision, 'baseline.revision');
  requireText(baseline.id, 'baseline.id');
  requireText(baseline.createdBy, 'baseline.createdBy');
  if (Number.isNaN(Date.parse(baseline.createdAt)))
    throw new Error('baseline.createdAt must be ISO time');
  if (baseline.intent !== intent)
    throw new Error('baseline intent must match readiness transition');
  return {
    baseline,
    state: {
      readiness: intent === 'review' ? 'ready-for-review' : 'ready-for-handoff',
      baseline,
      currency: 'current',
      changesSinceBaseline: [],
      approvalsStale: false
    }
  };
}

/** Records a design mutation and invalidates review/handoff approvals only when needed. */
export function recordDesignMutation(
  state: DesignBaselineState,
  change: SemanticDesignChange
): DesignBaselineState {
  validateSemanticDesignChange(change);
  if (state.baseline === undefined) {
    return {
      ...state,
      currency: 'none',
      changesSinceBaseline: [...state.changesSinceBaseline, change]
    };
  }
  return {
    ...state,
    currency: 'stale',
    changesSinceBaseline: [...state.changesSinceBaseline, change],
    approvalsStale: true
  };
}

/** Collaboration is still auditable, but comments/reactions must not dirty a design baseline. */
export function recordCollaborationActivity(
  state: DesignBaselineState,
  activity: { readonly type: string; readonly occurredAt: string; readonly actorId?: string }
): DesignBaselineState {
  requireText(activity.type, 'activity.type');
  if (Number.isNaN(Date.parse(activity.occurredAt)))
    throw new Error('activity.occurredAt must be ISO time');
  return state;
}

/**
 * The one central command path for readiness and mutations. Callers cannot
 * separately forget a semantic design-changelog entry: every design mutation
 * uses `recordDesignMutation`, while collaboration is only audited.
 */
export function executeDesignBaselineCommand(
  state: DesignBaselineState,
  command: DesignBaselineCommand
): DesignBaselineState {
  switch (command.type) {
    case 'mark-ready':
      return markDesignReady(state, command.intent, command.baseline).state;
    case 'apply-design-mutation':
      return recordDesignMutation(state, command.change);
    case 'record-collaboration-activity':
      return recordCollaborationActivity(state, command.activity);
  }
}

/** An adapter boundary that persists the command result and audits collaboration in one host flow. */
export async function dispatchDesignBaselineCommand(
  port: DesignBaselineWorkflowPort,
  state: DesignBaselineState,
  command: DesignBaselineCommand
): Promise<DesignBaselineState> {
  const next = executeDesignBaselineCommand(state, command);
  await port.save(next);
  if (command.type === 'record-collaboration-activity')
    await port.appendCollaborationAudit(command.activity);
  return next;
}

export interface DeveloperRecheckManifest {
  readonly baselineId?: string;
  readonly currency: BaselineCurrency;
  readonly approvalsStale: boolean;
  readonly exactChangesToRecheck: readonly SemanticDesignChange[];
}

/** The minimal handoff/federation status a developer or agent can consume deterministically. */
export function createDeveloperRecheckManifest(
  state: DesignBaselineState
): DeveloperRecheckManifest {
  return {
    ...(state.baseline === undefined ? {} : { baselineId: state.baseline.id }),
    currency: state.currency,
    approvalsStale: state.approvalsStale,
    exactChangesToRecheck: [...state.changesSinceBaseline]
  };
}
