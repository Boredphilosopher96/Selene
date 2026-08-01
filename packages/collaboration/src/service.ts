import {
  collaborationFormat,
  collaborationBudgets,
  callCollaborationHostPort,
  clusterReviewThreads,
  ownCollaborationValue,
  type Approval,
  type AIChangeRequest,
  type AIChangeRequestLifecycle,
  type CollaborationRepository,
  type Comment,
  CollaborationError as PublicCollaborationError,
  type DesignReadinessInput,
  idempotent,
  isShareTokenHostFailure,
  parseSnapshot,
  type Project,
  type Reaction,
  type Revision,
  type ReviewThread,
  type ReviewThreadMutation,
  type ReviewThreadMutationResult,
  type SemanticDesignChangeInput,
  serializeSnapshot,
  createSignedShareToken,
  type CollaborationAction,
  type CollaborationHostContext,
  verifySignedShareToken,
  type SharePermission,
  type ShareTokenSigner,
  type Thread,
  type DeveloperAnnotation,
  type SpatialAnchor,
  type DesignReviewState,
  validateSpatialAnchor,
  validateReviewDeepLink
} from './index.js';
import { validateHostedReviewBinding, type HostedReviewBinding } from './hosted-review.js';

export interface ServiceClock {
  now(): string;
}

export interface ServiceIds {
  next(kind: string): string;
}

export interface AuthorizationRequest {
  readonly userId: string;
  readonly action: CollaborationAction;
  readonly organizationId?: string;
  readonly projectId?: string;
}

export interface CollaborationAuthorizer {
  authorize(request: AuthorizationRequest, context?: CollaborationHostContext): Promise<boolean>;
}

/**
 * Trusted deployment registry for published review artifacts. Implementations
 * resolve from host configuration or durable server state, never request data.
 */
export interface HostedReviewBindingResolver {
  resolve(projectId: string): Promise<HostedReviewBinding | undefined>;
}

export { roleAllows, type CollaborationAction } from './index.js';

export interface ServiceOptions {
  readonly repository: CollaborationRepository;
  readonly authorizer: CollaborationAuthorizer;
  readonly ids: ServiceIds;
  readonly clock?: ServiceClock;
  readonly allowedOrigins?: readonly string[];
  readonly maxRequestsPerMinute?: number;
  /** Limits JSON request bodies before parsing to bound memory use. */
  readonly maxRequestBodyBytes?: number;
  readonly maxSnapshotBytes?: number;
  /** Upper bound for one host adapter operation; cancellation reaches every port. */
  readonly maxHostOperationMs?: number;
  /** Trusted hosts supply a shared concrete effect supervisor through this package-owned port. */
  readonly hostContextFactory: import('./index.js').CollaborationHostContextFactory;
  /** Optional signer enables time-limited guest share URLs without a database dependency. */
  readonly shareSigner?: ShareTokenSigner;
  /** Enables the browser-cookie hosted-review path with a server-owned artifact binding. */
  readonly hostedReviewBindings?: HostedReviewBindingResolver;
}

interface Metrics {
  requests: number;
  rejected: number;
  errors: number;
}

const maxRequestListItems = 1_000;
const maxPortPrototypeDepth = 8;
const maxPortDescriptorReads = 512;
const maxAllowedOrigins = 128;
const maxRequestsPerMinute = 10_000;
const maxRequestBodyBytes = collaborationBudgets.maxBytes;
const maxSnapshotBytes = collaborationBudgets.maxBytes;
const maxHostOperationMs = 60_000;

/** Internal-only response errors; public CollaborationError instances are untrusted at HTTP edges. */
const ownedServiceErrors = new WeakSet<object>();
const ownedServiceUnavailableErrors = new WeakSet<object>();
class CollaborationError extends PublicCollaborationError {
  public constructor(
    code: ConstructorParameters<typeof PublicCollaborationError>[0],
    message: string
  ) {
    super(code, message);
    ownedServiceErrors.add(this);
  }
}
function isOwnedServiceError(value: unknown): value is CollaborationError {
  return typeof value === 'object' && value !== null && ownedServiceErrors.has(value);
}
class ServiceUnavailableError extends Error {
  public constructor() {
    super('Service unavailable');
    this.name = 'ServiceUnavailableError';
    ownedServiceUnavailableErrors.add(this);
  }
}
function serviceUnavailable(): ServiceUnavailableError {
  return new ServiceUnavailableError();
}
function isOwnedServiceUnavailableError(value: unknown): value is ServiceUnavailableError {
  return typeof value === 'object' && value !== null && ownedServiceUnavailableErrors.has(value);
}
const repositoryMethods = Object.freeze([
  'getProject',
  'getRevision',
  'getLatestRevision',
  'createProject',
  'appendRevision',
  'getDesignReviewState',
  'commitDesignRevision',
  'createReviewThread',
  'mutateReviewThread',
  'getReviewThread',
  'listReviewThreads',
  'appendReviewThreadMessage',
  'reactToReviewThreadMessage',
  'setReviewThreadMessageRead',
  'resolveReviewThread',
  'reopenReviewThread',
  'moveReviewThread',
  'createAIChangeRequest',
  'getAIChangeRequest',
  'listAIChangeRequests',
  'updateAIChangeRequest',
  'createDeveloperAnnotation',
  'listDeveloperAnnotations',
  'createThread',
  'getThread',
  'updateThreadResolution',
  'createComment',
  'getComment',
  'addReaction',
  'putApproval',
  'appendAudit',
  'appendEvent',
  'listEvents',
  'createShareLink',
  'getShareLink',
  'revokeShareLink',
  'exportProject',
  'replaceProject',
  'deleteProject',
  'getIdempotency',
  'putIdempotency'
] as const);

function captureContextSignal(value: unknown): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const invalid = () => new CollaborationError('INVALID', 'Host context factory is invalid');
  if (value === null || typeof value !== 'object') throw invalid();
  const source = value;
  const method = (name: string) => {
    const seen = new WeakSet<object>();
    let candidate: object | null = source;
    try {
      for (let depth = 0; candidate !== null && depth <= maxPortPrototypeDepth; depth += 1) {
        if (seen.has(candidate)) throw invalid();
        seen.add(candidate);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
        if (descriptor !== undefined) {
          if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw invalid();
          return descriptor.value;
        }
        candidate = Object.getPrototypeOf(candidate);
      }
    } catch (error) {
      if (isOwnedServiceError(error)) throw error;
      throw invalid();
    }
    throw invalid();
  };
  const aborted = () => {
    const seen = new WeakSet<object>();
    let candidate: object | null = source;
    try {
      for (let depth = 0; candidate !== null && depth <= maxPortPrototypeDepth; depth += 1) {
        if (seen.has(candidate)) throw invalid();
        seen.add(candidate);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, 'aborted');
        if (descriptor !== undefined) {
          const state =
            'value' in descriptor
              ? descriptor.value
              : typeof descriptor.get === 'function'
                ? Reflect.apply(descriptor.get, source, [])
                : undefined;
          if (typeof state !== 'boolean') throw invalid();
          return state;
        }
        candidate = Object.getPrototypeOf(candidate);
      }
    } catch (error) {
      if (isOwnedServiceError(error)) throw error;
      throw invalid();
    }
    throw invalid();
  };
  const add = method('addEventListener');
  const remove = method('removeEventListener');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let registrationAttempted = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (!registrationAttempted) return;
    try {
      Reflect.apply(remove, source, ['abort', cancel]);
    } catch {
      // Context cleanup is never allowed to expose caller-controlled failures.
    }
  };
  try {
    if (aborted()) cancel();
    else {
      // Some hostile implementations register the listener before throwing.
      // Mark the attempt first so the catch path always removes that callback.
      registrationAttempted = true;
      Reflect.apply(add, source, ['abort', cancel, { once: true }]);
    }
  } catch (error) {
    dispose();
    if (isOwnedServiceError(error)) throw error;
    throw invalid();
  }
  return Object.freeze({
    signal: controller.signal,
    dispose
  });
}

function captureHostContextFactory(
  factoryValue: unknown
): (request: {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}) => CollaborationHostContext {
  const invalidFactory = () => new CollaborationError('INVALID', 'Host context factory is invalid');
  const unavailable = (error: unknown) =>
    isOwnedServiceError(error) ? error : serviceUnavailable();
  const promise = <T>(value: unknown): Promise<T> => {
    try {
      return Promise.resolve(value as T).catch((error) => Promise.reject(unavailable(error)));
    } catch (error) {
      return Promise.reject(unavailable(error));
    }
  };
  const context = (value: unknown): CollaborationHostContext => {
    if (value === null || typeof value !== 'object') throw invalidFactory();
    try {
      const allowed = ['signal', 'run', 'runPort', 'dispose'] as const;
      const descriptor = (key: (typeof allowed)[number]) =>
        Object.getOwnPropertyDescriptor(value, key);
      const signalDescriptor = descriptor('signal');
      const runDescriptor = descriptor('run');
      const runPortDescriptor = descriptor('runPort');
      const disposeDescriptor = descriptor('dispose');
      if (
        !signalDescriptor ||
        !('value' in signalDescriptor) ||
        !runDescriptor ||
        !('value' in runDescriptor) ||
        !runPortDescriptor ||
        !('value' in runPortDescriptor) ||
        !disposeDescriptor ||
        !('value' in disposeDescriptor)
      )
        throw invalidFactory();
      const rawSignal = signalDescriptor.value;
      const run = runDescriptor.value;
      const runPort = runPortDescriptor.value;
      const dispose = disposeDescriptor.value;
      if (
        typeof run !== 'function' ||
        typeof runPort !== 'function' ||
        typeof dispose !== 'function'
      )
        throw invalidFactory();
      const capturedSignal = captureContextSignal(rawSignal);
      const target = value;
      const invoke = <T>(
        method: (...args: readonly unknown[]) => unknown,
        args: readonly unknown[]
      ) => {
        try {
          return promise<T>(Reflect.apply(method, target, args));
        } catch (error) {
          return Promise.reject(unavailable(error));
        }
      };
      let captured: CollaborationHostContext;
      captured = Object.freeze({
        signal: capturedSignal.signal,
        run: <T>(operation: (host: CollaborationHostContext) => Promise<T>) =>
          invoke<T>(run, [() => operation(captured)]),
        runPort: <T>(
          port: object,
          method: string,
          operation: (host: CollaborationHostContext) => Promise<T>
        ) => invoke<T>(runPort, [port, method, () => operation(captured)]),
        dispose: () => {
          capturedSignal.dispose();
          try {
            const result = Reflect.apply(dispose, target, []);
            promise<void>(result).catch(() => undefined);
          } catch {
            // Disposal runs after the response path. Keep hostile cleanup contained.
          }
        }
      }) as CollaborationHostContext;
      return captured;
    } catch {
      throw invalidFactory();
    }
  };
  if (factoryValue === null || typeof factoryValue !== 'object') throw invalidFactory();
  const factory = factoryValue;
  let create: PropertyDescriptor | undefined;
  try {
    create = Object.getOwnPropertyDescriptor(factory, 'create');
  } catch {
    throw invalidFactory();
  }
  if (!create || !('value' in create) || typeof create.value !== 'function') throw invalidFactory();
  const method = create.value;
  return (request) => {
    try {
      return context(Reflect.apply(method, factory, [request]));
    } catch {
      // The factory itself was structurally accepted at composition time; an
      // unusable per-request context is a host outage, not a client error.
      throw serviceUnavailable();
    }
  };
}

type CapturedServiceOptions = Readonly<{
  repository: CollaborationRepository;
  authorizer: CollaborationAuthorizer;
  ids: ServiceIds;
  clock: ServiceClock;
  allowedOrigins?: readonly string[];
  maximum: number;
  maximumBodyBytes: number;
  maximumSnapshotBytes: number;
  maximumHostOperationMs: number;
  hostContextFactory: unknown;
  shareSigner?: ShareTokenSigner;
  hostedReviewBindings?: HostedReviewBindingResolver;
}>;

function capturePort(value: unknown, names: readonly string[]): object {
  if (value === null || typeof value !== 'object')
    throw new CollaborationError('INVALID', 'Service options are invalid');
  const source = value;
  const copy = Object.create(null) as Record<string, unknown>;
  try {
    let reads = 0;
    for (const name of names) {
      const seen = new WeakSet<object>();
      let candidate: object | null = source;
      let method: ((...args: readonly unknown[]) => unknown) | undefined;
      while (candidate !== null && reads < maxPortDescriptorReads) {
        if (seen.has(candidate))
          throw new CollaborationError('INVALID', 'Service options are invalid');
        seen.add(candidate);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
        reads += 1;
        if (descriptor !== undefined) {
          if (!('value' in descriptor) || typeof descriptor.value !== 'function')
            throw new CollaborationError('INVALID', 'Service options are invalid');
          method = descriptor.value;
          break;
        }
        candidate = Object.getPrototypeOf(candidate);
      }
      if (!method || reads > maxPortDescriptorReads)
        throw new CollaborationError('INVALID', 'Service options are invalid');
      Object.defineProperty(copy, name, {
        value: (...args: readonly unknown[]) => Reflect.apply(method, source, args),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(copy);
  } catch (error) {
    if (isOwnedServiceError(error)) throw error;
    throw new CollaborationError('INVALID', 'Service options are invalid');
  }
}

function captureAllowedOrigins(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CollaborationError('INVALID', 'Service options are invalid');
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new CollaborationError('INVALID', 'Service options are invalid');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length =
      lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxAllowedOrigins)
      throw new CollaborationError('INVALID', 'Service options are invalid');
    const copied: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length > collaborationBudgets.maxUrl
      )
        throw new CollaborationError('INVALID', 'Service options are invalid');
      Object.defineProperty(copied, index, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(copied);
  } catch (error) {
    if (isOwnedServiceError(error)) throw error;
    throw new CollaborationError('INVALID', 'Service options are invalid');
  }
}

function captureServiceOptions(value: unknown): CapturedServiceOptions {
  if (value === null || typeof value !== 'object')
    throw new CollaborationError('INVALID', 'Service options are invalid');
  const allowed = new Set([
    'repository',
    'authorizer',
    'ids',
    'clock',
    'allowedOrigins',
    'maxRequestsPerMinute',
    'maxRequestBodyBytes',
    'maxSnapshotBytes',
    'maxHostOperationMs',
    'hostContextFactory',
    'shareSigner',
    'hostedReviewBindings'
  ]);
  const values = new Map<string, unknown>();
  try {
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor))
        throw new CollaborationError('INVALID', 'Service options are invalid');
      values.set(key, descriptor.value);
    }
  } catch (error) {
    if (isOwnedServiceError(error)) throw error;
    throw new CollaborationError('INVALID', 'Service options are invalid');
  }
  const get = (key: string) => values.get(key);
  const limit = (key: string, fallback: number, maximum: number) => {
    const candidate = get(key);
    if (candidate === undefined) return fallback;
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > maximum
    )
      throw new CollaborationError('INVALID', 'Service options are invalid');
    return candidate;
  };
  const allowedOrigins = captureAllowedOrigins(get('allowedOrigins'));
  const maximum = limit('maxRequestsPerMinute', 120, maxRequestsPerMinute);
  const maximumBodyBytes = limit('maxRequestBodyBytes', 1_048_576, maxRequestBodyBytes);
  const maximumSnapshotBytes = limit('maxSnapshotBytes', 10 * 1_024 * 1_024, maxSnapshotBytes);
  const maximumHostOperationMs = limit('maxHostOperationMs', 15_000, maxHostOperationMs);
  if (maximumBodyBytes > maximumSnapshotBytes)
    throw new CollaborationError('INVALID', 'Service options are invalid');
  const shareSigner = get('shareSigner');
  const hostedReviewBindings = get('hostedReviewBindings');
  return Object.freeze({
    repository: capturePort(get('repository'), repositoryMethods) as CollaborationRepository,
    authorizer: capturePort(get('authorizer'), ['authorize']) as CollaborationAuthorizer,
    ids: capturePort(get('ids'), ['next']) as ServiceIds,
    clock: capturePort(get('clock') ?? { now: () => new Date().toISOString() }, [
      'now'
    ]) as ServiceClock,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    maximum,
    maximumBodyBytes,
    maximumSnapshotBytes,
    maximumHostOperationMs,
    hostContextFactory: get('hostContextFactory'),
    ...(shareSigner === undefined
      ? {}
      : { shareSigner: capturePort(shareSigner, ['sign', 'verify', 'hash']) as ShareTokenSigner }),
    ...(hostedReviewBindings === undefined
      ? {}
      : {
          hostedReviewBindings: capturePort(hostedReviewBindings, [
            'resolve'
          ]) as HostedReviewBindingResolver
        })
  });
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function routeId(value: string): string {
  if (
    value.length > collaborationBudgets.maxIdentifier ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new CollaborationError('INVALID', 'Route identifier is invalid');
  return value;
}

function idFrom(pathname: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(pathname)?.[1];
  return value === undefined ? undefined : routeId(value);
}

function actor(request: Request): string {
  const value = request.headers.get('x-selene-user-id');
  if (
    !value ||
    value.length > collaborationBudgets.maxIdentifier ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new CollaborationError('FORBIDDEN', 'x-selene-user-id is required');
  return value;
}

/** Capture an injected time source once before a security decision uses it. */
function checkedTime(value: unknown): string {
  try {
    value = ownCollaborationValue(value);
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
      throw new Error('invalid time');
    return value;
  } catch {
    throw new CollaborationError('FORBIDDEN', 'Service time is unavailable');
  }
}

async function readSerialized(
  request: Request,
  maximumBytes: number,
  label: string
): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumBytes)
    throw new CollaborationError('INVALID', `${label} exceeds the maximum size`);
  if (request.body === null) return '';
  if (request.signal.aborted) throw new CollaborationError('INVALID', `${label} was cancelled`);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // A stream must be consumed serially so the byte limit can fail before buffering more input.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (request.signal.aborted) throw new CollaborationError('INVALID', `${label} was cancelled`);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes)
        throw new CollaborationError('INVALID', `${label} exceeds the maximum size`);
      if (chunks.length >= collaborationBudgets.maxItems)
        throw new CollaborationError('INVALID', `${label} has too many chunks`);
      chunks.push(value);
    }
  } finally {
    if (request.signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  const serialized = await readSerialized(request, maximumBytes, 'Request body');
  let value: unknown;
  try {
    value = ownCollaborationValue(JSON.parse(serialized));
  } catch {
    throw new CollaborationError('INVALID', 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CollaborationError('INVALID', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

async function readSnapshot(request: Request, maximumBytes: number) {
  const serialized = await readSerialized(request, maximumBytes, 'Collaboration import');
  return parseSnapshot(serialized);
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CollaborationError('INVALID', `${field} is required`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxRequestListItems ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new CollaborationError('INVALID', `${field} must be an array of strings`);
  }
  return value;
}

function uniqueStrings(value: unknown, field: string): readonly string[] {
  const items = strings(value, field);
  if (new Set(items).size !== items.length)
    throw new CollaborationError('INVALID', `${field} must not contain duplicates`);
  return items;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CollaborationError('INVALID', `${field} must be an object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new CollaborationError('INVALID', `${field} must be a number`);
  return value;
}

function reviewOperation(
  request: Request,
  input: Record<string, unknown>,
  fallback:
    | {
        readonly operationId: string;
        readonly expectedVersion: number;
      }
    | undefined,
  strict: boolean
): {
  readonly operationId: string;
  readonly expectedVersion: number;
} {
  const operationId =
    input.operationId === undefined
      ? fallback?.operationId
      : string(input.operationId, 'operationId');
  if (operationId === undefined)
    throw new CollaborationError('INVALID', 'Review operation identity is required');
  const idempotencyKey = request.headers.get('idempotency-key');
  if (
    operationId.length > 256 ||
    (strict && idempotencyKey !== operationId) ||
    (idempotencyKey !== null && idempotencyKey !== operationId)
  )
    throw new CollaborationError('INVALID', 'Review operation identity is invalid');
  const expectedVersion =
    input.expectedVersion === undefined
      ? fallback?.expectedVersion
      : number(input.expectedVersion, 'expectedVersion');
  if (expectedVersion === undefined)
    throw new CollaborationError('INVALID', 'Review expectedVersion is required');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new CollaborationError('INVALID', 'Review expectedVersion is invalid');
  return { operationId, expectedVersion };
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function revisionEvidence(value: unknown, field: string) {
  const evidence = object(value, field);
  const viewport = object(evidence.viewport, `${field}.viewport`);
  const scenarioId = optionalString(evidence.scenarioId, `${field}.scenarioId`);
  const stateId = optionalString(evidence.stateId, `${field}.stateId`);
  const nodeId = optionalString(evidence.nodeId, `${field}.nodeId`);
  const sourceRef = optionalString(evidence.sourceRef, `${field}.sourceRef`);
  return {
    artifactId: string(evidence.artifactId, `${field}.artifactId`),
    screenId: string(evidence.screenId, `${field}.screenId`),
    revisionId: string(evidence.revisionId, `${field}.revisionId`),
    revisionFingerprint: string(evidence.revisionFingerprint, `${field}.revisionFingerprint`),
    viewport: {
      width: number(viewport.width, `${field}.viewport.width`),
      height: number(viewport.height, `${field}.viewport.height`),
      zoom: number(viewport.zoom, `${field}.viewport.zoom`)
    },
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(sourceRef === undefined ? {} : { sourceRef })
  };
}

function spatialAnchor(value: unknown): SpatialAnchor {
  const anchor = object(value, 'anchor');
  const target = object(anchor.target, 'anchor.target');
  const lifecycle = anchor.lifecycle;
  if (
    lifecycle !== 'current' &&
    lifecycle !== 'mapped' &&
    lifecycle !== 'stale' &&
    lifecycle !== 'orphaned'
  )
    throw new CollaborationError('INVALID', 'anchor.lifecycle is invalid');
  const mappedFrom = anchor.mappedFrom;
  if (lifecycle === 'mapped' && mappedFrom === undefined)
    throw new CollaborationError('INVALID', 'Mapped anchor requires mappedFrom evidence');
  if (lifecycle !== 'mapped' && mappedFrom !== undefined)
    throw new CollaborationError('INVALID', 'Only mapped anchors may contain mappedFrom evidence');
  const common = {
    evidence: revisionEvidence(anchor.evidence, 'anchor.evidence'),
    lifecycle: lifecycle as SpatialAnchor['lifecycle'],
    ...(mappedFrom === undefined
      ? {}
      : { mappedFrom: revisionEvidence(mappedFrom, 'anchor.mappedFrom') })
  };
  if (target.kind === 'point') {
    const point = object(target.point, 'anchor.target.point');
    return {
      ...common,
      target: {
        kind: 'point',
        point: {
          x: number(point.x, 'anchor.target.point.x'),
          y: number(point.y, 'anchor.target.point.y')
        }
      }
    };
  }
  if (target.kind === 'region') {
    const region = object(target.region, 'anchor.target.region');
    return {
      ...common,
      target: {
        kind: 'region',
        region: {
          x: number(region.x, 'anchor.target.region.x'),
          y: number(region.y, 'anchor.target.region.y'),
          width: number(region.width, 'anchor.target.region.width'),
          height: number(region.height, 'anchor.target.region.height')
        }
      }
    };
  }
  throw new CollaborationError('INVALID', 'anchor.target.kind must be point or region');
}

function reviewDeepLink(value: unknown, allowedOrigins: readonly string[] | undefined): string {
  const deepLink = string(value, 'deepLink');
  try {
    validateReviewDeepLink(deepLink);
  } catch {
    throw new CollaborationError('INVALID', 'deepLink must be a safe relative route or https URL');
  }
  if (deepLink.startsWith('/') && !deepLink.startsWith('//')) return deepLink;
  let url: URL;
  try {
    url = new URL(deepLink);
  } catch {
    throw new CollaborationError('INVALID', 'deepLink must be a safe relative route or https URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    allowedOrigins?.includes(url.origin) !== true
  )
    throw new CollaborationError(
      'INVALID',
      'deepLink https URL must use a configured same-product origin'
    );
  return deepLink;
}

function providerSnapshot(value: unknown): AIChangeRequest['provider'] {
  const provider = object(value, 'provider');
  const model = optionalString(provider.model, 'provider.model');
  const implementation = optionalString(provider.implementation, 'provider.implementation');
  return {
    providerId: string(provider.providerId, 'provider.providerId'),
    capability: string(provider.capability, 'provider.capability'),
    ...(model === undefined ? {} : { model }),
    ...(implementation === undefined ? {} : { implementation })
  };
}

function changeResult(value: unknown): NonNullable<AIChangeRequest['result']> {
  const result = object(value, 'result');
  return {
    revisionId: string(result.revisionId, 'result.revisionId'),
    revisionFingerprint: string(result.revisionFingerprint, 'result.revisionFingerprint'),
    diff: string(result.diff, 'result.diff'),
    completedAt: string(result.completedAt, 'result.completedAt')
  };
}

function designChangeScope(value: Record<string, unknown>): SemanticDesignChangeInput['affected'] {
  return {
    projectId: string(value.projectId, 'semanticChange.affected.projectId'),
    screenIds: uniqueStrings(value.screenIds, 'semanticChange.affected.screenIds'),
    routePaths: uniqueStrings(value.routePaths, 'semanticChange.affected.routePaths'),
    scenarioIds: uniqueStrings(value.scenarioIds, 'semanticChange.affected.scenarioIds'),
    componentIds: uniqueStrings(value.componentIds, 'semanticChange.affected.componentIds'),
    stableNodeIds: uniqueStrings(value.stableNodeIds, 'semanticChange.affected.stableNodeIds')
  };
}

function visualEvidence(value: unknown): SemanticDesignChangeInput['evidence'] {
  if (!Array.isArray(value) || value.length > maxRequestListItems)
    throw new CollaborationError('INVALID', 'semanticChange.evidence must be an array');
  return value.map((item, index) => {
    const detail = object(item, `semanticChange.evidence[${index}]`);
    return {
      description: string(detail.description, `semanticChange.evidence[${index}].description`),
      ...(typeof detail.href === 'string' ? { href: detail.href } : {}),
      ...(typeof detail.checksum === 'string' ? { checksum: detail.checksum } : {})
    };
  });
}

function semanticChange(value: unknown): SemanticDesignChangeInput | undefined {
  if (value === undefined) return undefined;
  const input = object(value, 'semanticChange');
  const affected = object(input.affected, 'semanticChange.affected');
  const provenance = object(input.provenance, 'semanticChange.provenance');
  const kind = input.kind;
  if (
    kind !== 'source' &&
    kind !== 'design-system' &&
    kind !== 'token' &&
    kind !== 'template' &&
    kind !== 'dependency' &&
    kind !== 'visual'
  )
    throw new CollaborationError('INVALID', 'semanticChange.kind is invalid');
  const common: Omit<SemanticDesignChangeInput, 'provenance'> = {
    id: string(input.id, 'semanticChange.id'),
    kind: kind as SemanticDesignChangeInput['kind'],
    affected: designChangeScope(affected),
    evidence: visualEvidence(input.evidence),
    reason: string(input.reason, 'semanticChange.reason')
  };
  const provenanceKind = provenance.kind;
  if (provenanceKind === 'actor') {
    return {
      ...common,
      provenance: {
        kind: 'actor',
        actorId: string(provenance.actorId, 'semanticChange.provenance.actorId')
      }
    };
  }
  if (provenanceKind === 'agent') {
    return {
      ...common,
      provenance: {
        kind: 'agent',
        agentId: string(provenance.agentId, 'semanticChange.provenance.agentId'),
        promptDigest: string(provenance.promptDigest, 'semanticChange.provenance.promptDigest')
      }
    };
  }
  throw new CollaborationError('INVALID', 'semanticChange.provenance.kind is invalid');
}

/**
 * Fetch-compatible, dependency-free HTTP adapter. Authentication supplies a
 * trusted actor identity; every authenticated route still passes through the
 * injected tenant-aware authorizer.
 */
export function createCollaborationService(
  sourceOptions: ServiceOptions
): (request: Request) => Promise<Response> {
  const options = captureServiceOptions(sourceOptions);
  const clock = options.clock;
  const maximum = options.maximum;
  const maximumBodyBytes = options.maximumBodyBytes;
  const maximumSnapshotBytes = options.maximumSnapshotBytes;
  const maximumHostOperationMs = options.maximumHostOperationMs;
  const createHostContext = captureHostContextFactory(options.hostContextFactory);
  const body = (request: Request) => readBody(request, maximumBodyBytes);
  const counters = new Map<string, { start: number; count: number }>();
  const subscribers = new Map<
    string,
    Set<(event: import('./index.js').CollaborationEvent) => void>
  >();
  const metrics: Metrics = { requests: 0, rejected: 0, errors: 0 };
  const contexts = new WeakMap<Request, CollaborationHostContext>();
  const contextFor = (request: Request): CollaborationHostContext => {
    const context = contexts.get(request);
    if (!context) throw serviceUnavailable();
    return context;
  };

  async function host<T>(
    request: Request,
    port: object,
    method: string,
    args: readonly unknown[]
  ): Promise<T> {
    try {
      const result = await callCollaborationHostPort<unknown>(
        contextFor(request),
        port,
        method,
        args
      );
      return (result === undefined ? result : ownCollaborationValue(result)) as T;
    } catch (error) {
      if (isOwnedServiceError(error)) throw error;
      // Do not expose driver, proxy, signer, or adapter failures at the HTTP boundary.
      throw serviceUnavailable();
    }
  }

  const repository = <T>(request: Request, method: string, args: readonly unknown[] = []) =>
    host<T>(request, options.repository, method, args);

  const isHostedReviewRequest = (request: Request): boolean => {
    const provider = request.headers.get('x-selene-review-provider');
    if (provider === null) return false;
    if (provider !== 'hosted')
      throw new CollaborationError('INVALID', 'Review provider header is invalid');
    return true;
  };

  const bindingsMatch = (
    left: HostedReviewBinding | undefined,
    right: HostedReviewBinding
  ): boolean =>
    left !== undefined &&
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId &&
    left.baselineId === right.baselineId &&
    left.version === right.version;

  async function authoritativeHostedReviewBinding(
    request: Request,
    projectId: string
  ): Promise<HostedReviewBinding> {
    const resolver = options.hostedReviewBindings;
    if (!resolver) throw new CollaborationError('NOT_FOUND', 'Hosted review is not configured');
    const binding = await host<HostedReviewBinding | undefined>(request, resolver, 'resolve', [
      projectId
    ]);
    if (binding === undefined)
      throw new CollaborationError('NOT_FOUND', 'Published review binding was not found');
    try {
      validateHostedReviewBinding(binding);
    } catch {
      throw serviceUnavailable();
    }
    const [project, revision, reviewState] = await Promise.all([
      repository<Project | undefined>(request, 'getProject', [projectId]),
      repository<Revision | undefined>(request, 'getRevision', [binding.revisionId]),
      repository<DesignReviewState | undefined>(request, 'getDesignReviewState', [projectId])
    ]);
    if (
      !project ||
      !revision ||
      revision.projectId !== projectId ||
      binding.projectId !== projectId ||
      binding.tenantId !== project.organizationId
    )
      throw serviceUnavailable();
    if (
      reviewState?.baseline === undefined ||
      reviewState.projectId !== projectId ||
      reviewState.baseline.projectId !== projectId ||
      reviewState.baseline.id !== binding.baselineId ||
      reviewState.readiness === 'draft'
    )
      throw new CollaborationError('NOT_FOUND', 'Published review binding is not current');
    return binding;
  }

  async function requireCurrentHostedReviewThread(
    request: Request,
    thread: ReviewThread
  ): Promise<void> {
    if (!isHostedReviewRequest(request)) return;
    const binding = await authoritativeHostedReviewBinding(request, thread.projectId);
    if (!bindingsMatch(thread.hostedBinding, binding))
      throw new CollaborationError(
        'NOT_FOUND',
        'Review thread does not belong to the current published review'
      );
  }

  async function issuedAt(request: Request): Promise<string> {
    try {
      return checkedTime(await host<unknown>(request, clock, 'now', []));
    } catch {
      throw serviceUnavailable();
    }
  }

  async function nextId(request: Request, kind: string): Promise<string> {
    const value = await host<unknown>(request, options.ids, 'next', [kind]);
    if (typeof value !== 'string' || value.length > collaborationBudgets.maxIdentifier)
      throw serviceUnavailable();
    return value;
  }

  async function emit(
    request: Request,
    projectId: string,
    type: string,
    actorId: string | undefined,
    resourceType: string,
    resourceId: string,
    payload: Readonly<Record<string, unknown>> = {}
  ) {
    const event = await repository<import('./index.js').CollaborationEvent>(
      request,
      'appendEvent',
      [
        {
          id: await nextId(request, 'event'),
          projectId,
          type,
          ...(actorId ? { actorId } : {}),
          resourceType,
          resourceId,
          payload,
          occurredAt: await issuedAt(request)
        }
      ]
    );
    for (const subscriber of subscribers.get(projectId) ?? []) {
      try {
        subscriber(event);
      } catch {
        // A broken SSE consumer cannot change the persisted mutation response.
      }
    }
    return event;
  }

  function cors(request: Request, response: Response): Response {
    const origin = request.headers.get('origin');
    if (!origin || options.allowedOrigins?.includes(origin) !== true) return response;
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
    headers.set(
      'access-control-allow-headers',
      'content-type, idempotency-key, last-event-id, x-selene-expected-revision-id, x-selene-review-provider, x-selene-share-token, x-selene-user-id'
    );
    headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    return new Response(response.body, { status: response.status, headers });
  }

  function allowed(request: Request): boolean {
    const shareToken = request.headers.get('x-selene-share-token');
    if (shareToken && shareToken.length > collaborationBudgets.maxText) return false;
    let tokenHash = 2166136261;
    if (shareToken)
      for (let index = 0; index < shareToken.length; index += 1) {
        tokenHash ^= shareToken.charCodeAt(index);
        tokenHash = Math.imul(tokenHash, 16777619);
      }
    const client =
      request.headers.get('x-selene-user-id') ??
      (shareToken ? `share:${(tokenHash >>> 0).toString(16)}` : 'anonymous');
    const now = Date.now();
    const rate = counters.get(client);
    if (!rate || now - rate.start >= 60_000) {
      if (!rate && counters.size >= 10_000) {
        for (const [key, value] of counters) if (now - value.start >= 60_000) counters.delete(key);
        if (counters.size >= 10_000) return false;
      }
      counters.set(client, { start: now, count: 1 });
      return true;
    }
    rate.count += 1;
    return rate.count <= maximum;
  }

  function cursor(value: string | null): number {
    if (value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new CollaborationError('INVALID', 'after must be a non-negative cursor');
    return parsed;
  }

  function limit(value: string | null): number {
    if (value === null || value === '') return 100;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500)
      throw new CollaborationError('INVALID', 'limit must be between 1 and 500');
    return parsed;
  }

  async function requireProjectAccess(
    request: Request,
    projectId: string,
    permission: SharePermission
  ): Promise<string | undefined> {
    const userId = request.headers.get('x-selene-user-id');
    if (userId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId))
        throw new CollaborationError('FORBIDDEN', 'Project access is not permitted');
      let authorized: boolean;
      try {
        authorized =
          (await host<boolean>(request, options.authorizer, 'authorize', [
            {
              userId,
              action: `project:${permission === 'viewer' ? 'read' : 'comment'}`,
              projectId
            }
          ])) === true;
      } catch (error) {
        if (isOwnedServiceUnavailableError(error)) throw error;
        authorized = false;
      }
      if (!authorized) {
        throw new CollaborationError('FORBIDDEN', 'Project access is not permitted');
      }
      return userId;
    }
    const token = request.headers.get('x-selene-share-token');
    if (!token || !options.shareSigner)
      throw new CollaborationError('FORBIDDEN', 'Authentication or a share token is required');
    const signer = options.shareSigner;
    const observedAt = await issuedAt(request);
    const context = contextFor(request);
    let grant: Awaited<ReturnType<typeof verifySignedShareToken>>;
    try {
      grant = await verifySignedShareToken(token, signer, observedAt, context);
    } catch (error) {
      if (isShareTokenHostFailure(error) || isOwnedServiceUnavailableError(error))
        throw serviceUnavailable();
      throw new CollaborationError('FORBIDDEN', 'Share link is not valid for this operation');
    }
    let link: Awaited<ReturnType<CollaborationRepository['getShareLink']>>;
    let tokenHash: string;
    try {
      const storedLink = await repository<
        Awaited<ReturnType<CollaborationRepository['getShareLink']>>
      >(request, 'getShareLink', [grant.linkId]);
      link = storedLink === undefined ? undefined : ownCollaborationValue(storedLink);
      tokenHash = await host<string>(request, signer, 'hash', [token]);
    } catch (error) {
      if (isOwnedServiceUnavailableError(error)) throw error;
      throw new CollaborationError('FORBIDDEN', 'Share link is not valid for this operation');
    }
    if (typeof tokenHash !== 'string' || tokenHash.length > collaborationBudgets.maxText)
      throw serviceUnavailable();
    const linkExpiry = link === undefined ? Number.NaN : Date.parse(link.expiresAt);
    const currentTime = Date.parse(observedAt);
    if (
      grant.projectId !== projectId ||
      !link ||
      link.projectId !== projectId ||
      link.permission !== grant.permission ||
      link.expiresAt !== grant.expiresAt ||
      link.tokenHash !== tokenHash ||
      link.revokedAt ||
      Number.isNaN(linkExpiry) ||
      Number.isNaN(currentTime) ||
      linkExpiry <= currentTime ||
      (permission === 'commenter' && link.permission !== 'commenter')
    ) {
      throw new CollaborationError('FORBIDDEN', 'Share link is not valid for this operation');
    }
    return undefined;
  }

  async function requireUserAuthorization(
    request: Request,
    action: CollaborationAction,
    target: { readonly organizationId?: string; readonly projectId?: string }
  ): Promise<string> {
    const userId = actor(request);
    let authorized: boolean;
    try {
      authorized =
        (await host<boolean>(request, options.authorizer, 'authorize', [
          { userId, action, ...target }
        ])) === true;
    } catch (error) {
      if (isOwnedServiceUnavailableError(error)) throw error;
      authorized = false;
    }
    if (!authorized) {
      throw new CollaborationError('FORBIDDEN', 'Project access is not permitted');
    }
    return userId;
  }

  return async (request) => {
    metrics.requests += 1;
    if (request.method === 'OPTIONS') return cors(request, new Response(null, { status: 204 }));
    if (!allowed(request)) {
      metrics.rejected += 1;
      return cors(request, json({ error: 'rate_limited' }, 429, { 'retry-after': '60' }));
    }
    let context: CollaborationHostContext | undefined;
    try {
      context = createHostContext({
        signal: request.signal,
        timeoutMs: maximumHostOperationMs
      });
      contexts.set(request, context);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return cors(request, json({ status: 'ok', collaborationFormat }));
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        return cors(
          request,
          text(
            `selene_collaboration_requests_total ${metrics.requests}\nselene_collaboration_rejected_total ${metrics.rejected}\nselene_collaboration_errors_total ${metrics.errors}\n`
          )
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/projects') {
        const input = await body(request);
        const organizationId = string(input.organizationId, 'organizationId');
        const userId = await requireUserAuthorization(request, 'organization:create-project', {
          organizationId
        });
        const project: Project = {
          id: string(input.id ?? (await nextId(request, 'project')), 'id'),
          organizationId,
          name: string(input.name, 'name')
        };
        const saved = await idempotent(
          options.repository,
          `project:${userId}:${project.id}`,
          request.headers.get('idempotency-key') ?? undefined,
          async () => {
            await repository<void>(request, 'createProject', [project]);
            await repository<void>(request, 'appendAudit', [
              {
                id: await nextId(request, 'audit'),
                organizationId: project.organizationId,
                actorId: userId,
                action: 'project.created',
                resourceType: 'project',
                resourceId: project.id,
                metadata: {},
                occurredAt: await issuedAt(request)
              }
            ]);
            await emit(request, project.id, 'project.created', userId, 'project', project.id, {
              organizationId: project.organizationId,
              name: project.name
            });
            return project;
          },
          contextFor(request)
        );
        return cors(request, json(saved, 201));
      }
      const revisionProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/revisions$/);
      if (request.method === 'POST' && revisionProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: revisionProjectId
        });
        const latest = await repository<Revision | undefined>(request, 'getLatestRevision', [
          revisionProjectId
        ]);
        const revision: Revision = {
          id: string(input.id ?? (await nextId(request, 'revision')), 'id'),
          projectId: revisionProjectId,
          sequence:
            typeof input.sequence === 'number' ? input.sequence : (latest?.sequence ?? 0) + 1,
          ...(typeof input.parentRevisionId === 'string'
            ? { parentRevisionId: input.parentRevisionId }
            : latest
              ? { parentRevisionId: latest.id }
              : {}),
          content: input.content,
          contentSha256: string(input.contentSha256, 'contentSha256'),
          scenarioIds: strings(input.scenarioIds ?? [], 'scenarioIds'),
          createdBy: userId,
          createdAt: await issuedAt(request)
        };
        const change = semanticChange(input.semanticChange);
        const reviewState = await repository<
          Awaited<ReturnType<CollaborationRepository['getDesignReviewState']>>
        >(request, 'getDesignReviewState', [revisionProjectId]);
        const hasBaseline = reviewState?.baseline !== undefined;
        if (hasBaseline && !change)
          throw new CollaborationError(
            'INVALID',
            'Design-affecting revisions after a baseline require semantic change metadata'
          );
        if (!hasBaseline && change)
          throw new CollaborationError(
            'INVALID',
            'Semantic design changes require an active baseline'
          );
        const saved = await repository<
          Awaited<ReturnType<CollaborationRepository['commitDesignRevision']>>
        >(request, 'commitDesignRevision', [
          {
            kind: 'append-revision',
            projectId: revisionProjectId,
            actorId: userId,
            occurredAt: await issuedAt(request),
            revision,
            ...(latest ? { expectedParentRevisionId: latest.id } : {}),
            ...(change ? { semanticChange: change } : {}),
            ...(request.headers.get('idempotency-key')
              ? {
                  idempotencyKey: request.headers.get('idempotency-key')!,
                  idempotencyScope: `revision:${userId}:${revisionProjectId}`
                }
              : {})
          }
        ]);
        if (saved.kind !== 'revision')
          throw new CollaborationError(
            'CONFLICT',
            'Revision transaction returned an invalid result'
          );
        if (!saved.replayed)
          await emit(
            request,
            revisionProjectId,
            'revision.created',
            userId,
            'revision',
            revision.id,
            {
              sequence: revision.sequence,
              ...(revision.parentRevisionId === undefined
                ? {}
                : { parentRevisionId: revision.parentRevisionId }),
              semanticChangeRecorded: saved.changeRecorded
            }
          );
        return cors(request, json(saved.revision, 201));
      }
      const readinessProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/readiness$/);
      if (request.method === 'GET' && readinessProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: readinessProjectId });
        const state = await repository<
          Awaited<ReturnType<CollaborationRepository['getDesignReviewState']>>
        >(request, 'getDesignReviewState', [readinessProjectId]);
        if (!state) throw new CollaborationError('NOT_FOUND', 'Project not found');
        return cors(request, json(state));
      }
      if (request.method === 'POST' && readinessProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: readinessProjectId
        });
        const intent = input.intent;
        if (intent !== 'review' && intent !== 'handoff')
          throw new CollaborationError('INVALID', 'intent must be review or handoff');
        const readiness: DesignReadinessInput = {
          id: string(input.id ?? (await nextId(request, 'baseline')), 'id'),
          revisionId: string(input.revisionId, 'revisionId'),
          intent,
          revisionFingerprint: string(input.revisionFingerprint, 'revisionFingerprint')
        };
        const saved = await repository<
          Awaited<ReturnType<CollaborationRepository['commitDesignRevision']>>
        >(request, 'commitDesignRevision', [
          {
            kind: 'mark-ready',
            projectId: readinessProjectId,
            actorId: userId,
            occurredAt: await issuedAt(request),
            readiness,
            ...(request.headers.get('idempotency-key')
              ? {
                  idempotencyKey: request.headers.get('idempotency-key')!,
                  idempotencyScope: `readiness:${userId}:${readinessProjectId}`
                }
              : {})
          }
        ]);
        if (saved.kind !== 'readiness')
          throw new CollaborationError(
            'CONFLICT',
            'Readiness transaction returned an invalid result'
          );
        if (!saved.replayed)
          await emit(
            request,
            readinessProjectId,
            'design.ready',
            userId,
            'design_baseline',
            readiness.id,
            {
              intent: readiness.intent,
              revisionId: readiness.revisionId
            }
          );
        return cors(request, json(saved.readiness, 201));
      }
      const shareProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/share-links$/);
      if (request.method === 'POST' && shareProjectId) {
        if (!options.shareSigner)
          throw new CollaborationError('NOT_FOUND', 'Guest sharing is not configured');
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:manage-sharing', {
          projectId: shareProjectId
        });
        if (!(await repository<Project | undefined>(request, 'getProject', [shareProjectId])))
          throw new CollaborationError('NOT_FOUND', 'Project not found');
        const permission: SharePermission =
          input.permission === 'commenter'
            ? 'commenter'
            : input.permission === 'viewer'
              ? 'viewer'
              : (() => {
                  throw new CollaborationError('INVALID', 'permission must be viewer or commenter');
                })();
        const expiresAt = string(input.expiresAt, 'expiresAt');
        const linkId = await nextId(request, 'share');
        let token: string;
        try {
          token = await createSignedShareToken(
            { linkId, projectId: shareProjectId, permission, expiresAt },
            options.shareSigner,
            contextFor(request)
          );
        } catch (error) {
          if (isShareTokenHostFailure(error)) throw serviceUnavailable();
          throw new CollaborationError('INVALID', 'Share link signer input is invalid');
        }
        const tokenHash = await host<unknown>(request, options.shareSigner, 'hash', [token]);
        if (typeof tokenHash !== 'string' || tokenHash.length > collaborationBudgets.maxText)
          throw serviceUnavailable();
        await repository<void>(request, 'createShareLink', [
          {
            id: linkId,
            projectId: shareProjectId,
            tokenHash,
            permission,
            expiresAt,
            createdBy: userId,
            createdAt: await issuedAt(request)
          }
        ]);
        await emit(request, shareProjectId, 'share_link.created', userId, 'share_link', linkId, {
          permission
        });
        return cors(request, json({ id: linkId, token, permission, expiresAt }, 201));
      }
      const reviewBindingProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/review-binding$/
      );
      if (request.method === 'GET' && reviewBindingProjectId) {
        await requireProjectAccess(request, reviewBindingProjectId, 'viewer');
        return cors(
          request,
          json(await authoritativeHostedReviewBinding(request, reviewBindingProjectId))
        );
      }
      const threadProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/threads$/);
      const reviewThreadProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/review-threads$/
      );
      if (request.method === 'GET' && reviewThreadProjectId) {
        const viewerId = await requireProjectAccess(request, reviewThreadProjectId, 'viewer');
        const hostedBinding = isHostedReviewRequest(request)
          ? await authoritativeHostedReviewBinding(request, reviewThreadProjectId)
          : undefined;
        const lifecycle = url.searchParams.get('lifecycle');
        if (lifecycle !== null && lifecycle !== 'open' && lifecycle !== 'resolved')
          throw new CollaborationError('INVALID', 'lifecycle must be open or resolved');
        const listedThreads = await repository<readonly ReviewThread[]>(
          request,
          'listReviewThreads',
          [
            reviewThreadProjectId,
            {
              ...(lifecycle === null ? {} : { lifecycle }),
              ...(url.searchParams.get('revisionId') === null
                ? {}
                : { revisionId: url.searchParams.get('revisionId')! }),
              ...(url.searchParams.get('deepLink') === null
                ? {}
                : { deepLink: url.searchParams.get('deepLink')! }),
              ...(url.searchParams.get('screenId') === null
                ? {}
                : { screenId: url.searchParams.get('screenId')! }),
              ...(url.searchParams.get('stateId') === null
                ? {}
                : { stateId: url.searchParams.get('stateId')! }),
              ...(url.searchParams.get('author') === null
                ? {}
                : { createdBy: url.searchParams.get('author')! }),
              ...(url.searchParams.get('unread') === 'true' && viewerId !== undefined
                ? { unreadFor: viewerId }
                : {})
            }
          ]
        );
        const threads =
          hostedBinding === undefined
            ? listedThreads
            : listedThreads.filter((thread) => bindingsMatch(thread.hostedBinding, hostedBinding));
        const clusterCellSize = url.searchParams.get('clusterCellSize');
        if (clusterCellSize !== null) {
          const cellSize = Number(clusterCellSize);
          return cors(
            request,
            json({ threads, clusters: clusterReviewThreads(threads, cellSize) })
          );
        }
        return cors(request, json({ threads }));
      }
      if (request.method === 'POST' && reviewThreadProjectId) {
        const input = await body(request);
        const hostedRequest = isHostedReviewRequest(request);
        const operation = reviewOperation(
          request,
          input,
          hostedRequest
            ? undefined
            : {
                operationId:
                  input.operationId === undefined
                    ? await nextId(request, 'review-create-operation')
                    : 'unused',
                expectedVersion: 0
              },
          hostedRequest
        );
        if (operation.expectedVersion !== 0)
          return cors(request, json({ error: 'conflict', currentVersion: 0 }, 409));
        const userId = await requireProjectAccess(request, reviewThreadProjectId, 'commenter');
        const hostedBinding = hostedRequest
          ? await authoritativeHostedReviewBinding(request, reviewThreadProjectId)
          : undefined;
        const actorId = userId ?? 'guest';
        const createdAt = await issuedAt(request);
        const anchor = spatialAnchor(input.anchor);
        const anchorRevision = await repository<Revision | undefined>(request, 'getRevision', [
          anchor.evidence.revisionId
        ]);
        try {
          if (!anchorRevision || anchorRevision.projectId !== reviewThreadProjectId)
            throw new Error('anchor revision is invalid');
          if (
            hostedBinding !== undefined &&
            (anchor.evidence.artifactId !== hostedBinding.artifactId ||
              anchor.evidence.revisionId !== hostedBinding.revisionId)
          )
            throw new Error('anchor binding is invalid');
          validateSpatialAnchor(anchor, anchorRevision);
        } catch {
          throw new CollaborationError('INVALID', 'Spatial anchor is invalid');
        }
        const reviewThread: ReviewThread = {
          id:
            input.id === undefined
              ? await nextId(request, 'review-thread')
              : string(input.id, 'id'),
          projectId: reviewThreadProjectId,
          ...(hostedBinding === undefined ? {} : { hostedBinding }),
          version: 1,
          anchor,
          deepLink: reviewDeepLink(input.deepLink, options.allowedOrigins),
          lifecycle: 'open',
          createdBy: actorId,
          createdAt,
          messages: [
            {
              id:
                input.messageId === undefined
                  ? await nextId(request, 'review-message')
                  : string(input.messageId, 'messageId'),
              body: string(input.body, 'body'),
              createdBy: actorId,
              createdAt,
              mentionedUserIds: uniqueStrings(input.mentionedUserIds ?? [], 'mentionedUserIds'),
              reactions: [],
              readBy: [actorId]
            }
          ]
        };
        const result = await repository<ReviewThreadMutationResult>(request, 'mutateReviewThread', [
          {
            kind: 'create',
            operationId: operation.operationId,
            expectedVersion: 0,
            thread: reviewThread
          } satisfies ReviewThreadMutation
        ]);
        if (result.kind === 'conflict')
          return cors(
            request,
            json(
              { error: 'conflict', currentVersion: result.currentVersion, thread: result.thread },
              409
            )
          );
        if (result.kind === 'applied')
          await emit(
            request,
            reviewThreadProjectId,
            'review_thread.created',
            userId,
            'review_thread',
            reviewThread.id,
            {
              revisionId: reviewThread.anchor.evidence.revisionId
            }
          );
        return cors(request, json(result.thread, result.kind === 'replayed' ? 200 : 201));
      }
      const reviewThreadMessage = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/messages$/);
      if (request.method === 'POST' && reviewThreadMessage) {
        const input = await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          reviewThreadMessage
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const hostedRequest = isHostedReviewRequest(request);
        const operation = reviewOperation(
          request,
          input,
          hostedRequest
            ? undefined
            : {
                operationId:
                  input.operationId === undefined
                    ? await nextId(request, 'review-reply-operation')
                    : 'unused',
                expectedVersion: existing.version
              },
          hostedRequest
        );
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const actorId = userId ?? 'guest';
        const message = {
          id:
            input.id === undefined
              ? await nextId(request, 'review-message')
              : string(input.id, 'id'),
          ...(typeof input.parentMessageId === 'string'
            ? { parentMessageId: string(input.parentMessageId, 'parentMessageId') }
            : {}),
          body: string(input.body, 'body'),
          createdBy: actorId,
          createdAt: await issuedAt(request),
          mentionedUserIds: uniqueStrings(input.mentionedUserIds ?? [], 'mentionedUserIds'),
          reactions: [],
          readBy: [actorId]
        };
        const result = await repository<ReviewThreadMutationResult>(request, 'mutateReviewThread', [
          {
            kind: 'reply',
            operationId: operation.operationId,
            expectedVersion: operation.expectedVersion,
            threadId: existing.id,
            message
          } satisfies ReviewThreadMutation
        ]);
        if (result.kind === 'conflict')
          return cors(
            request,
            json(
              { error: 'conflict', currentVersion: result.currentVersion, thread: result.thread },
              409
            )
          );
        const updated = result.thread;
        if (result.kind === 'applied')
          await emit(
            request,
            existing.projectId,
            'review_message.created',
            userId,
            'review_thread',
            existing.id,
            {
              messageId: message.id
            }
          );
        return cors(request, json(updated));
      }
      const reviewMessageReaction = idFrom(
        url.pathname,
        /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/reactions$/
      );
      const reactionMatch = /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/reactions$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && reviewMessageReaction && reactionMatch) {
        const input = await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          reactionMatch[1]!
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const updated = await repository<ReviewThread>(request, 'reactToReviewThreadMessage', [
          existing.id,
          routeId(reactionMatch[2]!),
          string(input.emoji, 'emoji'),
          userId ?? 'guest'
        ]);
        await emit(
          request,
          existing.projectId,
          'review_message.reacted',
          userId,
          'review_thread',
          existing.id,
          {}
        );
        return cors(request, json(updated));
      }
      const reviewMessageReadMatch =
        /^\/v1\/review-threads\/([^/]+)\/messages\/([^/]+)\/read$/.exec(url.pathname);
      if (request.method === 'POST' && reviewMessageReadMatch) {
        const input = await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          reviewMessageReadMatch[1]!
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireProjectAccess(request, existing.projectId, 'viewer');
        const updated = await repository<ReviewThread>(request, 'setReviewThreadMessageRead', [
          existing.id,
          reviewMessageReadMatch[2]!,
          userId ?? 'guest',
          input.read !== false
        ]);
        return cors(request, json(updated));
      }
      const resolveReviewThreadId = idFrom(
        url.pathname,
        /^\/v1\/review-threads\/([^/]+)\/resolve$/
      );
      if (request.method === 'POST' && resolveReviewThreadId) {
        const hostedRequest = isHostedReviewRequest(request);
        const input = !hostedRequest && request.body === null ? {} : await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          resolveReviewThreadId
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const operation = reviewOperation(
          request,
          input,
          hostedRequest
            ? undefined
            : {
                operationId:
                  input.operationId === undefined
                    ? await nextId(request, 'review-resolve-operation')
                    : 'unused',
                expectedVersion: existing.version
              },
          hostedRequest
        );
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const result = await repository<ReviewThreadMutationResult>(request, 'mutateReviewThread', [
          {
            kind: 'resolve',
            operationId: operation.operationId,
            expectedVersion: operation.expectedVersion,
            threadId: resolveReviewThreadId,
            actorId: userId ?? 'guest',
            occurredAt: await issuedAt(request)
          } satisfies ReviewThreadMutation
        ]);
        if (result.kind === 'conflict')
          return cors(
            request,
            json(
              { error: 'conflict', currentVersion: result.currentVersion, thread: result.thread },
              409
            )
          );
        const resolved = result.thread;
        if (result.kind === 'applied')
          await emit(
            request,
            existing.projectId,
            'review_thread.resolved',
            userId,
            'review_thread',
            resolved.id,
            {}
          );
        return cors(request, json(resolved));
      }
      const reopenReviewThreadId = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/reopen$/);
      if (request.method === 'POST' && reopenReviewThreadId) {
        const hostedRequest = isHostedReviewRequest(request);
        const input = !hostedRequest && request.body === null ? {} : await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          reopenReviewThreadId
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        const operation = reviewOperation(
          request,
          input,
          hostedRequest
            ? undefined
            : {
                operationId:
                  input.operationId === undefined
                    ? await nextId(request, 'review-reopen-operation')
                    : 'unused',
                expectedVersion: existing.version
              },
          hostedRequest
        );
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const result = await repository<ReviewThreadMutationResult>(request, 'mutateReviewThread', [
          {
            kind: 'reopen',
            operationId: operation.operationId,
            expectedVersion: operation.expectedVersion,
            threadId: reopenReviewThreadId,
            actorId: userId ?? 'guest',
            occurredAt: await issuedAt(request)
          } satisfies ReviewThreadMutation
        ]);
        if (result.kind === 'conflict')
          return cors(
            request,
            json(
              { error: 'conflict', currentVersion: result.currentVersion, thread: result.thread },
              409
            )
          );
        const reopened = result.thread;
        if (result.kind === 'applied')
          await emit(
            request,
            existing.projectId,
            'review_thread.reopened',
            userId,
            'review_thread',
            reopened.id,
            {}
          );
        return cors(request, json(reopened));
      }
      const moveReviewThreadId = idFrom(url.pathname, /^\/v1\/review-threads\/([^/]+)\/move$/);
      if (request.method === 'POST' && moveReviewThreadId) {
        const input = await body(request);
        const existing = await repository<ReviewThread | undefined>(request, 'getReviewThread', [
          moveReviewThreadId
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Review thread not found');
        await requireCurrentHostedReviewThread(request, existing);
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: existing.projectId
        });
        const moved = await repository<ReviewThread>(request, 'moveReviewThread', [
          moveReviewThreadId,
          spatialAnchor(input.anchor),
          userId,
          await issuedAt(request)
        ]);
        await emit(
          request,
          existing.projectId,
          'review_thread.moved',
          userId,
          'review_thread',
          moved.id,
          {}
        );
        return cors(request, json(moved));
      }
      const aiRequestProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/ai-change-requests$/
      );
      if (request.method === 'POST' && aiRequestProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: aiRequestProjectId
        });
        const anchor = spatialAnchor(input.anchor);
        const createdAt = await issuedAt(request);
        const changeRequest: AIChangeRequest = {
          id: string(input.id ?? (await nextId(request, 'ai-change')), 'id'),
          projectId: aiRequestProjectId,
          anchor,
          instruction: string(input.instruction, 'instruction'),
          provider: providerSnapshot(input.provider),
          baseRevision: {
            id: anchor.evidence.revisionId,
            fingerprint: anchor.evidence.revisionFingerprint
          },
          lifecycle: 'queued',
          createdBy: userId,
          createdAt,
          updatedAt: createdAt
        };
        await repository<void>(request, 'createAIChangeRequest', [changeRequest]);
        await emit(
          request,
          aiRequestProjectId,
          'ai_change_request.created',
          userId,
          'ai_change_request',
          changeRequest.id,
          {
            providerId: changeRequest.provider.providerId,
            revisionId: changeRequest.baseRevision.id
          }
        );
        return cors(request, json(changeRequest, 201));
      }
      if (request.method === 'GET' && aiRequestProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: aiRequestProjectId });
        return cors(
          request,
          json({
            requests: await repository<readonly AIChangeRequest[]>(
              request,
              'listAIChangeRequests',
              [aiRequestProjectId]
            )
          })
        );
      }
      const aiRequestId = idFrom(url.pathname, /^\/v1\/ai-change-requests\/([^/]+)$/);
      if (request.method === 'GET' && aiRequestId) {
        const existing = await repository<AIChangeRequest | undefined>(
          request,
          'getAIChangeRequest',
          [aiRequestId]
        );
        if (!existing) throw new CollaborationError('NOT_FOUND', 'AI change request not found');
        await requireUserAuthorization(request, 'project:read', { projectId: existing.projectId });
        return cors(request, json(existing));
      }
      const aiTransitionId = idFrom(
        url.pathname,
        /^\/v1\/ai-change-requests\/([^/]+)\/transition$/
      );
      if (request.method === 'POST' && aiTransitionId) {
        const input = await body(request);
        const existing = await repository<AIChangeRequest | undefined>(
          request,
          'getAIChangeRequest',
          [aiTransitionId]
        );
        if (!existing) throw new CollaborationError('NOT_FOUND', 'AI change request not found');
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: existing.projectId
        });
        const action = input.action;
        const lifecycle: AIChangeRequestLifecycle =
          action === 'start'
            ? 'running'
            : action === 'apply'
              ? 'applied'
              : action === 'fail'
                ? 'failed'
                : action === 'cancel' || action === 'reject'
                  ? 'cancelled'
                  : action === 'retry'
                    ? 'queued'
                    : action === 'undo'
                      ? 'undone'
                      : (() => {
                          throw new CollaborationError(
                            'INVALID',
                            'action must be start, apply, fail, cancel, reject, retry, or undo'
                          );
                        })();
        const result = lifecycle === 'applied' ? changeResult(input.result) : undefined;
        if (result) {
          const resultRevision = await repository<Revision | undefined>(request, 'getRevision', [
            result.revisionId
          ]);
          if (!resultRevision || resultRevision.projectId !== existing.projectId)
            throw new CollaborationError('NOT_FOUND', 'AI change result revision was not found');
          if (resultRevision.contentSha256 !== result.revisionFingerprint)
            throw new CollaborationError('INVALID', 'AI change result fingerprint is invalid');
        }
        const next: AIChangeRequest = {
          id: existing.id,
          projectId: existing.projectId,
          ...(existing.anchor === undefined ? {} : { anchor: existing.anchor }),
          instruction: existing.instruction,
          provider: existing.provider,
          baseRevision: existing.baseRevision,
          createdBy: existing.createdBy,
          createdAt: existing.createdAt,
          lifecycle,
          updatedAt: await issuedAt(request),
          ...(result
            ? { result }
            : lifecycle === 'undone'
              ? (() => {
                  if (existing.result === undefined)
                    throw new CollaborationError(
                      'CONFLICT',
                      'Only an applied request can be undone'
                    );
                  return { result: existing.result, undoResult: changeResult(input.undoResult) };
                })()
              : {}),
          ...(lifecycle === 'failed'
            ? { failureReason: string(input.failureReason, 'failureReason') }
            : {})
        };
        const updated = await repository<AIChangeRequest>(request, 'updateAIChangeRequest', [next]);
        await emit(
          request,
          existing.projectId,
          'ai_change_request.transitioned',
          userId,
          'ai_change_request',
          updated.id,
          {
            action,
            lifecycle: updated.lifecycle
          }
        );
        return cors(request, json(updated));
      }
      const annotationProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/developer-annotations$/
      );
      if (request.method === 'GET' && annotationProjectId) {
        await requireUserAuthorization(request, 'project:read', { projectId: annotationProjectId });
        return cors(
          request,
          json({
            annotations: await repository<readonly DeveloperAnnotation[]>(
              request,
              'listDeveloperAnnotations',
              [annotationProjectId]
            )
          })
        );
      }
      if (request.method === 'POST' && annotationProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:design', {
          projectId: annotationProjectId
        });
        const annotation: DeveloperAnnotation = {
          id: string(input.id ?? (await nextId(request, 'developer-annotation')), 'id'),
          projectId: annotationProjectId,
          anchor: spatialAnchor(input.anchor),
          category:
            input.category === 'development' ||
            input.category === 'interaction' ||
            input.category === 'accessibility' ||
            input.category === 'content'
              ? input.category
              : (() => {
                  throw new CollaborationError(
                    'INVALID',
                    'category must be development, interaction, accessibility, or content'
                  );
                })(),
          body: string(input.body, 'body'),
          createdBy: userId,
          createdAt: await issuedAt(request)
        };
        await repository<void>(request, 'createDeveloperAnnotation', [annotation]);
        await emit(
          request,
          annotationProjectId,
          'developer_annotation.created',
          userId,
          'developer_annotation',
          annotation.id,
          {}
        );
        return cors(request, json(annotation, 201));
      }
      if (request.method === 'POST' && threadProjectId) {
        const input = await body(request);
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: threadProjectId
        });
        const thread: Thread = {
          id: string(input.id ?? (await nextId(request, 'thread')), 'id'),
          projectId: threadProjectId,
          revisionId: string(input.revisionId, 'revisionId'),
          reactNodeId: string(input.reactNodeId, 'reactNodeId'),
          scenarioId: string(input.scenarioId, 'scenarioId'),
          createdBy: userId,
          createdAt: await issuedAt(request)
        };
        await repository<void>(request, 'createThread', [thread]);
        await emit(request, threadProjectId, 'thread.created', userId, 'thread', thread.id, {
          revisionId: thread.revisionId,
          reactNodeId: thread.reactNodeId,
          scenarioId: thread.scenarioId
        });
        return cors(request, json(thread, 201));
      }
      const commentThreadId = idFrom(url.pathname, /^\/v1\/threads\/([^/]+)\/comments$/);
      if (request.method === 'POST' && commentThreadId) {
        const input = await body(request);
        const parentThread = await repository<Thread | undefined>(request, 'getThread', [
          commentThreadId
        ]);
        if (!parentThread) throw new CollaborationError('NOT_FOUND', 'Thread not found');
        const userId = await requireProjectAccess(request, parentThread.projectId, 'commenter');
        const comment: Comment = {
          id: string(input.id ?? (await nextId(request, 'comment')), 'id'),
          threadId: commentThreadId,
          ...(typeof input.parentCommentId === 'string'
            ? { parentCommentId: input.parentCommentId }
            : {}),
          body: string(input.body, 'body'),
          createdBy: userId ?? 'guest',
          createdAt: await issuedAt(request),
          mentionedUserIds: strings(input.mentionedUserIds ?? [], 'mentionedUserIds')
        };
        await repository<void>(request, 'createComment', [comment]);
        await emit(
          request,
          parentThread.projectId,
          'comment.created',
          userId,
          'comment',
          comment.id,
          {
            threadId: commentThreadId
          }
        );
        return cors(request, json(comment, 201));
      }
      const resolveThreadId = idFrom(url.pathname, /^\/v1\/threads\/([^/]+)\/resolve$/);
      if (request.method === 'POST' && resolveThreadId) {
        const existing = await repository<Thread | undefined>(request, 'getThread', [
          resolveThreadId
        ]);
        if (!existing) throw new CollaborationError('NOT_FOUND', 'Thread not found');
        const userId = await requireProjectAccess(request, existing.projectId, 'commenter');
        const resolved = await repository<Thread>(request, 'updateThreadResolution', [
          resolveThreadId,
          userId ?? 'guest',
          await issuedAt(request)
        ]);
        await emit(
          request,
          existing.projectId,
          'thread.resolved',
          userId,
          'thread',
          resolved.id,
          {}
        );
        return cors(request, json(resolved));
      }
      const reactionCommentId = idFrom(url.pathname, /^\/v1\/comments\/([^/]+)\/reactions$/);
      if (request.method === 'POST' && reactionCommentId) {
        const input = await body(request);
        const comment = await repository<Comment | undefined>(request, 'getComment', [
          reactionCommentId
        ]);
        const thread = comment
          ? await repository<Thread | undefined>(request, 'getThread', [comment.threadId])
          : undefined;
        if (!thread) throw new CollaborationError('NOT_FOUND', 'Comment not found');
        const userId = await requireUserAuthorization(request, 'project:comment', {
          projectId: thread.projectId
        });
        const reaction: Reaction = {
          commentId: reactionCommentId,
          userId,
          emoji: string(input.emoji, 'emoji'),
          createdAt: await issuedAt(request)
        };
        await repository<void>(request, 'addReaction', [reaction]);
        await emit(
          request,
          thread.projectId,
          'reaction.added',
          reaction.userId,
          'comment',
          reactionCommentId,
          {
            emoji: reaction.emoji
          }
        );
        return cors(request, json(reaction, 201));
      }
      const approvalRevisionId = idFrom(url.pathname, /^\/v1\/revisions\/([^/]+)\/approvals$/);
      if (request.method === 'POST' && approvalRevisionId) {
        const input = await body(request);
        const revision = await repository<Revision | undefined>(request, 'getRevision', [
          approvalRevisionId
        ]);
        if (!revision) throw new CollaborationError('NOT_FOUND', 'Revision not found');
        const userId = await requireUserAuthorization(request, 'project:approve', {
          projectId: revision.projectId
        });
        const approval: Approval = {
          id: await nextId(request, 'approval'),
          revisionId: approvalRevisionId,
          userId,
          decision:
            input.decision === 'approved'
              ? 'approved'
              : input.decision === 'changes_requested'
                ? 'changes_requested'
                : (() => {
                    throw new CollaborationError(
                      'INVALID',
                      'decision must be approved or changes_requested'
                    );
                  })(),
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
          createdAt: await issuedAt(request)
        };
        await repository<void>(request, 'putApproval', [approval]);
        await emit(
          request,
          revision.projectId,
          'approval.updated',
          approval.userId,
          'revision',
          revision.id,
          {
            decision: approval.decision
          }
        );
        return cors(request, json(approval, 201));
      }
      const eventsProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsProjectId) {
        await requireProjectAccess(request, eventsProjectId, 'viewer');
        const after = cursor(url.searchParams.get('after') ?? request.headers.get('last-event-id'));
        const events = await repository<readonly import('./index.js').CollaborationEvent[]>(
          request,
          'listEvents',
          [eventsProjectId, after, limit(url.searchParams.get('limit'))]
        );
        return cors(
          request,
          json({
            events,
            nextCursor: events.at(-1)?.cursor ?? after,
            hasMore: events.length === limit(url.searchParams.get('limit'))
          })
        );
      }
      const eventStreamProjectId = idFrom(
        url.pathname,
        /^\/v1\/projects\/([^/]+)\/events\/stream$/
      );
      if (request.method === 'GET' && eventStreamProjectId) {
        await requireProjectAccess(request, eventStreamProjectId, 'viewer');
        const after = cursor(url.searchParams.get('after') ?? request.headers.get('last-event-id'));
        const initial = await repository<readonly import('./index.js').CollaborationEvent[]>(
          request,
          'listEvents',
          [eventStreamProjectId, after, 500]
        );
        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let lastCursor = after;
        let closed = false;
        let removeSubscriber = () => undefined;
        let removeAbortListener: () => void = () => undefined;
        const write = (event: import('./index.js').CollaborationEvent) => {
          if (
            closed ||
            !controller ||
            event.cursor <= lastCursor ||
            (controller.desiredSize !== null && controller.desiredSize <= 0)
          )
            return;
          lastCursor = event.cursor;
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.cursor}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`
              )
            );
          } catch {
            removeSubscriber();
          }
        };
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            const projectSubscribers = subscribers.get(eventStreamProjectId) ?? new Set();
            if (projectSubscribers.size >= collaborationBudgets.maxItems)
              throw new CollaborationError('CONFLICT', 'Event stream capacity is exhausted');

            // Register the removal path before observing initial events. A hostile
            // stream controller or signal implementation may throw synchronously;
            // in that case the subscriber must not remain retained in the project
            // fan-out set.
            removeSubscriber = () => {
              if (closed) return;
              closed = true;
              removeAbortListener();
              projectSubscribers.delete(write);
              if (projectSubscribers.size === 0) subscribers.delete(eventStreamProjectId);
            };
            projectSubscribers.add(write);
            subscribers.set(eventStreamProjectId, projectSubscribers);
            const abort = () => removeSubscriber();
            try {
              request.signal.addEventListener('abort', abort, { once: true });
              removeAbortListener = () => {
                try {
                  request.signal.removeEventListener('abort', abort);
                } catch {
                  // Listener cleanup is best effort and must not escape a stream.
                }
              };
              for (const event of initial) write(event);
            } catch (error) {
              removeSubscriber();
              if (isOwnedServiceError(error)) throw error;
              throw new CollaborationError('INVALID', 'Event stream could not be initialized');
            }
          },
          cancel() {
            removeSubscriber();
          }
        });
        return cors(
          request,
          new Response(stream, {
            headers: {
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'content-type': 'text/event-stream; charset=utf-8',
              'x-accel-buffering': 'no'
            }
          })
        );
      }
      const exportProjectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)\/export$/);
      if (request.method === 'GET' && exportProjectId) {
        await requireProjectAccess(request, exportProjectId, 'viewer');
        const snapshot = await repository<
          Awaited<ReturnType<CollaborationRepository['exportProject']>>
        >(request, 'exportProject', [exportProjectId]);
        if (!snapshot) throw new CollaborationError('NOT_FOUND', 'Project not found');
        return cors(
          request,
          new Response(serializeSnapshot(snapshot), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="${exportProjectId}.selene-collaboration.json"`
            }
          })
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/import') {
        const snapshot = await readSnapshot(request, maximumSnapshotBytes);
        const existing = await repository<Project | undefined>(request, 'getProject', [
          snapshot.project.id
        ]);
        const userId = await requireUserAuthorization(
          request,
          existing ? 'project:design' : 'organization:create-project',
          existing
            ? { projectId: snapshot.project.id }
            : { organizationId: snapshot.project.organizationId }
        );
        const result = await idempotent(
          options.repository,
          `import:${userId}:${snapshot.project.id}`,
          request.headers.get('idempotency-key') ?? undefined,
          async () => {
            await repository<void>(request, 'replaceProject', [
              snapshot,
              {
                ...(request.headers.get('x-selene-expected-revision-id') === null
                  ? {}
                  : {
                      expectedLatestRevisionId: request.headers.get(
                        'x-selene-expected-revision-id'
                      )!
                    }),
                context: contextFor(request)
              }
            ]);
            await emit(
              request,
              snapshot.project.id,
              'project.imported',
              userId,
              'project',
              snapshot.project.id,
              {}
            );
            return { projectId: snapshot.project.id, imported: true };
          },
          contextFor(request)
        );
        return cors(request, json(result, 201));
      }
      if (request.method === 'POST' && url.pathname === '/v1/sync') {
        const snapshot = await readSnapshot(request, maximumSnapshotBytes);
        const existing = await repository<
          Awaited<ReturnType<CollaborationRepository['exportProject']>>
        >(request, 'exportProject', [snapshot.project.id]);
        const userId = await requireUserAuthorization(
          request,
          existing ? 'project:design' : 'organization:create-project',
          existing
            ? { projectId: snapshot.project.id }
            : { organizationId: snapshot.project.organizationId }
        );
        const result = await idempotent(
          options.repository,
          `sync:${userId}:${snapshot.project.id}`,
          request.headers.get('idempotency-key') ?? undefined,
          async () => {
            await repository<void>(request, 'replaceProject', [
              snapshot,
              {
                ...(request.headers.get('x-selene-expected-revision-id') === null
                  ? {}
                  : {
                      expectedLatestRevisionId: request.headers.get(
                        'x-selene-expected-revision-id'
                      )!
                    }),
                context: contextFor(request)
              }
            ]);
            await emit(
              request,
              snapshot.project.id,
              'project.synchronized',
              userId,
              'project',
              snapshot.project.id,
              {
                replaced: existing !== undefined,
                revisions: snapshot.revisions.length
              }
            );
            return {
              projectId: snapshot.project.id,
              synchronized: true,
              replaced: existing !== undefined,
              revisions: snapshot.revisions.length
            };
          },
          contextFor(request)
        );
        return cors(request, json(result));
      }
      const shareLinkId = idFrom(url.pathname, /^\/v1\/share-links\/([^/]+)$/);
      if (request.method === 'DELETE' && shareLinkId) {
        const link = await repository<Awaited<ReturnType<CollaborationRepository['getShareLink']>>>(
          request,
          'getShareLink',
          [shareLinkId]
        );
        if (!link) throw new CollaborationError('NOT_FOUND', 'Share link not found');
        const userId = await requireUserAuthorization(request, 'project:manage-sharing', {
          projectId: link.projectId
        });
        await repository<void>(request, 'revokeShareLink', [shareLinkId, await issuedAt(request)]);
        await emit(
          request,
          link.projectId,
          'share_link.revoked',
          userId,
          'share_link',
          shareLinkId,
          {}
        );
        return cors(request, new Response(null, { status: 204 }));
      }
      const projectId = idFrom(url.pathname, /^\/v1\/projects\/([^/]+)$/);
      if (request.method === 'DELETE' && projectId) {
        const project = await repository<Project | undefined>(request, 'getProject', [projectId]);
        if (!project) throw new CollaborationError('NOT_FOUND', 'Project not found');
        const userId = await requireUserAuthorization(request, 'project:delete', { projectId });
        await emit(request, projectId, 'project.deleted', userId, 'project', projectId, {});
        await repository<void>(request, 'deleteProject', [projectId]);
        return cors(request, new Response(null, { status: 204 }));
      }
      return cors(request, json({ error: 'not_found' }, 404));
    } catch (error) {
      metrics.errors += 1;
      if (isOwnedServiceUnavailableError(error))
        return cors(request, json({ error: 'service_unavailable' }, 503));
      if (isOwnedServiceError(error)) {
        const status =
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'CONFLICT'
              ? 409
              : error.code === 'FORBIDDEN'
                ? 403
                : 400;
        return cors(
          request,
          json({ error: error.code.toLowerCase(), message: error.message }, status)
        );
      }
      return cors(request, json({ error: 'internal_error' }, 500));
    } finally {
      if (context) {
        contexts.delete(request);
        try {
          context.dispose();
        } catch {
          // Context cleanup is hostile-host best effort and must not reject the response path.
        }
      }
    }
  };
}
