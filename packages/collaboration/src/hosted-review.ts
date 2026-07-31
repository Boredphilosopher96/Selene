/**
 * Provider-neutral contracts for revision-bound hosted review. These values
 * are portable data only: an application owns authentication, persistence,
 * transport, retries, and any browser-local fallback.
 */
import {
  CollaborationBoundaryError,
  callCollaborationHostPort,
  ownCollaborationValue,
  type CollaborationHostContext
} from './boundary.js';
import type { ReviewThreadBinding } from './index.js';

export const hostedReviewFormat = 'selene-hosted-review/v1' as const;

export type HostedReviewBinding = ReviewThreadBinding;

export interface HostedReviewActor {
  readonly id: string;
  readonly displayName: string;
}

export interface HostedReviewPoint {
  readonly x: number;
  readonly y: number;
}

export interface HostedReviewRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HostedReviewAnchor {
  readonly selector: string;
  readonly component: string;
  readonly point: HostedReviewPoint;
  readonly region: HostedReviewRegion;
}

export interface HostedReviewReply {
  readonly id: string;
  readonly body: string;
  readonly actor: HostedReviewActor;
  readonly createdAt: string;
  readonly version: number;
}

export interface HostedReviewThread {
  readonly id: string;
  readonly binding: HostedReviewBinding;
  readonly anchor: HostedReviewAnchor;
  readonly replies: readonly HostedReviewReply[];
  readonly lifecycle: 'open' | 'resolved';
  readonly actor: HostedReviewActor;
  readonly createdAt: string;
  readonly version: number;
  readonly resolvedAt?: string;
  readonly resolvedBy?: HostedReviewActor;
}

export type HostedReviewOperation =
  | {
      readonly type: 'create';
      readonly binding: HostedReviewBinding;
      /** Unique idempotency key issued by the caller; the host records it. */
      readonly operationId: string;
      readonly threadId: string;
      readonly anchor: HostedReviewAnchor;
      readonly body: string;
      readonly expectedVersion: number;
    }
  | {
      readonly type: 'reply';
      readonly binding: HostedReviewBinding;
      readonly operationId: string;
      readonly threadId: string;
      readonly body: string;
      readonly expectedVersion: number;
    }
  | {
      readonly type: 'resolve' | 'reopen';
      readonly binding: HostedReviewBinding;
      readonly operationId: string;
      readonly threadId: string;
      readonly expectedVersion: number;
    };

export type HostedReviewProviderState =
  | {
      readonly provider: 'browser-local';
      readonly identity: 'local-only';
      readonly sync: 'offline';
    }
  | {
      readonly provider: 'hosted';
      readonly identity: 'verified' | 'unavailable';
      readonly sync: 'idle' | 'syncing' | 'error' | 'conflict' | 'offline';
      readonly message?: string;
    };

export type HostedReviewOperationResult =
  | { readonly ok: true; readonly thread: HostedReviewThread }
  | { readonly ok: false; readonly code: 'offline' | 'error' | 'forbidden' }
  | {
      readonly ok: false;
      readonly code: 'conflict';
      readonly currentVersion: number;
      readonly thread?: HostedReviewThread;
    };

/** A host-owned port. Renderer code cannot mint identity or claim a sync result. */
export interface HostedReviewProviderPort {
  state(
    binding: HostedReviewBinding,
    context?: CollaborationHostContext
  ): Promise<HostedReviewProviderState>;
  list(
    binding: HostedReviewBinding,
    context?: CollaborationHostContext
  ): Promise<readonly HostedReviewThread[]>;
  mutate(
    operation: HostedReviewOperation,
    context?: CollaborationHostContext
  ): Promise<HostedReviewOperationResult>;
}

const maxIdentifier = 128;
const maxText = 4_000;
const maxSelector = 512;
const maxReplies = 100;

function invalid(): never {
  throw new CollaborationBoundaryError('Hosted review contract is invalid');
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxIdentifier &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

function text(value: unknown, maximum = maxText): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function own<T>(value: T): T {
  try {
    return ownCollaborationValue(value);
  } catch {
    return invalid();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function validateHostedReviewBinding(binding: HostedReviewBinding): void {
  const safeBinding = own(binding) as unknown;
  if (
    !record(safeBinding) ||
    !exactKeys(safeBinding, [
      'tenantId',
      'projectId',
      'artifactId',
      'revisionId',
      'baselineId',
      'version'
    ])
  )
    invalid();
  binding = safeBinding as HostedReviewBinding;
  if (
    !identifier(binding.tenantId) ||
    !identifier(binding.projectId) ||
    !identifier(binding.artifactId) ||
    !identifier(binding.revisionId) ||
    !identifier(binding.baselineId) ||
    !version(binding.version)
  ) {
    invalid();
  }
}

export function validateHostedReviewActor(actor: HostedReviewActor): void {
  const safeActor = own(actor) as unknown;
  if (!record(safeActor)) invalid();
  actor = safeActor as HostedReviewActor;
  if (!identifier(actor.id) || !text(actor.displayName, 160)) invalid();
}

export function validateHostedReviewAnchor(anchor: HostedReviewAnchor): void {
  const safeAnchor = own(anchor) as unknown;
  if (!record(safeAnchor)) invalid();
  anchor = safeAnchor as HostedReviewAnchor;
  const { point, region } = anchor;
  if (
    !record(point) ||
    !record(region) ||
    !text(anchor.selector, maxSelector) ||
    !text(anchor.component, 160) ||
    !coordinate(point.x) ||
    !coordinate(point.y) ||
    !coordinate(region.x) ||
    !coordinate(region.y) ||
    !coordinate(region.width) ||
    !coordinate(region.height) ||
    region.x + region.width > 1 ||
    region.y + region.height > 1
  ) {
    invalid();
  }
}

export function validateHostedReviewOperation(operation: HostedReviewOperation): void {
  const safeOperation = own(operation) as unknown;
  if (!record(safeOperation)) invalid();
  operation = safeOperation as HostedReviewOperation;
  const expectedKeys =
    operation.type === 'create'
      ? ['type', 'binding', 'operationId', 'threadId', 'anchor', 'body', 'expectedVersion']
      : operation.type === 'reply'
        ? ['type', 'binding', 'operationId', 'threadId', 'body', 'expectedVersion']
        : operation.type === 'resolve' || operation.type === 'reopen'
          ? ['type', 'binding', 'operationId', 'threadId', 'expectedVersion']
          : undefined;
  if (expectedKeys === undefined || !exactKeys(safeOperation, expectedKeys)) invalid();
  validateHostedReviewBinding(operation.binding);
  if (
    !identifier(operation.operationId) ||
    !identifier(operation.threadId) ||
    !version(operation.expectedVersion)
  )
    invalid();
  if (operation.type === 'create') {
    validateHostedReviewAnchor(operation.anchor);
    if (!text(operation.body)) invalid();
  } else if (operation.type === 'reply' && !text(operation.body)) {
    invalid();
  }
}

export function validateHostedReviewProviderState(state: HostedReviewProviderState): void {
  const safeState = own(state) as unknown;
  if (!record(safeState)) invalid();
  state = safeState as HostedReviewProviderState;
  if (state.provider === 'browser-local') {
    if (state.identity !== 'local-only' || state.sync !== 'offline') invalid();
    return;
  }
  if (
    state.provider !== 'hosted' ||
    (state.identity !== 'verified' && state.identity !== 'unavailable') ||
    !['idle', 'syncing', 'error', 'conflict', 'offline'].includes(state.sync) ||
    (state.message !== undefined && !text(state.message, 512))
  ) {
    invalid();
  }
}

/**
 * Validates exact tenant/project/artifact/revision/baseline ownership before a
 * host may expose a provider result to a renderer. Discussion-only operations
 * do not accept or return design-baseline mutations.
 */
export function validateHostedReviewThread(
  thread: HostedReviewThread,
  binding: HostedReviewBinding
): void {
  const safeThread = own(thread) as unknown;
  const safeBinding = own(binding) as unknown;
  if (!record(safeThread) || !record(safeBinding)) invalid();
  thread = safeThread as HostedReviewThread;
  binding = safeBinding as HostedReviewBinding;
  validateHostedReviewBinding(binding);
  validateHostedReviewBinding(thread.binding);
  if (
    thread.binding.tenantId !== binding.tenantId ||
    thread.binding.projectId !== binding.projectId ||
    thread.binding.artifactId !== binding.artifactId ||
    thread.binding.revisionId !== binding.revisionId ||
    thread.binding.baselineId !== binding.baselineId ||
    thread.binding.version !== binding.version ||
    !identifier(thread.id) ||
    !version(thread.version) ||
    !timestamp(thread.createdAt) ||
    (thread.lifecycle !== 'open' && thread.lifecycle !== 'resolved') ||
    !Array.isArray(thread.replies) ||
    thread.replies.length === 0 ||
    thread.replies.length > maxReplies
  ) {
    invalid();
  }
  validateHostedReviewActor(thread.actor);
  validateHostedReviewAnchor(thread.anchor);
  for (const untrustedReply of thread.replies) {
    const safeReply = own(untrustedReply) as unknown;
    if (!record(safeReply)) invalid();
    const verifiedReply = safeReply as HostedReviewReply;
    if (
      !identifier(verifiedReply.id) ||
      !text(verifiedReply.body) ||
      !timestamp(verifiedReply.createdAt) ||
      !version(verifiedReply.version)
    )
      invalid();
    validateHostedReviewActor(verifiedReply.actor);
  }
  if (thread.lifecycle === 'resolved') {
    if (
      thread.resolvedAt === undefined ||
      thread.resolvedBy === undefined ||
      !timestamp(thread.resolvedAt)
    )
      invalid();
    validateHostedReviewActor(thread.resolvedBy);
  } else if (thread.resolvedAt !== undefined || thread.resolvedBy !== undefined) {
    invalid();
  }
}

/** A discussion event is auditable but never a design mutation or baseline delta. */
export function isDiscussionOnlyHostedReviewOperation(operation: HostedReviewOperation): boolean {
  validateHostedReviewOperation(operation);
  return true;
}

/** Reads an exact binding through the trusted host supervisor. */
export async function listHostedReviewThroughHost(
  context: CollaborationHostContext,
  provider: HostedReviewProviderPort,
  binding: HostedReviewBinding
): Promise<readonly HostedReviewThread[]> {
  validateHostedReviewBinding(binding);
  const threads = await callCollaborationHostPort<readonly HostedReviewThread[]>(
    context,
    provider,
    'list',
    [binding]
  );
  const safeThreads = own(threads) as unknown;
  if (!Array.isArray(safeThreads)) invalid();
  for (const thread of safeThreads)
    validateHostedReviewThread(thread as HostedReviewThread, binding);
  return safeThreads as readonly HostedReviewThread[];
}

/** Reads exact provider state through the same trusted host boundary as list/mutate. */
export async function stateHostedReviewThroughHost(
  context: CollaborationHostContext,
  provider: HostedReviewProviderPort,
  binding: HostedReviewBinding
): Promise<HostedReviewProviderState> {
  validateHostedReviewBinding(binding);
  const state = await callCollaborationHostPort<HostedReviewProviderState>(
    context,
    provider,
    'state',
    [binding]
  );
  const safeState = own(state) as HostedReviewProviderState;
  validateHostedReviewProviderState(safeState);
  return safeState;
}

/** Invokes one exact provider mutation through the trusted host supervisor. */
export async function mutateHostedReviewThroughHost(
  context: CollaborationHostContext,
  provider: HostedReviewProviderPort,
  operation: HostedReviewOperation
): Promise<HostedReviewOperationResult> {
  validateHostedReviewOperation(operation);
  const result = await callCollaborationHostPort<HostedReviewOperationResult>(
    context,
    provider,
    'mutate',
    [operation]
  );
  const safeResult = own(result) as unknown;
  if (!record(safeResult)) invalid();
  if (safeResult.ok === true) {
    if (!('thread' in safeResult)) invalid();
    validateHostedReviewThread(safeResult.thread as HostedReviewThread, operation.binding);
    return safeResult as HostedReviewOperationResult;
  }
  const code = safeResult.code;
  if (
    safeResult.ok !== false ||
    typeof code !== 'string' ||
    !['offline', 'error', 'conflict', 'forbidden'].includes(code)
  ) {
    invalid();
  }
  if (code === 'conflict') {
    if (!version(safeResult.currentVersion)) invalid();
    if (safeResult.thread !== undefined)
      validateHostedReviewThread(safeResult.thread as HostedReviewThread, operation.binding);
  }
  return safeResult as HostedReviewOperationResult;
}
