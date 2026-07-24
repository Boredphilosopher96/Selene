/**
 * Immutable design-baseline bookkeeping. This is deliberately separate from
 * package/release changelogs: it describes the generated design a reviewer or
 * receiving developer is being asked to evaluate.
 */
export type DesignReadiness = 'draft' | 'ready-for-review' | 'ready-for-handoff';
export type BaselineIntent = 'review' | 'handoff';
export type BaselineCurrency = 'current' | 'stale' | 'none';
export type DesignChangeKind =
  'source' | 'design-system' | 'token' | 'template' | 'dependency' | 'visual';

/** Stable public error for hostile values at the portable baseline boundary. */
export class DesignBaselineError extends Error {
  public constructor(message = 'Design baseline input is invalid') {
    super(message);
    this.name = 'DesignBaselineError';
  }
}

const baselineBudgets = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxNodes: 10_000,
  maxDepth: 64,
  maxItems: 10_000,
  maxText: 1_000_000,
  maxIdentifier: 128,
  maxTimestamp: 64,
  maxUrl: 2_048,
  maxEvidence: 1_000,
  maxReferences: 1_000
});

/**
 * Retains only inert own data, rejecting proxies/accessors/cycles before the
 * pure baseline transitions inspect it. This module stays provider-free.
 */
function ownBaselineValue<T>(input: T): T {
  const encoder = new TextEncoder();
  const state = { bytes: 0, nodes: 0, active: new WeakSet<object>() };
  const fail = (): never => {
    throw new DesignBaselineError();
  };
  const addBytes = (bytes: number): void => {
    state.bytes += bytes;
    if (state.bytes > baselineBudgets.maxBytes) fail();
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > baselineBudgets.maxDepth) fail();
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail();
      addBytes(value === null ? 4 : typeof value === 'boolean' ? 5 : 24);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > baselineBudgets.maxText) fail();
      addBytes(encoder.encode(value).byteLength);
      return value;
    }
    if (value === null || typeof value !== 'object') fail();
    const objectValue = value as object;
    try {
      if (state.active.has(objectValue)) fail();
      state.active.add(objectValue);
      state.nodes += 1;
      if (state.nodes > baselineBudgets.maxNodes) fail();
      const isArray = Array.isArray(objectValue);
      const prototype = Object.getPrototypeOf(objectValue);
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        fail();
      const descriptors = Object.getOwnPropertyDescriptors(objectValue);
      const keys = Object.keys(descriptors);
      if (
        keys.length > baselineBudgets.maxItems ||
        Object.getOwnPropertySymbols(objectValue).length > 0
      )
        fail();
      if (isArray && keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))
        fail();
      const target: unknown[] | Record<string, unknown> = isArray ? [] : {};
      for (const key of keys) {
        if (key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
        const dataDescriptor = descriptor as PropertyDescriptor & { value: unknown };
        addBytes(encoder.encode(key).byteLength);
        Object.defineProperty(target, key, {
          value: visit(dataDescriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      const length = isArray ? descriptors.length?.value : undefined;
      if (isArray && (!Number.isSafeInteger(length) || target.length !== length)) fail();
      state.active.delete(objectValue);
      return Object.freeze(target);
    } catch (error) {
      if (error instanceof DesignBaselineError) throw error;
      fail();
    }
  };
  return visit(input, 0) as T;
}

function owned<T>(value: T, message = 'Design baseline input is invalid'): T {
  try {
    return ownBaselineValue(value);
  } catch {
    throw new DesignBaselineError(message);
  }
}

export interface DesignRevisionReference {
  readonly id: string;
  readonly fingerprint: string;
}

export interface DesignBaseline {
  readonly id: string;
  /** Immutable owner of this baseline and its pinned revision. */
  readonly projectId: string;
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
  /** State is scoped to exactly one generated-design project. */
  readonly projectId: string;
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
  /**
   * One host transaction boundary. A host can atomically include the state
   * write with its generated revision and/or the collaboration audit record.
   */
  commit(
    change: {
      readonly state: DesignBaselineState;
      readonly collaborationActivity?: {
        readonly type: string;
        readonly occurredAt: string;
        readonly actorId?: string;
      };
    },
    options?: { readonly signal?: AbortSignal }
  ): Promise<void>;
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > baselineBudgets.maxText)
    throw new DesignBaselineError(`${name} must not be empty`);
}

function unique(values: readonly string[], name: string): void {
  if (
    !Array.isArray(values) ||
    values.length > baselineBudgets.maxReferences ||
    !values.every(
      (value) => typeof value === 'string' && value.length <= baselineBudgets.maxIdentifier
    ) ||
    new Set(values).size !== values.length
  )
    throw new DesignBaselineError(`${name} must be unique`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DesignBaselineError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function verifyReference(reference: DesignRevisionReference, name: string): void {
  record(reference, name);
  requireText(reference.id, `${name}.id`);
  requireText(reference.fingerprint, `${name}.fingerprint`);
}

/** Validates an event before it can become a durable, developer-facing delta. */
export function validateSemanticDesignChange(change: SemanticDesignChange): void {
  change = owned(change);
  record(change, 'change');
  requireText(change.id, 'change.id');
  requireText(change.reason, 'change.reason');
  requireText(change.occurredAt, 'change.occurredAt');
  if (!validTimestamp(change.occurredAt))
    throw new DesignBaselineError('change.occurredAt must be ISO time');
  verifyReference(change.beforeRevision, 'change.beforeRevision');
  verifyReference(change.currentRevision, 'change.currentRevision');
  if (change.beforeRevision.id === change.currentRevision.id)
    throw new DesignBaselineError('design changes must advance the design revision');
  record(change.affected, 'change.affected');
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
  if (
    !Array.isArray(change.evidence) ||
    change.evidence.length === 0 ||
    change.evidence.length > baselineBudgets.maxEvidence
  )
    throw new DesignBaselineError('design changes require visual evidence');
  for (const evidence of change.evidence) {
    record(evidence, 'evidence');
    requireText(evidence.description, 'evidence.description');
    if (evidence.href !== undefined) {
      requireText(evidence.href, 'evidence.href');
      if (evidence.href.length > baselineBudgets.maxUrl)
        throw new DesignBaselineError('evidence.href is too long');
    }
    if (evidence.checksum !== undefined) requireText(evidence.checksum, 'evidence.checksum');
  }
  record(change.provenance, 'change.provenance');
  if (change.provenance.kind === 'actor')
    requireText(change.provenance.actorId, 'provenance.actorId');
  else {
    requireText(change.provenance.agentId, 'provenance.agentId');
    requireText(change.provenance.promptDigest, 'provenance.promptDigest');
  }
}

/** One portable baseline contract for core transitions and external read models. */
export function validateDesignBaselineState(state: DesignBaselineState): void {
  state = owned(state);
  record(state, 'state');
  requireText(state.projectId, 'state.projectId');
  if (
    state.readiness !== 'draft' &&
    state.readiness !== 'ready-for-review' &&
    state.readiness !== 'ready-for-handoff'
  )
    throw new DesignBaselineError('state.readiness is invalid');
  if (state.currency !== 'current' && state.currency !== 'stale' && state.currency !== 'none')
    throw new DesignBaselineError('state.currency is invalid');
  if (typeof state.approvalsStale !== 'boolean' || !Array.isArray(state.changesSinceBaseline))
    throw new DesignBaselineError('state is invalid');
  if (state.baseline === undefined) {
    if (
      state.readiness !== 'draft' ||
      state.currency !== 'none' ||
      state.approvalsStale ||
      state.changesSinceBaseline.length !== 0
    )
      throw new DesignBaselineError('draft state cannot contain baseline data');
    return;
  }
  record(state.baseline, 'state.baseline');
  if (state.baseline.projectId !== state.projectId)
    throw new DesignBaselineError('baseline must belong to the design baseline state project');
  verifyReference(state.baseline.revision, 'state.baseline.revision');
  requireText(state.baseline.id, 'state.baseline.id');
  requireText(state.baseline.createdBy, 'state.baseline.createdBy');
  if (!validTimestamp(state.baseline.createdAt))
    throw new DesignBaselineError('state.baseline.createdAt must be ISO time');
  if (state.baseline.intent !== 'review' && state.baseline.intent !== 'handoff')
    throw new DesignBaselineError('state.baseline.intent is invalid');
  if (
    (state.baseline.intent === 'review' && state.readiness !== 'ready-for-review') ||
    (state.baseline.intent === 'handoff' && state.readiness !== 'ready-for-handoff')
  )
    throw new DesignBaselineError('baseline intent must match readiness');
  if (
    (state.currency === 'current' &&
      (state.approvalsStale || state.changesSinceBaseline.length !== 0)) ||
    (state.currency === 'stale' &&
      (!state.approvalsStale || state.changesSinceBaseline.length === 0)) ||
    state.currency === 'none'
  )
    throw new DesignBaselineError('baseline currency and changelog are inconsistent');
  for (const change of state.changesSinceBaseline) {
    validateSemanticDesignChange(change);
    if (change.affected.projectId !== state.projectId)
      throw new DesignBaselineError(
        'design change must belong to the design baseline state project'
      );
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
  state = owned(state);
  baseline = owned(baseline);
  validateDesignBaselineState(state);
  record(baseline, 'baseline');
  requireText(state.projectId, 'state.projectId');
  verifyReference(baseline.revision, 'baseline.revision');
  requireText(baseline.id, 'baseline.id');
  requireText(baseline.projectId, 'baseline.projectId');
  if (baseline.projectId !== state.projectId)
    throw new DesignBaselineError('baseline must belong to the design baseline state project');
  requireText(baseline.createdBy, 'baseline.createdBy');
  if (!validTimestamp(baseline.createdAt))
    throw new DesignBaselineError('baseline.createdAt must be ISO time');
  if (baseline.intent !== intent)
    throw new DesignBaselineError('baseline intent must match readiness transition');
  return owned({
    baseline,
    state: {
      projectId: state.projectId,
      readiness: intent === 'review' ? 'ready-for-review' : 'ready-for-handoff',
      baseline,
      currency: 'current',
      changesSinceBaseline: [],
      approvalsStale: false
    }
  });
}

/** Records a design mutation and invalidates review/handoff approvals only when needed. */
export function recordDesignMutation(
  state: DesignBaselineState,
  change: SemanticDesignChange
): DesignBaselineState {
  state = owned(state);
  change = owned(change);
  validateDesignBaselineState(state);
  requireText(state.projectId, 'state.projectId');
  validateSemanticDesignChange(change);
  if (change.affected.projectId !== state.projectId)
    throw new DesignBaselineError('design change must belong to the design baseline state project');
  if (state.baseline !== undefined) {
    record(state.baseline, 'state.baseline');
    if (state.baseline.projectId !== state.projectId)
      throw new DesignBaselineError('baseline must belong to the design baseline state project');
  }
  if (state.baseline === undefined) {
    // A changelog is defined relative to an immutable baseline. Recording a
    // pre-baseline mutation would create an unactionable recheck entry and
    // conflicts with the portable review-state contract.
    return state;
  }
  return owned({
    ...state,
    currency: 'stale',
    changesSinceBaseline: [...state.changesSinceBaseline, change],
    approvalsStale: true
  });
}

/** Collaboration is still auditable, but comments/reactions must not dirty a design baseline. */
export function recordCollaborationActivity(
  state: DesignBaselineState,
  activity: { readonly type: string; readonly occurredAt: string; readonly actorId?: string }
): DesignBaselineState {
  state = owned(state);
  activity = owned(activity);
  validateDesignBaselineState(state);
  record(activity, 'activity');
  requireText(activity.type, 'activity.type');
  if (!validTimestamp(activity.occurredAt))
    throw new DesignBaselineError('activity.occurredAt must be ISO time');
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
  state = owned(state);
  command = owned(command);
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
  command: DesignBaselineCommand,
  options: { readonly signal?: AbortSignal } = {}
): Promise<DesignBaselineState> {
  state = owned(state);
  command = owned(command);
  const next = executeDesignBaselineCommand(state, command);
  try {
    if (options.signal?.aborted)
      throw new DesignBaselineError('Baseline persistence was cancelled');
    if (port === null || typeof port !== 'object' || typeof port.commit !== 'function')
      throw new DesignBaselineError('Baseline persistence port is invalid');
    await port.commit(
      {
        state: next,
        ...(command.type === 'record-collaboration-activity'
          ? { collaborationActivity: owned(command.activity) }
          : {})
      },
      options
    );
    if (options.signal?.aborted)
      throw new DesignBaselineError('Baseline persistence was cancelled');
    return next;
  } catch (error) {
    if (error instanceof DesignBaselineError) throw error;
    throw new DesignBaselineError('Baseline persistence failed');
  }
}

export interface DeveloperRecheckManifest {
  readonly projectId: string;
  readonly baselineId?: string;
  readonly currency: BaselineCurrency;
  readonly approvalsStale: boolean;
  readonly exactChangesToRecheck: readonly SemanticDesignChange[];
}

/** The minimal handoff/federation status a developer or agent can consume deterministically. */
export function createDeveloperRecheckManifest(
  state: DesignBaselineState
): DeveloperRecheckManifest {
  state = owned(state);
  validateDesignBaselineState(state);
  if (state.baseline !== undefined) record(state.baseline, 'state.baseline');
  return owned({
    projectId: state.projectId,
    ...(state.baseline === undefined ? {} : { baselineId: state.baseline.id }),
    currency: state.currency,
    approvalsStale: state.approvalsStale,
    exactChangesToRecheck: [...state.changesSinceBaseline]
  });
}

function validTimestamp(value: string): boolean {
  if (typeof value !== 'string' || value.length > baselineBudgets.maxTimestamp) return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}
