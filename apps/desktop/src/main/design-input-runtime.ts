import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor,
  HostEffectSupervisorError
} from '@selene/host-runtime';
import {
  createDesignInputLoader,
  type DesignInputEffectMethod,
  type DesignInputLoader,
  type DesignInputPort,
  type DesignInputRuntime
} from '@selene/design-inputs';

type ExactMethod = (...arguments_: readonly unknown[]) => unknown;
const MAX_OWNER_CAPTURE_DEPTH = 4;
const MAX_OWNER_CAPTURE_OPERATIONS = 8;

export interface DesktopHostClock {
  now(): number;
}

export interface DesktopDesignInputRuntimeOptions {
  readonly clock: DesktopHostClock;
  readonly scheduler: { schedule(delayMs: number, task: () => void): { cancel(): void } };
}

interface CapturedDesktopRuntimeOptions {
  readonly clockNow: ExactMethod;
  readonly clockTarget: object;
  readonly schedule: ExactMethod;
  readonly schedulerTarget: object;
}

interface SupervisedOwner {
  readonly bridge: object;
  readonly methods: Map<DesignInputEffectMethod, ExactMethod>;
}

function capturedDataRecord(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('desktop design input runtime options are invalid');
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('desktop design input runtime options are invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (
      actual.length !== keys.length ||
      actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      throw new TypeError('desktop design input runtime options are invalid');
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        throw new TypeError('desktop design input runtime options are invalid');
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    throw new TypeError('desktop design input runtime options are invalid');
  }
}

function captureRuntimeOptions(
  value: DesktopDesignInputRuntimeOptions
): CapturedDesktopRuntimeOptions {
  const options = capturedDataRecord(value, ['clock', 'scheduler']);
  const clock = capturedDataRecord(options.clock, ['now']);
  const scheduler = capturedDataRecord(options.scheduler, ['schedule']);
  if (typeof clock.now !== 'function' || typeof scheduler.schedule !== 'function')
    throw new TypeError('desktop design input runtime options are invalid');
  return Object.freeze({
    clockNow: clock.now as ExactMethod,
    clockTarget: options.clock as object,
    schedule: scheduler.schedule as ExactMethod,
    schedulerTarget: options.scheduler as object
  });
}

function captureTimeout(value: Readonly<{ timeoutMs: number }>): number {
  const request = capturedDataRecord(value, ['timeoutMs']);
  const timeoutMs = request.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('desktop design input timeout is invalid');
  return timeoutMs;
}

function captureOwnerMethod(owner: object, name: DesignInputEffectMethod): ExactMethod {
  try {
    let operations = 0;
    const inspect = <T>(operation: () => T): T => {
      operations += 1;
      if (operations > MAX_OWNER_CAPTURE_OPERATIONS)
        throw new TypeError('desktop design input owner is invalid');
      return operation();
    };
    let current: object | null = owner;
    for (let depth = 0; current !== null && depth < MAX_OWNER_CAPTURE_DEPTH; depth += 1) {
      const descriptors = inspect(() => Object.getOwnPropertyDescriptors(current as object));
      const descriptor = descriptors[name];
      if (descriptor !== undefined) {
        if (
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof descriptor.value !== 'function'
        )
          throw new TypeError('desktop design input owner is invalid');
        return descriptor.value as ExactMethod;
      }
      const prototype = inspect(() => Object.getPrototypeOf(current as object));
      current = prototype;
    }
  } catch {}
  throw new TypeError('desktop design input owner is invalid');
}

function publicDesignInputContext(value: {
  readonly ownerGeneration: number;
  readonly cancellation: unknown;
}): object {
  // The portable package sees no absolute host clock. The private supervisor retains its deadline.
  return Object.freeze({
    ownerGeneration: value.ownerGeneration,
    cancellation: value.cancellation
  });
}

/** Concrete composition remains in the trusted Electron host, never in the published input core. */
export function createDesktopDesignInputRuntime(
  options: DesktopDesignInputRuntimeOptions
): DesignInputRuntime {
  const captured = captureRuntimeOptions(options);
  let lastObservedNow: number | undefined;
  const now = (): number => {
    const value = Reflect.apply(captured.clockNow, captured.clockTarget, []);
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (lastObservedNow !== undefined && value < lastObservedNow)
    )
      throw new TypeError('desktop design input clock is invalid');
    lastObservedNow = value;
    return value;
  };
  const pool = createHostEffectAdmissionPool({
    clock: Object.freeze({ now }),
    maxConcurrentEffects: 64,
    maxConcurrentEffectsPerOwner: 8
  });
  const supervisor = new HostEffectSupervisor(
    createHostEffectSupervisorOptions({
      admissionPool: pool,
      scheduler: Object.freeze({
        schedule: (delayMs: number, task: () => void) =>
          Reflect.apply(captured.schedule, captured.schedulerTarget, [delayMs, task])
      })
    })
  );
  const owners = new WeakMap<object, SupervisedOwner>();
  const supervisedOwner = (owner: object, method: DesignInputEffectMethod): object => {
    let entry = owners.get(owner);
    if (entry === undefined) {
      const methods = new Map<DesignInputEffectMethod, ExactMethod>();
      const invoke = (
        effect: DesignInputEffectMethod,
        context: { readonly ownerGeneration: number; readonly cancellation: unknown },
        arguments_: readonly unknown[]
      ) => {
        const capturedMethod = methods.get(effect);
        if (capturedMethod === undefined)
          throw new TypeError('desktop design input owner is invalid');
        return Reflect.apply(capturedMethod, owner, [
          publicDesignInputContext(context),
          ...arguments_
        ]);
      };
      entry = Object.freeze({
        methods,
        bridge: Object.freeze({
          resolvePackage: (
            context: { readonly ownerGeneration: number; readonly cancellation: unknown },
            ...arguments_: readonly unknown[]
          ) => invoke('resolvePackage', context, arguments_),
          readDesignLanguage: (
            context: { readonly ownerGeneration: number; readonly cancellation: unknown },
            ...arguments_: readonly unknown[]
          ) => invoke('readDesignLanguage', context, arguments_),
          sha256: (
            context: { readonly ownerGeneration: number; readonly cancellation: unknown },
            ...arguments_: readonly unknown[]
          ) => invoke('sha256', context, arguments_)
        })
      });
      owners.set(owner, entry);
    }
    if (!entry.methods.has(method)) entry.methods.set(method, captureOwnerMethod(owner, method));
    return entry.bridge;
  };
  return Object.freeze({
    async run<T>(
      owner: object,
      method: DesignInputEffectMethod,
      arguments_: readonly unknown[],
      request: Readonly<{ timeoutMs: number }>
    ) {
      try {
        const timeoutMs = captureTimeout(request);
        const current = now();
        const deadlineMs = current + timeoutMs;
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs < current)
          return Object.freeze({ status: 'effect-failed' as const });
        if (typeof owner !== 'object' || owner === null)
          return Object.freeze({ status: 'effect-failed' as const });
        const stableOwner = supervisedOwner(owner, method);
        // A design-input loader holds a stable captured port owner. Recovery is only safe after
        // all late work for that owner has settled; active work remains quarantined and fenced.
        const status = supervisor.status(stableOwner);
        if (status.quarantined) {
          if (status.activeReservations !== 0)
            return Object.freeze({ status: 'effect-failed' as const });
          supervisor.recoverOwner(stableOwner);
        }
        return Object.freeze({
          status: 'ok' as const,
          value: await supervisor.run<T>(
            stableOwner,
            method,
            arguments_,
            Object.freeze({ deadlineMs })
          )
        });
      } catch (error) {
        if (error instanceof HostEffectSupervisorError && error.code === 'DEADLINE_EXCEEDED')
          return Object.freeze({ status: 'deadline-exceeded' as const });
        return Object.freeze({ status: 'effect-failed' as const });
      }
    }
  });
}

const desktopSystemClock = Object.freeze({ now: () => Date.now() });
const desktopSystemScheduler = Object.freeze({
  schedule: (delayMs: number, task: () => void) => {
    const handle = setTimeout(task, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  }
});

/** The desktop main process owns this shared host composition. */
export const desktopDesignInputRuntime = createDesktopDesignInputRuntime({
  clock: desktopSystemClock,
  scheduler: desktopSystemScheduler
});

export function createDesktopDesignInputLoader(
  port: DesignInputPort,
  runtime: DesignInputRuntime = desktopDesignInputRuntime
): DesignInputLoader {
  return createDesignInputLoader({ port, runtime });
}
