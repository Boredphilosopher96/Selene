import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor,
  isHostEffectSupervisorError,
  type HostEffectCancellationSignal,
  type HostRuntimeClock,
  type HostRuntimeScheduler
} from '@selene/host-runtime';
import {
  CollaborationBoundaryError,
  type CollaborationHostContext,
  type CollaborationHostContextFactory
} from '@selene/collaboration';

type ContextOptions = { readonly signal?: AbortSignal; readonly timeoutMs: number };
type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface HostEffectContextFactoryOptions {
  readonly clock?: HostRuntimeClock;
  readonly scheduler?: HostRuntimeScheduler;
  readonly maxConcurrentEffects?: number;
  readonly maxConcurrentEffectsPerOwner?: number;
  readonly maxMethodsPerPort?: number;
  /** Trusted composition hook used to acknowledge actual supervisor reservation release. */
  readonly onPortSettled?: (port: object, method: string) => void;
}

interface Invocation {
  started: boolean;
  settled: boolean;
  readonly operation: () => Promise<unknown>;
  readonly cancel: () => void;
}

interface StableOwner {
  readonly owner: object;
  readonly invocations: Map<number, Invocation>;
  nextInvocation: number;
  readonly onSettled?: () => void;
  watchedIdleEpoch: Promise<void> | undefined;
}

const systemClock: HostRuntimeClock = { now: () => Date.now() };
const systemScheduler: HostRuntimeScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    return { cancel: () => clearTimeout(timer) };
  }
};

const maxPrototypeDepth = 8;
const validMethodName = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const maxConcurrentEffects = 256;
const maxConcurrentEffectsPerOwner = 64;
const maxMethodsPerPort = 128;
const maxHostTimeoutMs = 60_000;
type CapturedCallable = (...arguments_: readonly unknown[]) => unknown;

function signalFor(signal: AbortSignal): HostEffectCancellationSignal {
  return {
    isAborted: () => signal.aborted,
    addAbortListener(listener) {
      signal.addEventListener('abort', listener, { once: true });
    },
    removeAbortListener(listener) {
      signal.removeEventListener('abort', listener);
    }
  };
}

function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object')
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new CollaborationBoundaryError('Host effect configuration is invalid');
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor))
        throw new CollaborationBoundaryError('Host effect configuration is invalid');
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  }
}

function inheritedMethod(
  value: unknown,
  key: string
): Readonly<{ target: object; method: CapturedCallable }> {
  if (value === null || typeof value !== 'object')
    throw new CollaborationBoundaryError('Host effect signal is invalid');
  const source = value;
  const seen = new WeakSet<object>();
  let candidate: object | null = source;
  try {
    for (let depth = 0; candidate !== null && depth <= maxPrototypeDepth; depth += 1) {
      if (seen.has(candidate))
        throw new CollaborationBoundaryError('Host effect signal is invalid');
      seen.add(candidate);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function')
          throw new CollaborationBoundaryError('Host effect signal is invalid');
        return Object.freeze({ target: source, method: descriptor.value });
      }
      candidate = Object.getPrototypeOf(candidate);
    }
  } catch {
    throw new CollaborationBoundaryError('Host effect signal is invalid');
  }
  throw new CollaborationBoundaryError('Host effect signal is invalid');
}

function initialAbortState(value: object): boolean {
  const seen = new WeakSet<object>();
  let candidate: object | null = value;
  try {
    for (let depth = 0; candidate !== null && depth <= maxPrototypeDepth; depth += 1) {
      if (seen.has(candidate))
        throw new CollaborationBoundaryError('Host effect signal is invalid');
      seen.add(candidate);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, 'aborted');
      if (descriptor !== undefined) {
        const aborted =
          'value' in descriptor
            ? descriptor.value
            : typeof descriptor.get === 'function'
              ? Reflect.apply(descriptor.get, value, [])
              : undefined;
        if (typeof aborted !== 'boolean')
          throw new CollaborationBoundaryError('Host effect signal is invalid');
        return aborted;
      }
      candidate = Object.getPrototypeOf(candidate);
    }
  } catch {
    throw new CollaborationBoundaryError('Host effect signal is invalid');
  }
  throw new CollaborationBoundaryError('Host effect signal is invalid');
}

function captureAbortSignal(value: unknown):
  | Readonly<{
      readonly aborted: boolean;
      add(listener: () => void): void;
      remove(listener: () => void): void;
    }>
  | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object')
    throw new CollaborationBoundaryError('Host effect signal is invalid');
  const add = inheritedMethod(value, 'addEventListener');
  const remove = inheritedMethod(value, 'removeEventListener');
  const aborted = initialAbortState(value);
  return Object.freeze({
    aborted,
    add(listener) {
      try {
        Reflect.apply(add.method, add.target, ['abort', listener, { once: true }]);
      } catch {
        throw new CollaborationBoundaryError('Host effect signal is invalid');
      }
    },
    remove(listener) {
      try {
        Reflect.apply(remove.method, remove.target, ['abort', listener]);
      } catch {
        // Cleanup must never make the response path hang or leak hostile errors.
      }
    }
  });
}

function positiveLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  return value;
}

function capturedMethod(
  value: unknown,
  key: string
): Readonly<{ target: object; method: CapturedCallable }> {
  if (value === null || typeof value !== 'object')
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
      throw new CollaborationBoundaryError('Host effect configuration is invalid');
    return Object.freeze({ target: value, method: descriptor.value });
  } catch {
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  }
}

function stableOwner(onSettled?: () => void): StableOwner {
  const invocations = new Map<number, Invocation>();
  const state: StableOwner = {
    invocations,
    nextInvocation: 0,
    watchedIdleEpoch: undefined,
    ...(onSettled === undefined ? {} : { onSettled }),
    owner: {
      run(
        hostContext: { readonly cancellation: { subscribe(listener: () => void): () => void } },
        id: number
      ) {
        const invocation = invocations.get(id);
        if (!invocation) throw new CollaborationBoundaryError('Host operation failed');
        invocation.started = true;
        let unsubscribe: (() => void) | undefined;
        try {
          const candidate = hostContext.cancellation.subscribe(invocation.cancel);
          if (typeof candidate !== 'function')
            throw new CollaborationBoundaryError('Host operation failed');
          unsubscribe = candidate;
        } catch {
          invocation.settled = true;
          invocations.delete(id);
          throw new CollaborationBoundaryError('Host operation failed');
        }
        return Promise.resolve()
          .then(invocation.operation)
          .then(
            (value): Outcome<unknown> => ({ ok: true, value }),
            (): Outcome<unknown> => ({
              ok: false,
              error: new CollaborationBoundaryError('Host operation failed')
            })
          )
          .finally(() => {
            invocation.settled = true;
            invocations.delete(id);
            try {
              unsubscribe?.();
            } catch {
              // Supervisor-owned cancellation cleanup is best effort.
            }
          });
      }
    }
  };
  return state;
}

function failure(error: { readonly code: string }): CollaborationBoundaryError {
  if (error.code === 'CALLER_ABORTED' || error.code === 'DEADLINE_EXCEEDED')
    return new CollaborationBoundaryError('Host operation was cancelled');
  return new CollaborationBoundaryError('Host operation failed');
}

/**
 * Composes host-runtime only in the trusted service process. Owners are stable
 * for the real adapter port/method, so admission, quarantine, and generations
 * remain meaningful across requests.
 */
export function createHostEffectContextFactory(
  options: HostEffectContextFactoryOptions = {}
): CollaborationHostContextFactory {
  const option = dataRecord(options, [
    'clock',
    'scheduler',
    'maxConcurrentEffects',
    'maxConcurrentEffectsPerOwner',
    'maxMethodsPerPort',
    'onPortSettled'
  ]);
  const onPortSettled = option.onPortSettled;
  if (onPortSettled !== undefined && typeof onPortSettled !== 'function')
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  const rawClock = option.clock ?? systemClock;
  const rawScheduler = option.scheduler ?? systemScheduler;
  const clockMethod = capturedMethod(rawClock, 'now');
  const schedulerMethod = capturedMethod(rawScheduler, 'schedule');
  let lastNow = -1;
  const clock: HostRuntimeClock = {
    now: () => {
      try {
        const now: unknown = Reflect.apply(clockMethod.method, clockMethod.target, []);
        if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0 || now < lastNow)
          throw new CollaborationBoundaryError('Host effect clock is invalid');
        lastNow = now;
        return now;
      } catch {
        throw new CollaborationBoundaryError('Host effect clock is invalid');
      }
    }
  };
  const scheduler: HostRuntimeScheduler = {
    schedule: (delay, task) => {
      try {
        const handle = Reflect.apply(schedulerMethod.method, schedulerMethod.target, [delay, task]);
        const cancel = capturedMethod(handle, 'cancel');
        return Object.freeze({
          cancel: () => {
            try {
              Reflect.apply(cancel.method, cancel.target, []);
            } catch {
              // Timer cleanup is best effort and never escapes a collaboration boundary.
            }
          }
        });
      } catch {
        throw new CollaborationBoundaryError('Host effect scheduler is invalid');
      }
    }
  };
  const methodsPerPort = positiveLimit(option.maxMethodsPerPort, 128, maxMethodsPerPort);
  const concurrentEffects = positiveLimit(option.maxConcurrentEffects, 128, maxConcurrentEffects);
  const concurrentEffectsPerOwner = positiveLimit(
    option.maxConcurrentEffectsPerOwner,
    16,
    maxConcurrentEffectsPerOwner
  );
  if (concurrentEffectsPerOwner > concurrentEffects)
    throw new CollaborationBoundaryError('Host effect configuration is invalid');
  const admissionPool = createHostEffectAdmissionPool({
    clock,
    maxConcurrentEffects: concurrentEffects,
    maxConcurrentEffectsPerOwner: concurrentEffectsPerOwner
  });
  const supervisor = new HostEffectSupervisor(
    createHostEffectSupervisorOptions({
      admissionPool,
      scheduler
    })
  );
  const observePortSettlement =
    onPortSettled === undefined
      ? undefined
      : (port: object, method: string) => {
          try {
            Reflect.apply(onPortSettled, undefined, [port, method]);
          } catch {
            // Observability cannot affect the supervised host boundary.
          }
        };
  const ports = new WeakMap<object, Map<string, StableOwner>>();
  const ownerFor = (port: object, method: string): StableOwner => {
    if (!validMethodName.test(method)) throw new CollaborationBoundaryError('Host port is invalid');
    let methods = ports.get(port);
    if (!methods) {
      methods = new Map();
      ports.set(port, methods);
    }
    let owner = methods.get(method);
    if (!owner) {
      if (methods.size >= methodsPerPort)
        throw new CollaborationBoundaryError('Host port method capacity is exhausted');
      owner = stableOwner(
        onPortSettled === undefined ? undefined : () => observePortSettlement?.(port, method)
      );
      methods.set(method, owner);
    }
    // A timed-out owner remains quarantined until its actual work settles.
    // Once every reservation is released, recover the same stable owner: the
    // supervisor advances its generation while the bounded port/method map
    // retains one identity for future admission accounting.
    try {
      const status = supervisor.status(owner.owner);
      if (status.quarantined && status.activeReservations === 0)
        supervisor.recoverOwner(owner.owner);
    } catch {
      throw new CollaborationBoundaryError('Host operation failed');
    }
    return owner;
  };

  return Object.freeze({
    create(request: ContextOptions): CollaborationHostContext {
      const requestData = dataRecord(request, ['signal', 'timeoutMs']);
      const timeoutMs = requestData.timeoutMs as unknown;
      if (
        typeof timeoutMs !== 'number' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > maxHostTimeoutMs
      )
        throw new CollaborationBoundaryError('Host timeout is invalid');
      const signal = captureAbortSignal(requestData.signal);
      const controller = new AbortController();
      const startedAt = clock.now();
      if (startedAt > Number.MAX_SAFE_INTEGER - timeoutMs)
        throw new CollaborationBoundaryError('Host timeout is invalid');
      const deadlineAt = startedAt + timeoutMs;
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.add(abort);
      const contextOwner = stableOwner();
      const execute = async <T>(owner: StableOwner, operation: () => Promise<T>): Promise<T> => {
        if (controller.signal.aborted)
          throw new CollaborationBoundaryError('Host operation was cancelled');
        try {
          const status = supervisor.status(owner.owner);
          if (status.quarantined && status.activeReservations === 0)
            supervisor.recoverOwner(owner.owner);
        } catch {
          throw new CollaborationBoundaryError('Host operation failed');
        }
        const id = ++owner.nextInvocation;
        const invocation: Invocation = { started: false, settled: false, operation, cancel: abort };
        owner.invocations.set(id, invocation);
        try {
          const supervised = supervisor.run<Outcome<T>>(owner.owner, 'run', [id], {
            deadlineMs: deadlineAt,
            signal: signalFor(controller.signal)
          });
          if (owner.onSettled !== undefined) {
            const idleEpoch = supervisor.whenOwnerIdle(owner.owner);
            if (owner.watchedIdleEpoch !== idleEpoch) {
              owner.watchedIdleEpoch = idleEpoch;
              void idleEpoch.then(
                () => {
                  if (owner.watchedIdleEpoch === idleEpoch) owner.watchedIdleEpoch = undefined;
                  owner.onSettled?.();
                },
                () => undefined
              );
            }
          }
          const outcome = await supervised;
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        } catch (error) {
          if (isHostEffectSupervisorError(error)) throw failure(error);
          throw new CollaborationBoundaryError('Host operation failed');
        } finally {
          if (!invocation.started || invocation.settled) owner.invocations.delete(id);
        }
      };
      const context: CollaborationHostContext = {
        signal: controller.signal,
        run: (operation) =>
          Promise.resolve().then(() => execute(contextOwner, () => operation(context))),
        runPort: (port, method, operation) =>
          Promise.resolve().then(() => execute(ownerFor(port, method), () => operation(context))),
        dispose() {
          signal?.remove(abort);
        }
      };
      return Object.freeze(context);
    }
  });
}
