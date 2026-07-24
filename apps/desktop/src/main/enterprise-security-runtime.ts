import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor
} from '@selene/host-runtime';

type ExactMethod = (...arguments_: readonly unknown[]) => unknown;
const MAX_CAPTURE_DEPTH = 8;
const MAX_CAPTURED_METHODS = 16;
const MAX_OWNED_DEPTH = 8;
const MAX_OWNED_ITEMS = 256;
const MAX_OWNED_STRING_CODE_UNITS = 1_048_576;
const MAX_OWNED_BYTES = 1_048_576;
const defaultTimeoutMs = 5_000;

export interface DesktopEnterpriseSecurityClock {
  now(): number;
}

interface CapturedMethod {
  readonly target: object;
  readonly method: ExactMethod;
}

interface BoundEnterprisePort {
  readonly owner: object;
  readonly publicPort: object;
  readonly port: object;
  readonly methods: readonly string[];
}

interface CapturedCallContext {
  readonly deadlineMs?: number;
  readonly cancellationTarget: object;
  readonly isCancellationRequested: ExactMethod;
  readonly subscribe: ExactMethod;
}

function stableError(): Error {
  return new Error('enterprise host effect failed');
}

function captureClock(value: DesktopEnterpriseSecurityClock): Readonly<{
  target: object;
  now: ExactMethod;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('enterprise runtime clock is invalid');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new TypeError('enterprise runtime clock is invalid');
  }
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors.now;
  if (
    keys.length !== 1 ||
    keys[0] !== 'now' ||
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    typeof descriptor.value !== 'function'
  ) {
    throw new TypeError('enterprise runtime clock is invalid');
  }
  return Object.freeze({ target: value, now: descriptor.value as ExactMethod });
}

function captureMethod(owner: object, name: string): CapturedMethod {
  if (!/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(name)) throw stableError();
  let target: object | null = owner;
  const visited = new Set<object>();
  for (let depth = 0; target !== null && depth < MAX_CAPTURE_DEPTH; depth += 1) {
    if (visited.has(target)) throw stableError();
    visited.add(target);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor !== undefined) {
        if (
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof descriptor.value !== 'function'
        )
          throw stableError();
        return Object.freeze({ target: owner, method: descriptor.value as ExactMethod });
      }
      target = Object.getPrototypeOf(target);
    } catch {
      throw stableError();
    }
  }
  throw stableError();
}

function captureMethodNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw stableError();
  let keys: readonly PropertyKey[];
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw stableError();
    keys = Reflect.ownKeys(value);
  } catch {
    throw stableError();
  }
  if (keys.length > MAX_CAPTURED_METHODS + 1) throw stableError();
  let length: PropertyDescriptor | undefined;
  try {
    length = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    throw stableError();
  }
  if (
    length === undefined ||
    !Object.prototype.hasOwnProperty.call(length, 'value') ||
    !Number.isSafeInteger(length.value) ||
    length.value < 1 ||
    length.value > MAX_CAPTURED_METHODS
  ) {
    throw stableError();
  }
  if (
    keys.length !== length.value + 1 ||
    keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))
  ) {
    throw stableError();
  }
  const methods: string[] = [];
  for (let index = 0; index < length.value; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw stableError();
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw stableError();
    if (typeof descriptor.value !== 'string') throw stableError();
    methods.push(descriptor.value);
  }
  if (new Set(methods).size !== methods.length) throw stableError();
  return Object.freeze(methods);
}

function captureCallContext(value: unknown): CapturedCallContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw stableError();
  let contextKeys: readonly PropertyKey[];
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw stableError();
    contextKeys = Reflect.ownKeys(value);
  } catch {
    throw stableError();
  }
  if (
    contextKeys.length > 3 ||
    contextKeys.some(
      (key) => key !== 'ownerGeneration' && key !== 'deadlineMs' && key !== 'cancellation'
    )
  ) {
    throw stableError();
  }
  const read = (key: PropertyKey): PropertyDescriptor | undefined => {
    try {
      return Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw stableError();
    }
  };
  const generation = read('ownerGeneration');
  const cancellation = read('cancellation');
  const deadline = read('deadlineMs');
  if (
    generation === undefined ||
    cancellation === undefined ||
    !Object.prototype.hasOwnProperty.call(generation, 'value') ||
    !Number.isSafeInteger(generation.value) ||
    generation.value < 1 ||
    !Object.prototype.hasOwnProperty.call(cancellation, 'value') ||
    typeof cancellation.value !== 'object' ||
    cancellation.value === null ||
    (deadline !== undefined &&
      (!Object.prototype.hasOwnProperty.call(deadline, 'value') ||
        typeof deadline.value !== 'number' ||
        !Number.isSafeInteger(deadline.value) ||
        deadline.value <= 0))
  ) {
    throw stableError();
  }
  let cancellationKeys: readonly PropertyKey[];
  try {
    const prototype = Object.getPrototypeOf(cancellation.value);
    if (prototype !== Object.prototype && prototype !== null) throw stableError();
    cancellationKeys = Reflect.ownKeys(cancellation.value);
  } catch {
    throw stableError();
  }
  if (
    cancellationKeys.length !== 3 ||
    cancellationKeys.some(
      (key) => key !== 'isCancellationRequested' && key !== 'reason' && key !== 'subscribe'
    )
  ) {
    throw stableError();
  }
  const readCancellation = (key: PropertyKey): PropertyDescriptor | undefined => {
    try {
      return Object.getOwnPropertyDescriptor(cancellation.value, key);
    } catch {
      throw stableError();
    }
  };
  for (const key of ['isCancellationRequested', 'reason', 'subscribe']) {
    const descriptor = readCancellation(key);
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      typeof descriptor.value !== 'function'
    )
      throw stableError();
  }
  const subscribe = readCancellation('subscribe');
  const isCancellationRequested = readCancellation('isCancellationRequested');
  return Object.freeze({
    ...(deadline === undefined ? {} : { deadlineMs: deadline.value }),
    cancellationTarget: cancellation.value,
    isCancellationRequested: isCancellationRequested!.value as ExactMethod,
    subscribe: subscribe!.value as ExactMethod
  });
}

interface OwnershipBudget {
  remainingItems: number;
  remainingBytes: number;
}

const encoder = new TextEncoder();

function consumeOwnedItem(budget: OwnershipBudget): void {
  budget.remainingItems -= 1;
  if (budget.remainingItems < 0) throw stableError();
}

function consumeOwnedBytes(budget: OwnershipBudget, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > budget.remainingBytes)
    throw stableError();
  budget.remainingBytes -= length;
}

function ownBytes(value: object, budget: OwnershipBudget): Uint8Array {
  try {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw stableError();
    const source = value as Uint8Array;
    const buffer = source.buffer;
    const maxByteLength = (buffer as ArrayBuffer & { readonly maxByteLength?: unknown })
      .maxByteLength;
    if (
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      (buffer as ArrayBuffer & { readonly resizable?: unknown }).resizable === true ||
      (maxByteLength !== undefined && maxByteLength !== buffer.byteLength)
    )
      throw stableError();
    const length = source.byteLength;
    const verified = new Uint8Array(buffer, source.byteOffset, length);
    if (verified.byteLength !== length) throw stableError();
    consumeOwnedBytes(budget, length);
    const copy = new Uint8Array(length);
    copy.set(verified);
    return copy;
  } catch {
    throw stableError();
  }
}

function own(
  value: unknown,
  depth = 0,
  budget: OwnershipBudget = {
    remainingItems: MAX_OWNED_ITEMS,
    remainingBytes: MAX_OWNED_BYTES
  }
): unknown {
  consumeOwnedItem(budget);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_OWNED_STRING_CODE_UNITS) throw stableError();
    consumeOwnedBytes(budget, encoder.encode(value).byteLength);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw stableError();
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      if (Object.getPrototypeOf(value) === Uint8Array.prototype) return ownBytes(value, budget);
    } catch {
      throw stableError();
    }
  }
  if (depth >= MAX_OWNED_DEPTH || typeof value !== 'object') throw stableError();
  if (Array.isArray(value)) {
    let keys: readonly PropertyKey[];
    let length: PropertyDescriptor | undefined;
    try {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw stableError();
      length = Object.getOwnPropertyDescriptor(value, 'length');
    } catch {
      throw stableError();
    }
    if (
      length === undefined ||
      !Object.prototype.hasOwnProperty.call(length, 'value') ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > MAX_OWNED_ITEMS
    ) {
      throw stableError();
    }
    const descriptors = new Map<string, PropertyDescriptor>();
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw stableError();
      descriptors.set(String(index), descriptor);
    }
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      throw stableError();
    }
    if (keys.length > MAX_OWNED_ITEMS + 1) throw stableError();
    if (
      keys.length !== length.value + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || key.length > 16 || !/^(0|[1-9]\d*)$/.test(key))
      )
    ) {
      throw stableError();
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors.get(String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw stableError();
      copy.push(own(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(copy);
  }
  let keys: readonly PropertyKey[];
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw stableError();
    keys = Reflect.ownKeys(value);
  } catch {
    throw stableError();
  }
  if (
    keys.length > MAX_OWNED_ITEMS ||
    keys.some((key) => typeof key !== 'string' || key.length > 256)
  )
    throw stableError();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw stableError();
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw stableError();
    Object.defineProperty(result, key, {
      value: own(descriptor.value, depth + 1, budget),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(result);
}

function remainingTimeout(
  context: Pick<CapturedCallContext, 'deadlineMs'>,
  clock: Readonly<{ target: object; now: ExactMethod }>
): number {
  if (context.deadlineMs === undefined) return defaultTimeoutMs;
  try {
    const current = Reflect.apply(clock.now, clock.target, []);
    if (
      typeof current !== 'number' ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      current >= context.deadlineMs
    ) {
      throw stableError();
    }
    return context.deadlineMs - current;
  } catch {
    throw stableError();
  }
}

/**
 * Trusted Electron composition for enterprise providers. Core receives only
 * the returned provider-neutral port; every method is captured once and
 * admitted through this one supplied shared supervisor.
 */
export function createDesktopEnterpriseSecurityAdapter(
  supervisor: HostEffectSupervisor,
  clock: DesktopEnterpriseSecurityClock
): Readonly<{
  bind<T extends object>(port: T, methods: readonly string[]): T;
  waitForSettlement(port: object): Promise<void>;
}> {
  const capturedClock = captureClock(clock);
  const bindings = new WeakMap<object, BoundEnterprisePort>();

  const bind = <T extends object>(port: T, names: readonly string[]): T => {
    if (typeof port !== 'object' || port === null || !Array.isArray(names)) throw stableError();
    const methods = captureMethodNames(names);
    const previous = bindings.get(port);
    if (previous !== undefined) {
      if (
        previous.methods.length !== methods.length ||
        previous.methods.some((name, index) => name !== methods[index])
      )
        throw stableError();
      return previous.publicPort as T;
    }
    const captured = new Map<string, CapturedMethod>();
    for (const name of methods) captured.set(name, captureMethod(port, name));
    const bridge: Record<string, ExactMethod> = {};
    for (const name of methods) {
      bridge[name] = async (...input: readonly unknown[]) => {
        const [contextValue, ...arguments_] = input;
        const context = captureCallContext(contextValue);
        const method = captured.get(name);
        if (method === undefined) throw stableError();
        const controller = new AbortController();
        let unsubscribe: (() => void) | undefined;
        try {
          const subscription = Reflect.apply(context.subscribe, context.cancellationTarget, [
            () => controller.abort()
          ]);
          if (typeof subscription !== 'function') throw stableError();
          unsubscribe = subscription as () => void;
          if (
            Reflect.apply(context.isCancellationRequested, context.cancellationTarget, []) === true
          )
            controller.abort();
          const adapterContext = Object.freeze({
            signal: controller.signal,
            timeoutMs: remainingTimeout(context, capturedClock)
          });
          const rawArguments = [...arguments_];
          if (rawArguments.at(-1) === undefined) rawArguments.pop();
          if (controller.signal.aborted) throw stableError();
          const inputBudget: OwnershipBudget = {
            remainingItems: MAX_OWNED_ITEMS,
            remainingBytes: MAX_OWNED_BYTES
          };
          const forwarded = rawArguments.map((value) => own(value, 0, inputBudget));
          const result = await Promise.resolve(
            Reflect.apply(method.method, method.target, [...forwarded, adapterContext])
          );
          return own(result);
        } catch {
          throw stableError();
        } finally {
          if (unsubscribe !== undefined)
            try {
              Reflect.apply(unsubscribe, undefined, []);
            } catch {}
        }
      };
    }
    const owner = Object.freeze(bridge);
    const publicPort: Record<string, ExactMethod> = {};
    for (const name of methods) {
      publicPort[name] = (...arguments_: readonly unknown[]) => {
        const binding = bindings.get(port);
        if (binding === undefined) return Promise.reject(stableError());
        const status = supervisor.status(binding.owner);
        if (status.quarantined) {
          if (status.activeReservations !== 0) return Promise.reject(stableError());
          supervisor.recoverOwner(binding.owner);
        }
        let deadlineMs: number;
        try {
          const current = Reflect.apply(capturedClock.now, capturedClock.target, []);
          if (
            typeof current !== 'number' ||
            !Number.isSafeInteger(current) ||
            current < 0 ||
            current > Number.MAX_SAFE_INTEGER - defaultTimeoutMs
          )
            throw stableError();
          deadlineMs = current + defaultTimeoutMs;
        } catch {
          return Promise.reject(stableError());
        }
        return supervisor.run(binding.owner, name, arguments_, Object.freeze({ deadlineMs }));
      };
    }
    const binding = Object.freeze({
      owner,
      publicPort: Object.freeze(publicPort),
      port,
      methods
    });
    bindings.set(port, binding);
    return binding.publicPort as T;
  };

  return Object.freeze({
    bind<T extends object>(port: T, methods: readonly string[]): T {
      return bind(port, methods);
    },
    async waitForSettlement(port: object): Promise<void> {
      if (typeof port !== 'object' || port === null) return Promise.reject(stableError());
      const binding = bindings.get(port);
      if (binding === undefined) throw stableError();
      await supervisor.whenOwnerIdle(binding.owner);
    }
  });
}

const systemClock = Object.freeze({ now: () => Date.now() });
const systemScheduler = Object.freeze({
  schedule: (delayMs: number, task: () => void) => {
    const handle = setTimeout(task, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(handle) });
  }
});
const desktopEnterprisePool = createHostEffectAdmissionPool({
  clock: systemClock,
  maxConcurrentEffects: 64,
  maxConcurrentEffectsPerOwner: 8
});
const desktopEnterpriseSupervisor = new HostEffectSupervisor(
  createHostEffectSupervisorOptions({
    admissionPool: desktopEnterprisePool,
    scheduler: systemScheduler
  })
);

/** Shared enterprise admission kernel owned by the Electron main process. */
export const desktopEnterpriseSecurityAdapter = createDesktopEnterpriseSecurityAdapter(
  desktopEnterpriseSupervisor,
  systemClock
);
