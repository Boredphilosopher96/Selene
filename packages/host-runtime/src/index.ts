/** Runtime-neutral admission and lifetime supervision for host-owned effects. */
export const hostRuntimePackageName = '@selene/host-runtime';

export type HostEffectErrorCode =
  | 'CALLER_ABORTED'
  | 'DEADLINE_EXCEEDED'
  | 'EFFECT_FAILED'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_EFFECT_METHOD'
  | 'INVALID_OPTIONS'
  | 'INVALID_OWNER'
  | 'OWNER_CAPACITY_REACHED'
  | 'OWNER_QUARANTINED'
  | 'OWNER_STILL_ACTIVE'
  | 'PROCESS_CAPACITY_REACHED';

export type HostCallCancellationReason = 'caller-aborted' | 'deadline-exceeded';

const messages: Readonly<Record<HostEffectErrorCode, string>> = Object.freeze({
  CALLER_ABORTED: 'host effect caller was aborted',
  DEADLINE_EXCEEDED: 'host effect caller deadline expired',
  EFFECT_FAILED: 'host effect failed',
  INVALID_CONFIGURATION: 'host effect supervisor configuration is invalid',
  INVALID_EFFECT_METHOD: 'host effect method is invalid',
  INVALID_OPTIONS: 'host effect options are invalid',
  INVALID_OWNER: 'host effect owner is invalid',
  OWNER_CAPACITY_REACHED: 'host effect owner admission limit reached',
  OWNER_QUARANTINED: 'host effect owner is quarantined',
  OWNER_STILL_ACTIVE: 'host effect owner still has active reservations',
  PROCESS_CAPACITY_REACHED: 'host effect process admission limit reached'
});
const errorCodes = new Set<HostEffectErrorCode>(Object.keys(messages) as HostEffectErrorCode[]);

const issuedErrors = new WeakSet<object>();

export class HostEffectSupervisorError extends Error {
  public readonly code: HostEffectErrorCode;

  public constructor(code: unknown) {
    if (!errorCodes.has(code as HostEffectErrorCode))
      throw new TypeError('host effect supervisor error code is invalid');
    const checkedCode = code as HostEffectErrorCode;
    super(messages[checkedCode]);
    this.name = 'HostEffectSupervisorError';
    this.code = checkedCode;
  }
}

export interface HostRuntimeClock {
  now(): number;
}

export interface HostRuntimeScheduler {
  schedule(delayMs: number, task: () => void): { cancel(): void };
}

/** Small own-data cancellation port; browser and Node signal objects are not trusted directly. */
export interface HostEffectCancellationSignal {
  isAborted(): boolean;
  addAbortListener(listener: () => void): void;
  removeAbortListener(listener: () => void): void;
}

export interface HostCallContext {
  readonly ownerGeneration: number;
  readonly deadlineMs?: number;
  readonly cancellation: HostCallCancellationSignal;
}

/** A bounded, supervisor-owned cancellation surface for the active call only. */
export interface HostCallCancellationSignal {
  isCancellationRequested(): boolean;
  reason(): HostCallCancellationReason | undefined;
  subscribe(listener: (reason: HostCallCancellationReason) => void): () => void;
}

export interface HostEffectAdmissionPool {
  readonly __hostEffectAdmissionPool?: never;
}

export interface HostEffectSupervisorOptions {
  readonly __hostEffectSupervisorOptions?: never;
}

export interface HostEffectRequestOptions {
  readonly deadlineMs?: number;
  readonly signal?: HostEffectCancellationSignal;
}

export interface HostEffectOwnerStatus {
  readonly activeReservations: number;
  readonly quarantined: boolean;
  readonly generation: number;
}

export interface HostEffectLifecycleEvidence {
  readonly activeProcessReservations: number;
  readonly lastObservedNowMs?: number;
  readonly owner: HostEffectOwnerStatus;
}

type ExactMethod = (...arguments_: readonly unknown[]) => unknown;
type InternalError = HostEffectSupervisorError;

interface OwnerState {
  activeReservations: number;
  quarantined: boolean;
  generation: number;
  idleEpoch: IdleEpoch;
}

/** One shared promise for the current non-idle owner epoch; never retains individual callers. */
interface IdleEpoch {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface PoolState {
  activeReservations: number;
  lastNow?: number;
  nextGeneration: number;
  readonly clockTarget: object;
  readonly clockNow: ExactMethod;
  readonly maxConcurrentEffects: number;
  readonly maxConcurrentEffectsPerOwner: number;
  readonly owners: WeakMap<object, OwnerState>;
}

interface SupervisorState {
  readonly pool: HostEffectAdmissionPool;
  readonly schedulerTarget: object;
  readonly schedulerSchedule: ExactMethod;
}

interface CapturedSignal {
  readonly target: object;
  readonly isAborted: ExactMethod;
  readonly add: ExactMethod;
  readonly remove: ExactMethod;
}

interface CapturedRequest {
  readonly deadlineMs?: number;
  readonly signal?: CapturedSignal;
}

const MAX_ARGUMENTS = 64;
const MAX_LIMIT = 65_536;
const MAX_CONTEXT_SUBSCRIBERS = 32;
const poolStates = new WeakMap<object, PoolState>();
const supervisorStates = new WeakMap<object, SupervisorState>();
const emptyArguments: readonly unknown[] = Object.freeze([]);

function fail(code: HostEffectErrorCode): InternalError {
  const error = new HostEffectSupervisorError(code);
  issuedErrors.add(error);
  return error;
}

function isInternal(error: unknown): error is InternalError {
  return typeof error === 'object' && error !== null && issuedErrors.has(error);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function validLimit(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT
  );
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function dataRecord(
  value: unknown,
  keys: readonly string[],
  code: HostEffectErrorCode
): Readonly<Record<string, unknown>> {
  if (!isObject(value) || typeof value === 'function') throw fail(code);
  try {
    const prototype = Object.getPrototypeOf(value);
    const actual = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      actual.length !== keys.length ||
      actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      throw fail(code);
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        throw fail(code);
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    throw fail(code);
  }
}

function optionalDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(value) || typeof value === 'function') throw fail('INVALID_OPTIONS');
  try {
    const prototype = Object.getPrototypeOf(value);
    const actual = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      actual.some((key) => key !== 'deadlineMs' && key !== 'signal')
    )
      throw fail('INVALID_OPTIONS');
    const copy: Record<string, unknown> = {};
    for (const key of ['deadlineMs', 'signal']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw fail('INVALID_OPTIONS');
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    throw fail('INVALID_OPTIONS');
  }
}

function port(
  value: unknown,
  keys: readonly string[],
  code: HostEffectErrorCode
): Readonly<{ target: object; methods: Readonly<Record<string, ExactMethod>> }> {
  const record = dataRecord(value, keys, code);
  const methods: Record<string, ExactMethod> = {};
  for (const key of keys) {
    if (typeof record[key] !== 'function') throw fail(code);
    methods[key] = record[key] as ExactMethod;
  }
  return Object.freeze({ target: value as object, methods: Object.freeze(methods) });
}

function captureSignal(value: unknown): CapturedSignal {
  const captured = port(
    value,
    ['isAborted', 'addAbortListener', 'removeAbortListener'],
    'INVALID_OPTIONS'
  );
  return Object.freeze({
    target: captured.target,
    isAborted: captured.methods.isAborted as ExactMethod,
    add: captured.methods.addAbortListener as ExactMethod,
    remove: captured.methods.removeAbortListener as ExactMethod
  });
}

function signalAborted(signal: CapturedSignal): boolean {
  try {
    const value = Reflect.apply(signal.isAborted, signal.target, emptyArguments);
    if (typeof value !== 'boolean') throw fail('INVALID_OPTIONS');
    return value;
  } catch {
    throw fail('INVALID_OPTIONS');
  }
}

function argumentsSnapshot(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw fail('INVALID_OPTIONS');
  try {
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      length === undefined ||
      !Object.prototype.hasOwnProperty.call(length, 'value') ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > MAX_ARGUMENTS
    )
      throw fail('INVALID_OPTIONS');
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        throw fail('INVALID_OPTIONS');
      copy.push(descriptor.value);
    }
    return Object.freeze(copy);
  } catch {
    throw fail('INVALID_OPTIONS');
  }
}

function ownerMethod(owner: object, name: string): ExactMethod {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128 || name.includes('\0'))
    throw fail('INVALID_EFFECT_METHOD');
  try {
    let current: object | null = owner;
    for (let depth = 0; current !== null && depth < 32; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value'))
          throw fail('INVALID_EFFECT_METHOD');
        if (typeof descriptor.value !== 'function') throw fail('INVALID_EFFECT_METHOD');
        return descriptor.value as ExactMethod;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  throw fail('INVALID_EFFECT_METHOD');
}

function requestSnapshot(value: HostEffectRequestOptions | undefined): CapturedRequest {
  if (value === undefined) return Object.freeze({});
  const record = optionalDataRecord(value);
  if (record.deadlineMs !== undefined && !validTime(record.deadlineMs))
    throw fail('INVALID_OPTIONS');
  const signal = record.signal === undefined ? undefined : captureSignal(record.signal);
  return Object.freeze({
    ...(record.deadlineMs === undefined ? {} : { deadlineMs: record.deadlineMs as number }),
    ...(signal === undefined ? {} : { signal })
  });
}

export function createHostEffectAdmissionPool(value: unknown): HostEffectAdmissionPool {
  const record = dataRecord(
    value,
    ['clock', 'maxConcurrentEffects', 'maxConcurrentEffectsPerOwner'],
    'INVALID_CONFIGURATION'
  );
  if (!validLimit(record.maxConcurrentEffects) || !validLimit(record.maxConcurrentEffectsPerOwner))
    throw fail('INVALID_CONFIGURATION');
  const clock = port(record.clock, ['now'], 'INVALID_CONFIGURATION');
  const pool = Object.freeze({}) as HostEffectAdmissionPool;
  poolStates.set(pool, {
    activeReservations: 0,
    clockTarget: clock.target,
    clockNow: clock.methods.now as ExactMethod,
    maxConcurrentEffects: record.maxConcurrentEffects,
    maxConcurrentEffectsPerOwner: record.maxConcurrentEffectsPerOwner,
    nextGeneration: 0,
    owners: new WeakMap()
  });
  return pool;
}

export function createHostEffectSupervisorOptions(value: unknown): HostEffectSupervisorOptions {
  const record = dataRecord(value, ['admissionPool', 'scheduler'], 'INVALID_CONFIGURATION');
  if (!isObject(record.admissionPool) || !poolStates.has(record.admissionPool))
    throw fail('INVALID_CONFIGURATION');
  const scheduler = port(record.scheduler, ['schedule'], 'INVALID_CONFIGURATION');
  const options = Object.freeze({}) as HostEffectSupervisorOptions;
  supervisorStates.set(
    options,
    Object.freeze({
      pool: record.admissionPool as HostEffectAdmissionPool,
      schedulerTarget: scheduler.target,
      schedulerSchedule: scheduler.methods.schedule as ExactMethod
    })
  );
  return options;
}

function poolState(pool: HostEffectAdmissionPool): PoolState {
  const state = isObject(pool) ? poolStates.get(pool) : undefined;
  if (state === undefined) throw fail('INVALID_CONFIGURATION');
  return state;
}

function now(pool: HostEffectAdmissionPool): number {
  const state = poolState(pool);
  try {
    const value = Reflect.apply(state.clockNow, state.clockTarget, emptyArguments);
    if (!validTime(value) || (state.lastNow !== undefined && value < state.lastNow))
      throw fail('INVALID_CONFIGURATION');
    state.lastNow = value;
    return value;
  } catch {
    throw fail('INVALID_CONFIGURATION');
  }
}

function ownerState(
  pool: HostEffectAdmissionPool,
  owner: object,
  create: boolean
): OwnerState | undefined {
  const state = poolState(pool);
  const existing = state.owners.get(owner);
  if (existing !== undefined || !create) return existing;
  const created = {
    activeReservations: 0,
    generation: ++state.nextGeneration,
    quarantined: false,
    idleEpoch: resolvedIdleEpoch()
  };
  state.owners.set(owner, created);
  return created;
}

function resolvedIdleEpoch(): IdleEpoch {
  return Object.freeze({ promise: Promise.resolve(), resolve: () => undefined });
}

function activeIdleEpoch(): IdleEpoch {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return Object.freeze({ promise, resolve });
}

function reserve(pool: HostEffectAdmissionPool, owner: object): OwnerState {
  const state = poolState(pool);
  const ownerLifecycle = ownerState(pool, owner, true) as OwnerState;
  if (ownerLifecycle.quarantined) throw fail('OWNER_QUARANTINED');
  if (ownerLifecycle.activeReservations >= state.maxConcurrentEffectsPerOwner)
    throw fail('OWNER_CAPACITY_REACHED');
  if (state.activeReservations >= state.maxConcurrentEffects)
    throw fail('PROCESS_CAPACITY_REACHED');
  if (ownerLifecycle.activeReservations === 0) ownerLifecycle.idleEpoch = activeIdleEpoch();
  ownerLifecycle.activeReservations += 1;
  state.activeReservations += 1;
  return ownerLifecycle;
}

function release(pool: HostEffectAdmissionPool, owner: OwnerState): void {
  const state = poolState(pool);
  owner.activeReservations -= 1;
  state.activeReservations -= 1;
  if (owner.activeReservations === 0) owner.idleEpoch.resolve();
}

export function readHostEffectLifecycle(
  pool: HostEffectAdmissionPool,
  owner: object
): HostEffectLifecycleEvidence {
  if (!isObject(owner)) throw fail('INVALID_OWNER');
  const state = poolState(pool);
  const lifecycle = ownerState(pool, owner, false);
  return Object.freeze({
    activeProcessReservations: state.activeReservations,
    ...(state.lastNow === undefined ? {} : { lastObservedNowMs: state.lastNow }),
    owner: Object.freeze({
      activeReservations: lifecycle?.activeReservations ?? 0,
      generation: lifecycle?.generation ?? 0,
      quarantined: lifecycle?.quarantined ?? false
    })
  });
}

export class HostEffectSupervisor {
  private readonly state: SupervisorState;

  public constructor(options: HostEffectSupervisorOptions) {
    const state = isObject(options) ? supervisorStates.get(options) : undefined;
    if (state === undefined) throw fail('INVALID_CONFIGURATION');
    this.state = state;
  }

  public status(owner: object): HostEffectOwnerStatus {
    return readHostEffectLifecycle(this.state.pool, owner).owner;
  }

  public recoverOwner(owner: object): void {
    if (!isObject(owner)) throw fail('INVALID_OWNER');
    const state = ownerState(this.state.pool, owner, false);
    if (state === undefined || !state.quarantined) return;
    if (state.activeReservations !== 0) throw fail('OWNER_STILL_ACTIVE');
    state.quarantined = false;
    state.generation += 1;
  }

  /** Shared active-epoch promise; resolves only after this owner's actual reservations settle. */
  public whenOwnerIdle(owner: object): Promise<void> {
    try {
      if (!isObject(owner)) throw fail('INVALID_OWNER');
      const lifecycle = ownerState(this.state.pool, owner, false);
      return lifecycle === undefined ? Promise.resolve() : lifecycle.idleEpoch.promise;
    } catch (error) {
      return Promise.reject(isInternal(error) ? error : fail('INVALID_OWNER'));
    }
  }

  public run<T>(
    owner: object,
    methodName: string,
    arguments_: unknown = emptyArguments,
    options?: HostEffectRequestOptions
  ): Promise<T> {
    try {
      if (!isObject(owner)) throw fail('INVALID_OWNER');
      const args = argumentsSnapshot(arguments_);
      const request = requestSnapshot(options);
      if (request.signal !== undefined && signalAborted(request.signal))
        throw fail('CALLER_ABORTED');
      const current = now(this.state.pool);
      if (request.deadlineMs !== undefined && request.deadlineMs <= current)
        throw fail('DEADLINE_EXCEEDED');
      const method = ownerMethod(owner, methodName);
      const lifecycle = reserve(this.state.pool, owner);
      return this.invoke(owner, method, args, lifecycle, request);
    } catch (error) {
      return Promise.reject(isInternal(error) ? error : fail('INVALID_OPTIONS'));
    }
  }

  private invoke<T>(
    owner: object,
    method: ExactMethod,
    args: readonly unknown[],
    lifecycle: OwnerState,
    request: CapturedRequest
  ): Promise<T> {
    let started = false;
    let effectSettled = false;
    let callerSettled = false;
    let released = false;
    let cleaned = false;
    let initializing = true;
    let contextActive = true;
    let cancellationReason: HostCallCancellationReason | undefined;
    let pending: 'CALLER_ABORTED' | 'DEADLINE_EXCEEDED' | undefined;
    let timer: Readonly<{ target: object; cancel: ExactMethod }> | undefined;
    let listener: (() => void) | undefined;
    const subscribers = new Set<(reason: HostCallCancellationReason) => void>();
    const cancellation = Object.freeze({
      isCancellationRequested: () => cancellationReason !== undefined,
      reason: () => cancellationReason,
      subscribe: (subscriber: (reason: HostCallCancellationReason) => void) => {
        if (typeof subscriber !== 'function')
          throw new TypeError('host call cancellation listener is invalid');
        // A retained context never calls back after cancellation or closure.
        // The stable reason remains readable through `reason()`.
        if (cancellationReason !== undefined || !contextActive) return () => undefined;
        if (subscribers.size >= MAX_CONTEXT_SUBSCRIBERS)
          throw new RangeError('host call cancellation subscriber limit reached');
        subscribers.add(subscriber);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          subscribers.delete(subscriber);
        };
      }
    }) as HostCallCancellationSignal;
    const context = Object.freeze({
      ownerGeneration: lifecycle.generation,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
      cancellation
    }) as HostCallContext;
    const requestCancellation = (code: 'CALLER_ABORTED' | 'DEADLINE_EXCEEDED') => {
      if (cancellationReason !== undefined) return;
      cancellationReason = code === 'CALLER_ABORTED' ? 'caller-aborted' : 'deadline-exceeded';
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(cancellationReason);
        } catch {}
      }
      subscribers.clear();
    };
    const releaseReservation = () => {
      if (released) return;
      released = true;
      release(this.state.pool, lifecycle);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      contextActive = false;
      subscribers.clear();
      if (timer !== undefined) {
        try {
          Reflect.apply(timer.cancel, timer.target, emptyArguments);
        } catch {}
      }
      if (listener !== undefined && request.signal !== undefined) {
        try {
          Reflect.apply(request.signal.remove, request.signal.target, [listener]);
        } catch {}
      }
    };

    return new Promise<T>((resolve, reject) => {
      const settleCaller = (code: HostEffectErrorCode, quarantine: boolean) => {
        if (callerSettled) return;
        callerSettled = true;
        cleanup();
        if (quarantine) lifecycle.quarantined = true;
        reject(fail(code));
      };
      const beforeStart = (code: HostEffectErrorCode) => {
        if (effectSettled || started) return;
        effectSettled = true;
        releaseReservation();
        settleCaller(code, false);
      };
      const abandon = (code: 'CALLER_ABORTED' | 'DEADLINE_EXCEEDED') => {
        if (callerSettled || effectSettled) return;
        requestCancellation(code);
        if (initializing) {
          pending ??= code;
          return;
        }
        if (!started) {
          beforeStart(code);
          return;
        }
        settleCaller(code, true);
      };
      const settleEffect = (result: { ok: true; value: T } | { ok: false }) => {
        if (effectSettled) return;
        effectSettled = true;
        releaseReservation();
        if (callerSettled) return;
        callerSettled = true;
        cleanup();
        if (result.ok) resolve(result.value);
        else reject(fail('EFFECT_FAILED'));
      };

      let setupFailure: HostEffectErrorCode | undefined;
      if (request.signal !== undefined) {
        try {
          listener = () => abandon('CALLER_ABORTED');
          Reflect.apply(request.signal.add, request.signal.target, [listener]);
          if (signalAborted(request.signal)) pending ??= 'CALLER_ABORTED';
        } catch {
          setupFailure = 'INVALID_OPTIONS';
        }
      }
      if (setupFailure === undefined && request.deadlineMs !== undefined) {
        try {
          const delay = request.deadlineMs - now(this.state.pool);
          if (delay <= 0) pending ??= 'DEADLINE_EXCEEDED';
          else {
            const handle = Reflect.apply(this.state.schedulerSchedule, this.state.schedulerTarget, [
              delay,
              () => abandon('DEADLINE_EXCEEDED')
            ]);
            const captured = port(handle, ['cancel'], 'INVALID_CONFIGURATION');
            timer = Object.freeze({
              target: captured.target,
              cancel: captured.methods.cancel as ExactMethod
            });
          }
        } catch {
          setupFailure = 'INVALID_CONFIGURATION';
        }
      }
      initializing = false;
      if (setupFailure !== undefined) {
        beforeStart(setupFailure);
        return;
      }
      if (pending !== undefined) {
        beforeStart(pending);
        return;
      }
      started = true;
      const callArguments: unknown[] = [context];
      for (const argument of args) callArguments.push(argument);
      let returned: unknown;
      try {
        returned = Reflect.apply(method, owner, callArguments);
      } catch {
        settleEffect({ ok: false });
        return;
      }
      try {
        Promise.resolve(returned).then(
          (value) => settleEffect({ ok: true, value: value as T }),
          () => settleEffect({ ok: false })
        );
      } catch {
        settleEffect({ ok: false });
      }
    });
  }
}
