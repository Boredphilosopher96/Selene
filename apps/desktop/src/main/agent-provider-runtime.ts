import {
  type AgentProviderCallContext,
  createAgentProviderRuntimeError,
  type AgentProviderRuntime,
  type AgentProviderRuntimeCallOptions
} from '@selene/agent-sdk';
import {
  type HostCallContext,
  type HostEffectRequestOptions,
  HostEffectSupervisor,
  HostEffectSupervisorError
} from '@selene/host-runtime';

const runtimePorts = new WeakMap<
  HostEffectSupervisor,
  { readonly clock: DesktopAgentProviderRuntimeClock; readonly runtime: AgentProviderRuntime }
>();

export interface DesktopAgentProviderRuntimeClock {
  now(): number;
}

interface CapturedDesktopClock {
  readonly target: object;
  readonly now: (...arguments_: unknown[]) => unknown;
}

interface OwnerGeneration {
  effectOwner: object;
}

interface OwnerLifecycle {
  current: OwnerGeneration;
  cleanup?: OwnerGeneration;
}

function outcome(error: unknown) {
  if (!(error instanceof HostEffectSupervisorError))
    return createAgentProviderRuntimeError('EFFECT_FAILED');
  switch (error.code) {
    case 'CALLER_ABORTED':
    case 'DEADLINE_EXCEEDED':
    case 'EFFECT_FAILED':
    case 'OWNER_CAPACITY_REACHED':
    case 'OWNER_QUARANTINED':
    case 'PROCESS_CAPACITY_REACHED':
      return createAgentProviderRuntimeError(error.code);
    default:
      return createAgentProviderRuntimeError('EFFECT_FAILED');
  }
}

function captureClock(value: DesktopAgentProviderRuntimeClock): CapturedDesktopClock {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('desktop agent runtime clock must be an object');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('desktop agent runtime clock cannot be inspected safely');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== 'now')
    throw new TypeError('desktop agent runtime clock must expose only own data now');
  const descriptor = descriptors.now;
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function'
  )
    throw new TypeError('desktop agent runtime clock must expose own data now');
  return Object.freeze({
    target: value,
    now: descriptor.value as (...arguments_: unknown[]) => unknown
  });
}

function clockNow(clock: CapturedDesktopClock): number {
  try {
    const value = Reflect.apply(clock.now, clock.target, []);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError('invalid clock');
    return value;
  } catch {
    throw createAgentProviderRuntimeError('EFFECT_FAILED');
  }
}

function requestOptions(
  value: AgentProviderRuntimeCallOptions | undefined,
  clock: CapturedDesktopClock
): HostEffectRequestOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw createAgentProviderRuntimeError('EFFECT_FAILED');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw createAgentProviderRuntimeError('EFFECT_FAILED');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 2) throw createAgentProviderRuntimeError('EFFECT_FAILED');
    descriptors = Object.create(null) as Record<PropertyKey, PropertyDescriptor>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) throw createAgentProviderRuntimeError('EFFECT_FAILED');
      descriptors[key] = descriptor;
    }
  } catch {
    throw createAgentProviderRuntimeError('EFFECT_FAILED');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== 'timeoutMs' && key !== 'cancellation')
      throw createAgentProviderRuntimeError('EFFECT_FAILED');
    if (!('value' in descriptors[key]!)) throw createAgentProviderRuntimeError('EFFECT_FAILED');
  }
  const timeoutMs = descriptors.timeoutMs?.value;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw createAgentProviderRuntimeError('EFFECT_FAILED');
  let deadlineMs: number | undefined;
  if (timeoutMs !== undefined) {
    try {
      const now = clockNow(clock);
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - timeoutMs)
        throw new TypeError('invalid clock');
      deadlineMs = now + timeoutMs;
    } catch {
      throw createAgentProviderRuntimeError('EFFECT_FAILED');
    }
  }
  const cancellation = descriptors.cancellation?.value;
  if (cancellation !== undefined && (typeof cancellation !== 'object' || cancellation === null))
    throw createAgentProviderRuntimeError('EFFECT_FAILED');
  return Object.freeze({
    ...(deadlineMs === undefined ? {} : { deadlineMs: deadlineMs as number }),
    ...(cancellation === undefined ? {} : { signal: cancellation })
  });
}

/**
 * Adapts one desktop-owned shared supervisor to the provider-neutral SDK port.
 * The cache makes every SDK adapter retain one admission owner for this host.
 */
export function createDesktopAgentProviderRuntime(
  supervisor: HostEffectSupervisor,
  clock: DesktopAgentProviderRuntimeClock
): AgentProviderRuntime {
  const existing = runtimePorts.get(supervisor);
  if (existing !== undefined) {
    if (existing.clock !== clock) throw new TypeError('desktop agent runtime clock must be shared');
    return existing.runtime;
  }
  const capturedClock = captureClock(clock);
  const owners = new WeakMap<object, OwnerLifecycle>();
  const createGeneration = (): OwnerGeneration => ({
    effectOwner: Object.freeze({
      invoke: (context: HostCallContext, callback: unknown) => {
        if (typeof callback !== 'function') throw new TypeError('invalid provider effect');
        let remainingMs: number | undefined;
        if (context.deadlineMs !== undefined) {
          const current = clockNow(capturedClock);
          if (!Number.isSafeInteger(current) || current < 0 || current > context.deadlineMs)
            throw new TypeError('invalid desktop runtime clock');
          remainingMs = context.deadlineMs - current;
        }
        return (callback as (value: AgentProviderCallContext) => unknown)(
          Object.freeze({
            ownerGeneration: context.ownerGeneration,
            ...(remainingMs === undefined ? {} : { remainingMs }),
            cancellation: context.cancellation
          })
        );
      }
    })
  });
  const lifecycleFor = (owner: object): OwnerLifecycle => {
    const existingLifecycle = owners.get(owner);
    if (existingLifecycle !== undefined) return existingLifecycle;
    const lifecycle: OwnerLifecycle = { current: createGeneration() };
    owners.set(owner, lifecycle);
    return lifecycle;
  };
  const generationFor = (owner: object): OwnerGeneration => lifecycleFor(owner).current;
  const cleanupGenerationFor = (owner: object): OwnerGeneration => {
    const lifecycle = lifecycleFor(owner);
    if (lifecycle.cleanup !== undefined) return lifecycle.cleanup;
    const cleanup = createGeneration();
    lifecycle.cleanup = cleanup;
    return cleanup;
  };
  const settledQuarantine = (
    owner: object
  ): { lifecycle: OwnerLifecycle; generation: OwnerGeneration } => {
    const lifecycle = lifecycleFor(owner);
    const generation = lifecycle.current;
    try {
      const status = supervisor.status(generation.effectOwner);
      if (!status.quarantined || status.activeReservations !== 0)
        throw createAgentProviderRuntimeError('EFFECT_FAILED');
      if (
        lifecycle.cleanup !== undefined &&
        supervisor.status(lifecycle.cleanup.effectOwner).activeReservations !== 0
      )
        throw createAgentProviderRuntimeError('EFFECT_FAILED');
      return { lifecycle, generation };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { readonly code?: unknown }).code === 'EFFECT_FAILED'
      )
        throw error;
      throw outcome(error);
    }
  };
  const invoke = async <T>(
    owner: object,
    effect: (context: AgentProviderCallContext) => T,
    options: AgentProviderRuntimeCallOptions | undefined,
    cleanup: boolean
  ): Promise<T> => {
    if (typeof owner !== 'object' || owner === null || typeof effect !== 'function')
      throw createAgentProviderRuntimeError('EFFECT_FAILED');
    const capturedOptions = requestOptions(options, capturedClock);
    const generation = cleanup ? cleanupGenerationFor(owner) : generationFor(owner);
    try {
      return await supervisor.run<T>(generation.effectOwner, 'invoke', [effect], capturedOptions);
    } catch (error) {
      throw outcome(error);
    }
  };
  const runtime: AgentProviderRuntime = {
    run: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ) => invoke(owner, effect, options, false),
    runCleanup: <T>(
      owner: object,
      effect: (context: AgentProviderCallContext) => T,
      options?: AgentProviderRuntimeCallOptions
    ) => invoke(owner, effect, options, true),
    replaceGeneration: (owner: object) => {
      if (typeof owner !== 'object' || owner === null)
        throw createAgentProviderRuntimeError('EFFECT_FAILED');
      const { lifecycle } = settledQuarantine(owner);
      lifecycle.current = createGeneration();
      delete lifecycle.cleanup;
    },
    recover: (owner: object) => {
      if (typeof owner !== 'object' || owner === null)
        throw createAgentProviderRuntimeError('EFFECT_FAILED');
      try {
        supervisor.recoverOwner(settledQuarantine(owner).generation.effectOwner);
      } catch (error) {
        throw outcome(error);
      }
    }
  };
  const frozen = Object.freeze(runtime);
  runtimePorts.set(supervisor, Object.freeze({ clock, runtime: frozen }));
  return frozen;
}
