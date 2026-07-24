/**
 * Small, runtime-free boundary primitives for values that cross the public
 * collaboration API.  TypeScript types do not protect these APIs from
 * proxies, accessors, cyclic graphs, or post-validation mutation.
 */
export const collaborationBudgets = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxNodes: 10_000,
  maxDepth: 64,
  maxItems: 10_000,
  maxText: 1_000_000,
  maxIdentifier: 128,
  maxTimestamp: 64,
  maxUrl: 2_048,
  maxEvidence: 1_000,
  maxReferences: 1_000,
  maxGraphEdges: 10_000
});

export class CollaborationBoundaryError extends Error {
  public readonly code = 'INVALID' as const;

  public constructor(message = 'Untrusted collaboration value is invalid') {
    super(message);
    this.name = 'CollaborationBoundaryError';
  }
}

/** One cancellable/deadline-bound context for every host adapter call. */
export interface CollaborationHostContext {
  readonly signal: AbortSignal;
  run<T>(operation: (context: CollaborationHostContext) => Promise<T>): Promise<T>;
  /** Every effectful adapter call is supervised by the trusted host's stable port owner. */
  runPort<T>(
    port: object,
    method: string,
    operation: (context: CollaborationHostContext) => Promise<T>
  ): Promise<T>;
  dispose(): void;
}

/** Package-owned host composition port; concrete supervisors remain in trusted hosts. */
export interface CollaborationHostContextFactory {
  create(options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): CollaborationHostContext;
}

const maxHostPortPrototypeDepth = 8;
const maxHostPortArguments = 64;

function captureHostMethod(
  port: unknown,
  method: unknown
): Readonly<{
  target: object;
  callable: (...values: readonly unknown[]) => unknown;
  method: string;
}> {
  if (
    port === null ||
    typeof port !== 'object' ||
    typeof method !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(method)
  )
    throw new CollaborationBoundaryError('Host port is invalid');
  const seen = new WeakSet<object>();
  let candidate: object | null = port;
  for (let depth = 0; candidate !== null && depth <= maxHostPortPrototypeDepth; depth += 1) {
    if (seen.has(candidate)) throw new CollaborationBoundaryError('Host port is invalid');
    seen.add(candidate);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, method);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function')
          throw new CollaborationBoundaryError('Host port is invalid');
        // Keep the exact descriptor, but preserve ordinary method receiver
        // semantics.  The service snapshots its ports before reaching here,
        // so this never needs caller-controlled Function#bind.
        return Object.freeze({ target: port, callable: descriptor.value, method });
      }
      candidate = Object.getPrototypeOf(candidate);
    } catch {
      throw new CollaborationBoundaryError('Host port is invalid');
    }
  }
  throw new CollaborationBoundaryError('Host port is invalid');
}

/** Capture an exact bounded port method and invoke it without caller-controlled bind. */
export async function callCollaborationHostPort<T>(
  context: CollaborationHostContext,
  port: object,
  method: string,
  args: readonly unknown[]
): Promise<T> {
  const captured = captureHostMethod(port, method);
  const runPort = captureContextRunPort(context);
  const capturedArgs = captureHostArguments(args, context);
  const operation = async () =>
    Promise.resolve(
      Reflect.apply(captured.callable, captured.target, [...capturedArgs, context])
    ) as Promise<T>;
  try {
    return (await Promise.resolve(
      Reflect.apply(runPort, context, [port, captured.method, operation])
    )) as T;
  } catch {
    throw new CollaborationBoundaryError('Host context operation is invalid');
  }
}

function captureContextRunPort(context: unknown): (...values: readonly unknown[]) => unknown {
  if (context === null || typeof context !== 'object')
    throw new CollaborationBoundaryError('Host context is invalid');
  try {
    const descriptor = Object.getOwnPropertyDescriptor(context, 'runPort');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
      throw new CollaborationBoundaryError('Host context is invalid');
    return descriptor.value;
  } catch {
    throw new CollaborationBoundaryError('Host context is invalid');
  }
}

/** Copies a dense data array without reading caller iteration hooks or retaining its backing array. */
function captureHostArguments(
  value: unknown,
  context: CollaborationHostContext
): readonly unknown[] {
  if (!Array.isArray(value)) throw new CollaborationBoundaryError('Host arguments are invalid');
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new CollaborationBoundaryError('Host arguments are invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = (descriptors['length'] as PropertyDescriptor | undefined)?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxHostPortArguments)
      throw new CollaborationBoundaryError('Host arguments are invalid');
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))
      )
    )
      throw new CollaborationBoundaryError('Host arguments are invalid');
    const copied: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new CollaborationBoundaryError('Host arguments are invalid');
      Object.defineProperty(copied, index, {
        value:
          descriptor.value === undefined || typeof descriptor.value === 'function'
            ? descriptor.value
            : captureHostArgumentValue(descriptor.value, context),
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    if (copied.length !== length || keys.length !== length + 1)
      throw new CollaborationBoundaryError('Host arguments are invalid');
    return Object.freeze(copied);
  } catch {
    throw new CollaborationBoundaryError('Host arguments are invalid');
  }
}

function captureHostArgumentValue(value: unknown, context: CollaborationHostContext): unknown {
  try {
    return ownCollaborationValue(value);
  } catch {
    return captureContextBearingArgument(value, context);
  }
}

function captureContextBearingArgument(value: unknown, context: CollaborationHostContext): unknown {
  let found = false;
  const active = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const captureBytes = (amount: number) => {
    bytes += amount;
    if (bytes > collaborationBudgets.maxBytes)
      throw new CollaborationBoundaryError('Host arguments are invalid');
  };
  const copy = (input: unknown, depth: number): unknown => {
    if (depth > collaborationBudgets.maxDepth)
      throw new CollaborationBoundaryError('Host arguments are invalid');
    if (input === context) {
      found = true;
      return context;
    }
    if (input === undefined || typeof input === 'function') return input;
    if (input === null || typeof input === 'boolean') {
      captureBytes(input === null ? 4 : 5);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new CollaborationBoundaryError('Host arguments are invalid');
      captureBytes(24);
      return input;
    }
    if (typeof input === 'string') {
      if (input.length > collaborationBudgets.maxText)
        throw new CollaborationBoundaryError('Host arguments are invalid');
      captureBytes(new TextEncoder().encode(input).byteLength);
      return input;
    }
    if (typeof input !== 'object')
      throw new CollaborationBoundaryError('Host arguments are invalid');
    if (active.has(input)) throw new CollaborationBoundaryError('Host arguments are invalid');
    active.add(input);
    nodes += 1;
    try {
      if (nodes > collaborationBudgets.maxNodes)
        throw new CollaborationBoundaryError('Host arguments are invalid');
      const prototype = Object.getPrototypeOf(input);
      const array = Array.isArray(input);
      if (
        array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
      )
        throw new CollaborationBoundaryError('Host arguments are invalid');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.length > collaborationBudgets.maxItems ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            (array && key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key))
        )
      )
        throw new CollaborationBoundaryError('Host arguments are invalid');
      const target: unknown[] | Record<string, unknown> = array ? [] : {};
      for (const key of keys) {
        if (typeof key !== 'string')
          throw new CollaborationBoundaryError('Host arguments are invalid');
        if (key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new CollaborationBoundaryError('Host arguments are invalid');
        captureBytes(new TextEncoder().encode(key).byteLength);
        Object.defineProperty(target, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      if (array) {
        const length = (descriptors['length'] as PropertyDescriptor | undefined)?.value;
        if (!Number.isSafeInteger(length) || target.length !== length || keys.length !== length + 1)
          throw new CollaborationBoundaryError('Host arguments are invalid');
      }
      return Object.freeze(target);
    } finally {
      active.delete(input);
    }
  };
  try {
    const captured = copy(value, 0);
    if (!found) throw new CollaborationBoundaryError('Host arguments are invalid');
    return captured;
  } catch {
    throw new CollaborationBoundaryError('Host arguments are invalid');
  }
}

type BudgetState = { bytes: number; nodes: number; readonly active: WeakSet<object> };

function fail(): never {
  throw new CollaborationBoundaryError();
}

function addText(value: string, state: BudgetState): string {
  if (value.length > collaborationBudgets.maxText) fail();
  state.bytes += new TextEncoder().encode(value).byteLength;
  if (state.bytes > collaborationBudgets.maxBytes) fail();
  return value;
}

function addBytes(bytes: number, state: BudgetState): void {
  state.bytes += bytes;
  if (state.bytes > collaborationBudgets.maxBytes) fail();
}

/**
 * Copies only own enumerable data properties into plain, deeply-frozen data.
 * Accessors, non-plain prototypes, symbols, cycles and oversized graphs are
 * rejected rather than being observed or accidentally retained.
 */
export function ownCollaborationValue<T>(input: T): T {
  const state: BudgetState = { bytes: 0, nodes: 0, active: new WeakSet() };
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > collaborationBudgets.maxDepth) fail();
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail();
      // Count the primitive representation too: otherwise a wide graph of
      // numbers and booleans could evade the aggregate byte budget.
      addBytes(value === null ? 4 : typeof value === 'boolean' ? 5 : 24, state);
      return value;
    }
    if (typeof value === 'string') return addText(value, state);
    if (typeof value !== 'object') fail();
    try {
      if (state.active.has(value)) fail();
      state.active.add(value);
      state.nodes += 1;
      if (state.nodes > collaborationBudgets.maxNodes) fail();
      const isArray = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        fail();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (
        keys.length > collaborationBudgets.maxItems ||
        Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')
      )
        fail();
      if (isArray && keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))
        fail();
      const target: unknown[] | Record<string, unknown> = isArray ? [] : {};
      for (const key of keys) {
        if (key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail();
        addText(key, state);
        // Defining the data property avoids the legacy __proto__ setter and
        // preserves the copied value as inert data.
        Object.defineProperty(target, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      const length = isArray ? descriptors.length?.value : undefined;
      // Sparse arrays hide unbounded holes behind a small descriptor set. They
      // are not portable JSON data, so require every declared index to exist.
      if (
        isArray &&
        (!Number.isSafeInteger(length) ||
          target.length !== length ||
          keys.filter((key) => key !== 'length').length !== length)
      )
        fail();
      state.active.delete(value);
      return Object.freeze(target);
    } catch {
      fail();
    }
  };
  return visit(input, 0) as T;
}

/**
 * Captures a potentially hostile iterable before callers inspect it more than
 * once. The cap is checked before each push, including infinite generators.
 */
export function captureCollaborationIterable<T>(
  values: Iterable<T>,
  maximum: number,
  _field = 'Iterable'
): readonly T[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > collaborationBudgets.maxItems)
    throw new CollaborationBoundaryError('Iterable limit is invalid');
  const result: T[] = [];
  try {
    for (const value of values) {
      if (result.length >= maximum)
        throw new CollaborationBoundaryError('Iterable exceeds the maximum item count');
      result.push(value);
    }
  } catch {
    throw new CollaborationBoundaryError('Iterable is invalid');
  }
  return Object.freeze(result);
}

/** Bounded structural equality that never executes caller-defined serialization hooks. */
export function equalCollaborationValues(left: unknown, right: unknown): boolean {
  try {
    const compare = (first: unknown, second: unknown): boolean => {
      if (Object.is(first, second)) return true;
      if (
        typeof first !== 'object' ||
        first === null ||
        typeof second !== 'object' ||
        second === null
      )
        return false;
      if (Array.isArray(first) || Array.isArray(second)) {
        return (
          Array.isArray(first) &&
          Array.isArray(second) &&
          first.length === second.length &&
          first.every((value, index) => compare(value, second[index]))
        );
      }
      const firstRecord = first as Record<string, unknown>;
      const secondRecord = second as Record<string, unknown>;
      const firstKeys = Object.keys(firstRecord);
      const secondKeys = Object.keys(secondRecord);
      return (
        firstKeys.length === secondKeys.length &&
        firstKeys.every(
          (key) =>
            Object.prototype.hasOwnProperty.call(secondRecord, key) &&
            compare(firstRecord[key], secondRecord[key])
        )
      );
    };
    return compare(ownCollaborationValue(left), ownCollaborationValue(right));
  } catch {
    return false;
  }
}
