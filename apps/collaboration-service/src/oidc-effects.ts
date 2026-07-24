import {
  HostEffectSupervisor,
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  type HostCallContext,
  type HostEffectCancellationSignal
} from '@selene/host-runtime';

const OIDC_EFFECT_DEADLINE_MS = 10_000;
const MAX_OIDC_EFFECT_DURATION_MS = 60_000;
const MAX_PORT_PROTOTYPE_DEPTH = 4;
const MAX_ABORT_LISTENER_REGISTRATIONS = 128;

/** Internal hosted OIDC admission/timing kernel. */
export interface OidcEffectRunner {
  run<T>(
    owner: object,
    method: string,
    arguments_: readonly unknown[],
    context?: OidcInheritedContext,
    signal?: HostEffectCancellationSignal
  ): Promise<T>;
  /** Converts a private host-clock deadline into the public portable budget. */
  fromHostContext(context: HostCallContext): OidcInheritedContext;
}

/** Identity-owned structural context. It intentionally carries no host-clock timestamp. */
export interface OidcInheritedContext {
  readonly remainingDurationMs: number;
  readonly cancellation: {
    isCancellationRequested(): boolean;
    subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void;
  };
}

export interface OidcEffectRunnerOptions {
  readonly clock?: { now(): number };
  readonly scheduler?: { schedule(delayMs: number, task: () => void): { cancel(): void } };
  readonly deadlineMs?: number;
}

export function createOidcEffectRunner(options: OidcEffectRunnerOptions = {}): OidcEffectRunner {
  const captured = captureRunnerOptions(options);
  const pool = createHostEffectAdmissionPool({
    clock: { now: captured.now },
    maxConcurrentEffects: 128,
    maxConcurrentEffectsPerOwner: 16
  });
  const supervisor = new HostEffectSupervisor(
    createHostEffectSupervisorOptions({
      admissionPool: pool,
      scheduler: {
        schedule: (delayMs: number, task: () => void) => captured.schedule(delayMs, task)
      }
    })
  );
  return Object.freeze({
    run<T>(
      owner: object,
      method: string,
      arguments_: readonly unknown[],
      context?: OidcInheritedContext,
      signal?: HostEffectCancellationSignal
    ): Promise<T> {
      try {
        const now = captured.now();
        const inherited =
          context === undefined
            ? undefined
            : captureInheritedContext(context, now, captured.deadlineMs);
        recoverSettledOwner(supervisor, owner);
        return supervisor.run<T>(owner, method, arguments_, {
          deadlineMs: inherited?.deadlineMs ?? deadlineFrom(now, captured.deadlineMs),
          ...(inherited ? { signal: inherited.signal } : signal ? { signal } : {})
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    fromHostContext(context: HostCallContext): OidcInheritedContext {
      try {
        return captureHostContext(context, captured.now(), captured.deadlineMs);
      } catch (error) {
        throw new TypeError('OIDC host context is invalid', { cause: error });
      }
    }
  });
}

function recoverSettledOwner(supervisor: HostEffectSupervisor, owner: object): void {
  const status = supervisor.status(owner);
  if (status.quarantined && status.activeReservations === 0) supervisor.recoverOwner(owner);
}

function captureRunnerOptions(options: OidcEffectRunnerOptions): {
  readonly now: () => number;
  readonly schedule: (delayMs: number, task: () => void) => { cancel(): void };
  readonly deadlineMs: number;
} {
  try {
    const values = snapshotData(options, ['clock', 'scheduler', 'deadlineMs']);
    const clock = capturePort(values.clock ?? defaultClock, 'now');
    const scheduler = capturePort(values.scheduler ?? defaultScheduler, 'schedule');
    const deadlineMs = validDuration(
      values.deadlineMs ?? OIDC_EFFECT_DEADLINE_MS,
      MAX_OIDC_EFFECT_DURATION_MS,
      false
    );
    return Object.freeze({
      now: () => Reflect.apply(clock.method, clock.target, []) as number,
      schedule: (delayMs, task) =>
        Reflect.apply(scheduler.method, scheduler.target, [delayMs, task]) as { cancel(): void },
      deadlineMs
    });
  } catch {
    throw new TypeError('OIDC effect runner options are invalid');
  }
}

function captureHostContext(
  context: HostCallContext,
  now: unknown,
  maximumDurationMs: number
): OidcInheritedContext {
  const values = snapshotData(context, ['ownerGeneration', 'deadlineMs', 'cancellation']);
  if (values.cancellation === undefined) throw new Error();
  const remainingDurationMs =
    values.deadlineMs === undefined
      ? maximumDurationMs
      : remainingDuration(values.deadlineMs, now, maximumDurationMs);
  return Object.freeze({
    remainingDurationMs,
    cancellation: portableCancellation(values.cancellation)
  });
}

function captureInheritedContext(
  context: OidcInheritedContext,
  now: unknown,
  maximumDurationMs: number
): { readonly deadlineMs: number; readonly signal: HostEffectCancellationSignal } {
  const values = snapshotData(context, ['remainingDurationMs', 'cancellation']);
  if (values.cancellation === undefined) throw new Error();
  const duration = validDuration(values.remainingDurationMs, maximumDurationMs, true);
  return Object.freeze({
    deadlineMs: deadlineFrom(now, duration),
    signal: cancellationFromContext(values.cancellation)
  });
}

function remainingDuration(value: unknown, now: unknown, maximumDurationMs: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error();
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) throw new Error();
  return Math.max(0, Math.min((value as number) - now, maximumDurationMs));
}

function validDuration(value: unknown, maximumDurationMs: number, permitZero: boolean): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (permitZero ? 0 : 1) ||
    (value as number) > maximumDurationMs
  )
    throw new Error();
  return value as number;
}

/** Reads only the named fixed-schema descriptors and never enumerates hostile input. */
function snapshotData(
  value: unknown,
  allowed: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object') throw new Error();
  const snapshot: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) throw new Error();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/** Captures approved data methods from a single bounded descriptor pass per prototype. */
function capturePortMethods(
  value: unknown,
  names: readonly string[]
): Readonly<{
  readonly target: object;
  readonly methods: Readonly<Record<string, (...arguments_: never[]) => unknown>>;
}> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) throw new Error();
  const pending = new Set(names);
  const methods: Record<string, (...arguments_: never[]) => unknown> = {};
  let cursor: object | null = value as object;
  const seen = new Set<object>();
  let reads = 0;
  for (let depth = 0; cursor && pending.size && depth <= MAX_PORT_PROTOTYPE_DEPTH; depth += 1) {
    if (seen.has(cursor)) throw new Error();
    seen.add(cursor);
    for (const name of [...pending]) {
      if (++reads > 64) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error();
      methods[name] = descriptor.value as (...arguments_: never[]) => unknown;
      pending.delete(name);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  if (pending.size) throw new Error();
  return Object.freeze({
    target: value as object,
    methods: Object.freeze(methods)
  });
}

/** Captures one approved data method without a second prototype observation. */
function capturePort(
  value: unknown,
  name: string
): {
  readonly target: object;
  readonly method: (...arguments_: never[]) => unknown;
} {
  const captured = capturePortMethods(value, [name]);
  return Object.freeze({ target: captured.target, method: captured.methods[name]! });
}

function deadlineFrom(now: unknown, duration: number): number {
  if (
    typeof now !== 'number' ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - duration
  )
    throw new TypeError('OIDC effect runner clock or deadline is invalid');
  return now + duration;
}

const defaultClock = Object.freeze({ now: Date.now });
const defaultScheduler = Object.freeze({
  schedule(delayMs: number, task: () => void): { cancel(): void } {
    const timer = setTimeout(task, delayMs);
    return { cancel: () => clearTimeout(timer) };
  }
});

export function cancellationFromAbortSignal(signal: AbortSignal): HostEffectCancellationSignal {
  type Registration = { readonly wrapper: () => void; readonly deactivate: () => void };
  const registrations = new Map<() => void, Registration>();
  const remove = (wrapper: () => void): void => {
    try {
      signal.removeEventListener('abort', wrapper);
    } catch {}
  };
  return Object.freeze({
    isAborted: () => {
      try {
        return signal.aborted;
      } catch {
        return true;
      }
    },
    addAbortListener: (listener: () => void) => {
      const previous = registrations.get(listener);
      if (previous) {
        registrations.delete(listener);
        previous.deactivate();
        remove(previous.wrapper);
      }
      let aborted = false;
      try {
        aborted = signal.aborted;
      } catch {
        aborted = true;
      }
      if (aborted || registrations.size >= MAX_ABORT_LISTENER_REGISTRATIONS) {
        listener();
        return;
      }
      let notified = false;
      let active = true;
      let cleaned = false;
      const deactivate = () => {
        active = false;
      };
      const notify = () => {
        if (!active || notified) return;
        notified = true;
        try {
          listener();
        } finally {
          cleanup();
        }
      };
      const registration: Registration = { wrapper: notify, deactivate };
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        deactivate();
        if (registrations.get(listener) === registration) registrations.delete(listener);
        remove(notify);
      };
      registrations.set(listener, registration);
      try {
        signal.addEventListener('abort', notify);
      } catch {
        if (!cleaned) {
          cleaned = true;
          active = true;
          if (registrations.get(listener) === registration) registrations.delete(listener);
          remove(notify);
        }
        notify();
      }
    },
    removeAbortListener: (listener: () => void) => {
      const registration = registrations.get(listener);
      if (!registration) return;
      registrations.delete(listener);
      registration.deactivate();
      remove(registration.wrapper);
    }
  });
}

function portableCancellation(value: unknown): OidcInheritedContext['cancellation'] {
  const cancellation = captureCancellation(value);
  return Object.freeze({
    isCancellationRequested: () => cancellation.isCancellationRequested(),
    subscribe: (listener) => cancellation.subscribe(listener)
  });
}

function cancellationFromContext(value: unknown): HostEffectCancellationSignal {
  const cancellation = captureCancellation(value);
  const subscriptions = new Map<() => void, () => void>();
  return Object.freeze({
    isAborted: () => cancellation.isCancellationRequested(),
    addAbortListener(listener: () => void) {
      subscriptions.get(listener)?.();
      try {
        subscriptions.set(
          listener,
          cancellation.subscribe(() => listener())
        );
      } catch {
        listener();
      }
    },
    removeAbortListener(listener: () => void) {
      subscriptions.get(listener)?.();
      subscriptions.delete(listener);
    }
  });
}

function captureCancellation(value: unknown): {
  isCancellationRequested(): boolean;
  subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void;
} {
  let captured: ReturnType<typeof capturePortMethods>;
  try {
    captured = capturePortMethods(value, ['isCancellationRequested', 'subscribe']);
  } catch {
    throw new TypeError('OIDC cancellation port is invalid');
  }
  return Object.freeze({
    isCancellationRequested(): boolean {
      const aborted = Reflect.apply(captured.methods.isCancellationRequested!, captured.target, []);
      if (typeof aborted !== 'boolean') throw new TypeError('OIDC cancellation port is invalid');
      return aborted;
    },
    subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void {
      const unsubscribe = Reflect.apply(captured.methods.subscribe!, captured.target, [listener]);
      if (typeof unsubscribe !== 'function')
        throw new TypeError('OIDC cancellation port is invalid');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          Reflect.apply(unsubscribe, undefined, []);
        } catch {}
      };
    }
  });
}
