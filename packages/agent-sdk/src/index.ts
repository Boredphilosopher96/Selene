/**
 * Provider- and runtime-neutral protocol primitives. This package deliberately
 * does not launch processes or access the filesystem, network, or Electron.
 */
export const agentSdkPackageName = '@selene/agent-sdk';

export const AGENT_PROTOCOL_VERSION = '1.0' as const;
/**
 * One frame must carry a bounded React workspace plus enterprise design context.
 * Keep this above the desktop adapter's 512 KiB input budget so envelope metadata
 * cannot turn an otherwise valid request into a transport-only failure.
 */
export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_CAPABILITIES = 128;
export const MAX_IN_FLIGHT_REQUESTS = 1_024;

export const DEFAULT_JSON_BUDGETS = Object.freeze({
  maximumBytes: MAX_JSONL_LINE_BYTES,
  maximumDepth: 32,
  maximumValues: 4_096,
  maximumArrayLength: 1_024,
  maximumStringBytes: 16 * 1024,
  maximumNumberCharacters: 128
});

export interface JsonBudgets {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  readonly maximumValues: number;
  readonly maximumArrayLength: number;
  readonly maximumStringBytes: number;
  readonly maximumNumberCharacters: number;
}

export type ProtocolVersion = typeof AGENT_PROTOCOL_VERSION;
export type AgentCapability = string;
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonObject | JsonPrimitive | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface WorkspaceGrant {
  readonly root: string;
  readonly readOnly: boolean;
}

export interface CapabilityGrant {
  readonly capability: AgentCapability;
  readonly workspace: WorkspaceGrant;
}

interface EnvelopeBase {
  readonly protocolVersion: ProtocolVersion;
  readonly messageId: string;
  readonly sentAt: string;
}

export interface HelloEnvelope extends EnvelopeBase {
  readonly kind: 'hello';
  readonly capabilities: readonly AgentCapability[];
  readonly implementation?: string;
}

export interface RequestEnvelope extends EnvelopeBase {
  readonly kind: 'request';
  readonly requestId: string;
  readonly operation: AgentCapability;
  readonly input: JsonObject;
}

export interface EventEnvelope extends EnvelopeBase {
  readonly kind: 'event';
  readonly requestId: string;
  readonly event: string;
  readonly output?: JsonObject;
}

export interface CancelEnvelope extends EnvelopeBase {
  readonly kind: 'cancel';
  readonly requestId: string;
}

export interface ErrorEnvelope extends EnvelopeBase {
  readonly kind: 'error';
  readonly requestId?: string;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export type AgentEnvelope =
  CancelEnvelope | ErrorEnvelope | EventEnvelope | HelloEnvelope | RequestEnvelope;

type AgentProtocolErrorCode =
  | 'ADAPTER_FAILURE'
  | 'BUDGET_EXCEEDED'
  | 'CANCELLED'
  | 'DANGEROUS_KEY'
  | 'DUPLICATE_KEY'
  | 'INVALID_ENVELOPE'
  | 'INVALID_JSON'
  | 'LINE_TOO_LARGE'
  | 'SERIALIZATION_FAILED'
  | 'UNSAFE_VALUE'
  | 'UNSUPPORTED_VERSION';

export class AgentProtocolError extends Error {
  public readonly code: AgentProtocolErrorCode;

  public constructor(code: AgentProtocolErrorCode, message: string) {
    super(typeof message === 'string' ? truncateUtf8(message, 512) : 'Invalid protocol error');
    this.code =
      typeof code === 'string' && protocolErrorCodes.has(code as AgentProtocolErrorCode)
        ? (code as AgentProtocolErrorCode)
        : 'INVALID_ENVELOPE';
    this.name = 'AgentProtocolError';
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
const protocolErrorCodes = new Set<AgentProtocolErrorCode>([
  'ADAPTER_FAILURE',
  'BUDGET_EXCEEDED',
  'CANCELLED',
  'DANGEROUS_KEY',
  'DUPLICATE_KEY',
  'INVALID_ENVELOPE',
  'INVALID_JSON',
  'LINE_TOO_LARGE',
  'SERIALIZATION_FAILED',
  'UNSAFE_VALUE',
  'UNSUPPORTED_VERSION'
]);
const trustedProtocolErrors = new WeakSet<AgentProtocolError>();
const validatedEnvelopes = new WeakSet<object>();
const validatedExecutions = new WeakSet<object>();

function byteLength(value: string): number {
  return utf8ByteLengthAtMost(value, Number.MAX_SAFE_INTEGER);
}

function jsonStringBytesAtMost(value: string, maximumBytes: number): number {
  let usedBytes = 2;
  if (usedBytes > maximumBytes) return maximumBytes + 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let bytes: number;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    )
      bytes = 2;
    else if (
      code < 0x20 ||
      (code >= 0xd800 && code <= 0xdfff && !isWellFormedUnicode(value.slice(index, index + 2)))
    )
      bytes = 6;
    else {
      bytes = utf8CharacterBytes(value, index);
      if (bytes === 4) index += 1;
    }
    usedBytes += bytes;
    if (usedBytes > maximumBytes) return maximumBytes + 1;
  }
  return usedBytes;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = '';
  let usedBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const characterBytes = utf8CharacterBytes(value, index);
    if (usedBytes + characterBytes > maximumBytes) break;
    result += value[index]!;
    if (characterBytes === 4) result += value[++index]!;
    usedBytes += characterBytes;
  }
  return result;
}

function utf8CharacterBytes(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 4;
  }
  return 3;
}

function utf8ByteLengthAtMost(value: string, maximumBytes: number): number {
  let usedBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const characterBytes = utf8CharacterBytes(value, index);
    usedBytes += characterBytes;
    if (usedBytes > maximumBytes) return maximumBytes + 1;
    if (characterBytes === 4) index += 1;
  }
  return usedBytes;
}

function budgets(requested: number | Partial<JsonBudgets> | undefined = undefined): JsonBudgets {
  if (requested === undefined) return DEFAULT_JSON_BUDGETS;
  const values: Record<keyof JsonBudgets, number> = { ...DEFAULT_JSON_BUDGETS };
  if (typeof requested === 'number') {
    values.maximumBytes = requested;
  } else {
    if (typeof requested !== 'object' || requested === null || Array.isArray(requested))
      throw invalid('JSON budgets must be a number or plain data object');
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = boundedDescriptors(
        requested,
        Object.keys(DEFAULT_JSON_BUDGETS).length,
        'JSON budgets contain too many fields'
      );
      const prototype = Object.getPrototypeOf(requested);
      if (prototype !== Object.prototype && prototype !== null)
        throw invalid('JSON budgets must have a plain prototype');
    } catch (error) {
      if (error instanceof AgentProtocolError && trustedProtocolErrors.has(error)) throw error;
      throw hostError('UNSAFE_VALUE', 'JSON budgets cannot be inspected safely');
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !Object.hasOwn(DEFAULT_JSON_BUDGETS, key))
        throw invalid('JSON budgets contain an unknown field');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor))
        throw invalid('JSON budgets must contain only data properties');
      values[key as keyof JsonBudgets] = descriptor.value as number;
    }
  }
  for (const key of Object.keys(DEFAULT_JSON_BUDGETS) as Array<keyof JsonBudgets>) {
    const value = values[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_JSON_BUDGETS[key])
      throw invalid('JSON budget is outside the supported range');
  }
  values.maximumArrayLength = Math.min(values.maximumArrayLength, values.maximumValues);
  values.maximumStringBytes = Math.min(values.maximumStringBytes, values.maximumBytes);
  values.maximumNumberCharacters = Math.min(values.maximumNumberCharacters, values.maximumBytes);
  return Object.freeze(values);
}

function invalid(message: string): AgentProtocolError {
  return hostError('INVALID_ENVELOPE', message);
}

function hostError(code: AgentProtocolErrorCode, message: string): AgentProtocolError {
  const error = new AgentProtocolError(code, message);
  trustedProtocolErrors.add(error);
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}

function isCapability(value: unknown): value is AgentCapability {
  return typeof value === 'string' && capabilityPattern.test(value);
}

function safeDataProperty(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw hostError('UNSAFE_VALUE', 'Value cannot be inspected safely');
  }
  if (descriptor !== undefined && !('value' in descriptor))
    throw hostError('UNSAFE_VALUE', `Property ${String(key)} must be a data property`);
  return descriptor;
}

function boundedDescriptors(
  value: object,
  maximumProperties: number,
  message: string
): Record<PropertyKey, PropertyDescriptor> {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumProperties) throw hostError('UNSAFE_VALUE', message);
    const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) throw hostError('UNSAFE_VALUE', message);
      descriptors[key] = descriptor;
    }
    return descriptors;
  } catch (error) {
    if (error instanceof AgentProtocolError && trustedProtocolErrors.has(error)) throw error;
    throw hostError('UNSAFE_VALUE', message);
  }
}

function safeMethod(
  value: object,
  key: PropertyKey
): ((...arguments_: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  for (let depth = 0; current !== null && current !== Object.prototype; depth += 1) {
    if (depth > 3) throw hostError('UNSAFE_VALUE', 'Method prototype chain is too deep');
    const descriptor = safeDataProperty(current, key);
    if (descriptor !== undefined) {
      if (typeof descriptor.value !== 'function')
        throw hostError('UNSAFE_VALUE', `Property ${String(key)} must be a function`);
      return descriptor.value as (...arguments_: unknown[]) => unknown;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      throw hostError('UNSAFE_VALUE', 'Value cannot be inspected safely');
    }
  }
  return undefined;
}

function snapshotCapabilities(value: unknown, field: string): readonly AgentCapability[] {
  const snapshot = snapshotJsonValue(value);
  if (
    !Array.isArray(snapshot) ||
    snapshot.length > MAX_CAPABILITIES ||
    !snapshot.every(isCapability) ||
    new Set(snapshot).size !== snapshot.length
  )
    throw invalid(`${field} must contain at most ${MAX_CAPABILITIES} unique valid capabilities`);
  return snapshot as readonly AgentCapability[];
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = dateTimePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timezone = match[8]!;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (timezone !== 'Z' && (Number(timezone.slice(1, 3)) > 23 || Number(timezone.slice(4, 6)) > 59))
  )
    return false;
  const offsetMinutes =
    timezone === 'Z'
      ? 0
      : (Number(timezone.slice(1, 3)) * 60 + Number(timezone.slice(4, 6))) *
        (timezone[0] === '+' ? 1 : -1);
  const instant = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000
  );
  const local = new Date(instant.getTime() + offsetMinutes * 60_000);
  return (
    local.getUTCFullYear() === year &&
    local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute &&
    local.getUTCSeconds() === second
  );
}

function assertSafeKey(key: string): void {
  if (dangerousKeys.has(key)) throw hostError('DANGEROUS_KEY', `Dangerous JSON object key: ${key}`);
}

/** An iterative JSON parser that rejects duplicate and dangerous keys before materialization. */
class BoundedJsonParser {
  private index = 0;
  private values = 0;
  private root: JsonValue | undefined;
  private hasRoot = false;
  private readonly frames: Array<
    | { readonly type: 'array'; readonly value: JsonValue[]; state: 'valueOrEnd' | 'commaOrEnd' }
    | {
        readonly type: 'object';
        readonly value: Record<string, JsonValue>;
        readonly keys: Set<string>;
        state: 'keyOrEnd' | 'colon' | 'value' | 'commaOrEnd';
        key?: string;
      }
  > = [];

  public constructor(
    private readonly source: string,
    private readonly limit: JsonBudgets
  ) {}

  public parse(): JsonValue {
    // eslint-disable no-await-in-loop
    while (true) {
      this.space();
      const frame = this.frames.at(-1);
      if (frame === undefined) {
        if (!this.hasRoot) {
          this.readAndAttachValue();
          continue;
        }
        this.space();
        if (this.index !== this.source.length)
          throw new SyntaxError('Unexpected trailing JSON content');
        return this.root as JsonValue;
      }
      if (frame.type === 'object') this.objectStep(frame);
      else this.arrayStep(frame);
    }
  }

  private objectStep(frame: Extract<(typeof this.frames)[number], { type: 'object' }>): void {
    if (frame.state === 'keyOrEnd') {
      if (this.take('}')) return this.closeFrame();
      if (this.source[this.index] !== '"') throw new SyntaxError('Expected an object key');
      const key = this.string();
      assertSafeKey(key);
      if (frame.keys.has(key))
        throw hostError('DUPLICATE_KEY', `Duplicate JSON object key: ${key}`);
      frame.keys.add(key);
      frame.key = key;
      frame.state = 'colon';
      return;
    }
    if (frame.state === 'colon') {
      if (!this.take(':')) throw new SyntaxError('Expected a colon');
      frame.state = 'value';
      return;
    }
    if (frame.state === 'value') return this.readAndAttachValue();
    if (this.take('}')) return this.closeFrame();
    if (!this.take(',')) throw new SyntaxError('Expected a comma or closing brace');
    frame.state = 'keyOrEnd';
  }

  private arrayStep(frame: Extract<(typeof this.frames)[number], { type: 'array' }>): void {
    if (frame.state === 'valueOrEnd') {
      if (this.take(']')) return this.closeFrame();
      return this.readAndAttachValue();
    }
    if (this.take(']')) return this.closeFrame();
    if (!this.take(',')) throw new SyntaxError('Expected a comma or closing bracket');
    frame.state = 'valueOrEnd';
  }

  private readAndAttachValue(): void {
    this.values += 1;
    if (this.values > this.limit.maximumValues)
      throw hostError('BUDGET_EXCEEDED', 'JSON value count exceeds budget');
    const character = this.source[this.index];
    if (character === '{') return this.openObject();
    if (character === '[') return this.openArray();
    if (character === '"') return this.attach(this.string());
    if (character === 't') return this.attach(this.literal('true', true));
    if (character === 'f') return this.attach(this.literal('false', false));
    if (character === 'n') return this.attach(this.literal('null', null));
    if (character === '-' || (character !== undefined && /[0-9]/.test(character)))
      return this.attach(this.number());
    throw new SyntaxError('Expected a JSON value');
  }

  private openObject(): void {
    this.assertDepth();
    this.index += 1;
    this.frames.push({
      type: 'object',
      value: Object.create(null) as Record<string, JsonValue>,
      keys: new Set(),
      state: 'keyOrEnd'
    });
  }

  private openArray(): void {
    this.assertDepth();
    this.index += 1;
    this.frames.push({ type: 'array', value: [], state: 'valueOrEnd' });
  }

  private closeFrame(): void {
    const frame = this.frames.pop();
    if (frame === undefined) throw new SyntaxError('Unexpected closing delimiter');
    this.attach(frame.value);
  }

  private attach(value: JsonValue): void {
    const frame = this.frames.at(-1);
    if (frame === undefined) {
      if (this.hasRoot) throw new SyntaxError('Unexpected JSON value');
      this.root = value;
      this.hasRoot = true;
      return;
    }
    if (frame.type === 'array') {
      if (frame.state !== 'valueOrEnd') throw new SyntaxError('Unexpected array value');
      if (frame.value.length >= this.limit.maximumArrayLength)
        throw hostError('BUDGET_EXCEEDED', 'JSON array length exceeds budget');
      frame.value.push(value);
      frame.state = 'commaOrEnd';
      return;
    }
    if (frame.state !== 'value' || frame.key === undefined)
      throw new SyntaxError('Unexpected object value');
    Object.defineProperty(frame.value, frame.key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
    delete frame.key;
    frame.state = 'commaOrEnd';
  }

  private string(): string {
    const start = this.index++;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        const value = JSON.parse(this.source.slice(start, this.index)) as string;
        if (!isWellFormedUnicode(value)) throw new SyntaxError('Unpaired surrogate in JSON string');
        if (
          utf8ByteLengthAtMost(value, this.limit.maximumStringBytes) > this.limit.maximumStringBytes
        )
          throw hostError('BUDGET_EXCEEDED', 'JSON string exceeds byte budget');
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20)
        throw new SyntaxError('Control character in JSON string');
      this.index += 1;
    }
    throw new SyntaxError('Unterminated JSON string');
  }

  private literal(text: string, value: boolean | null): boolean | null {
    if (this.source.slice(this.index, this.index + text.length) !== text)
      throw new SyntaxError(`Expected ${text}`);
    this.index += text.length;
    return value;
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index)
    );
    if (match === null) throw new SyntaxError('Invalid JSON number');
    if (match[0].length > this.limit.maximumNumberCharacters)
      throw hostError('BUDGET_EXCEEDED', 'JSON number exceeds character budget');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new SyntaxError('JSON number is not finite');
    return value;
  }

  private assertDepth(): void {
    if (this.frames.length + 1 > this.limit.maximumDepth)
      throw hostError('BUDGET_EXCEEDED', 'JSON nesting depth exceeds budget');
  }

  private space(): void {
    while ([' ', '\t', '\r', '\n'].includes(this.source[this.index] ?? '')) this.index += 1;
  }

  private take(character: string): boolean {
    this.space();
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    this.space();
    return true;
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Creates a bounded, deeply frozen JSON data snapshot without reading accessors. */
export function snapshotJsonValue(value: unknown, requested?: Partial<JsonBudgets>): JsonValue {
  const limit = budgets(requested);
  const seen = new WeakSet<object>();
  let count = 0;
  let usedBytes = 0;
  const consumeBytes = (amount: number): void => {
    usedBytes += amount;
    if (usedBytes > limit.maximumBytes)
      throw hostError('BUDGET_EXCEEDED', 'JSON value exceeds byte budget');
  };
  const copy = (candidate: unknown, depth: number): JsonValue => {
    count += 1;
    if (count > limit.maximumValues)
      throw hostError('BUDGET_EXCEEDED', 'JSON value count exceeds budget');
    if (candidate === null) {
      consumeBytes(4);
      return candidate;
    }
    if (typeof candidate === 'boolean') {
      consumeBytes(candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === 'string') {
      if (utf8ByteLengthAtMost(candidate, limit.maximumStringBytes) > limit.maximumStringBytes)
        throw hostError('BUDGET_EXCEEDED', 'JSON string exceeds byte budget');
      consumeBytes(jsonStringBytesAtMost(candidate, limit.maximumBytes - usedBytes));
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw hostError('UNSAFE_VALUE', 'JSON number must be finite');
      const serialized = JSON.stringify(candidate);
      if (serialized.length > limit.maximumNumberCharacters)
        throw hostError('BUDGET_EXCEEDED', 'JSON number exceeds character budget');
      consumeBytes(byteLength(serialized));
      return candidate;
    }
    if (typeof candidate !== 'object')
      throw hostError('UNSAFE_VALUE', 'Value is not JSON-compatible');
    if (depth >= limit.maximumDepth)
      throw hostError('BUDGET_EXCEEDED', 'JSON nesting depth exceeds budget');
    if (seen.has(candidate)) throw hostError('UNSAFE_VALUE', 'Cyclic or aliased JSON value');
    seen.add(candidate);
    let prototype: object | null;
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      prototype = Object.getPrototypeOf(candidate);
      descriptors = boundedDescriptors(
        candidate,
        limit.maximumValues + 1,
        'JSON value has too many properties'
      );
    } catch {
      throw hostError('UNSAFE_VALUE', 'JSON value cannot be inspected safely');
    }
    if (
      (Array.isArray(candidate) && prototype !== Array.prototype) ||
      (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null)
    )
      throw hostError('UNSAFE_VALUE', 'JSON values must have plain prototypes');
    if (Array.isArray(candidate)) {
      if (candidate.length > limit.maximumArrayLength)
        throw hostError('BUDGET_EXCEEDED', 'JSON array length exceeds budget');
      consumeBytes(2);
      const result: JsonValue[] = [];
      const length = candidate.length;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))
          throw hostError('UNSAFE_VALUE', 'JSON arrays may not have custom properties');
      }
      for (let index = 0; index < length; index += 1) {
        if (index > 0) consumeBytes(1);
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
          throw hostError('UNSAFE_VALUE', 'JSON arrays must be dense data arrays');
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    consumeBytes(2);
    const result = Object.create(null) as Record<string, JsonValue>;
    let hasEntry = false;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string')
        throw hostError('UNSAFE_VALUE', 'JSON objects may not contain symbols');
      assertSafeKey(key);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
        throw hostError('UNSAFE_VALUE', 'JSON objects may only contain enumerable data properties');
      if (utf8ByteLengthAtMost(key, limit.maximumStringBytes) > limit.maximumStringBytes)
        throw hostError('BUDGET_EXCEEDED', 'JSON object key exceeds byte budget');
      consumeBytes(
        jsonStringBytesAtMost(key, limit.maximumBytes - usedBytes) + 1 + (hasEntry ? 1 : 0)
      );
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false
      });
      hasEntry = true;
    }
    return Object.freeze(result) as JsonObject;
  };
  return copy(value, 0);
}

function snapshotRecord(value: unknown, field: string): JsonObject {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw invalid(`${field} must be a JSON object`);
  return snapshot as JsonObject;
}

function immutableEnvelope<T extends AgentEnvelope>(envelope: T): T {
  const frozen = Object.freeze(envelope);
  validatedEnvelopes.add(frozen);
  return frozen;
}

function requiredBase(value: JsonObject): EnvelopeBase {
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION)
    throw hostError('UNSUPPORTED_VERSION', 'Unsupported protocol version');
  if (!isIdentifier(value.messageId)) throw invalid('messageId must be a valid identifier');
  if (!isDateTime(value.sentAt)) throw invalid('sentAt must be an RFC 3339 date-time');
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    messageId: value.messageId,
    sentAt: value.sentAt
  };
}

/** Validates the v1 supported fields and returns an immutable data-only envelope. */
export function validateEnvelope(value: unknown): AgentEnvelope {
  if (typeof value === 'object' && value !== null && validatedEnvelopes.has(value))
    return value as AgentEnvelope;
  const record = snapshotRecord(value, 'Envelope');
  const base = requiredBase(record);
  switch (record.kind) {
    case 'hello': {
      const capabilities = snapshotCapabilities(record.capabilities, 'hello.capabilities');
      if (record.implementation !== undefined && typeof record.implementation !== 'string')
        throw invalid('hello.implementation must be a string');
      return immutableEnvelope({
        ...base,
        kind: 'hello',
        capabilities,
        ...(record.implementation === undefined ? {} : { implementation: record.implementation })
      });
    }
    case 'request': {
      if (!isIdentifier(record.requestId))
        throw invalid('request.requestId must be a valid identifier');
      if (!isCapability(record.operation)) throw invalid('request.operation must be a capability');
      const input = snapshotRecord(record.input, 'request.input');
      return immutableEnvelope({
        ...base,
        kind: 'request',
        requestId: record.requestId,
        operation: record.operation,
        input
      });
    }
    case 'event': {
      if (!isIdentifier(record.requestId))
        throw invalid('event.requestId must be a valid identifier');
      if (!isCapability(record.event))
        throw invalid('event.event must be a capability-like event name');
      const output =
        record.output === undefined ? undefined : snapshotRecord(record.output, 'event.output');
      return immutableEnvelope({
        ...base,
        kind: 'event',
        requestId: record.requestId,
        event: record.event,
        ...(output === undefined ? {} : { output })
      });
    }
    case 'cancel':
      if (!isIdentifier(record.requestId))
        throw invalid('cancel.requestId must be a valid identifier');
      return immutableEnvelope({ ...base, kind: 'cancel', requestId: record.requestId });
    case 'error': {
      if (!isIdentifier(record.requestId) && record.requestId !== undefined)
        throw invalid('error.requestId must be a valid identifier when provided');
      if (typeof record.code !== 'string' || !errorCodePattern.test(record.code))
        throw invalid('error.code must be an uppercase error code');
      if (typeof record.message !== 'string' || byteLength(record.message) > 4096)
        throw invalid('error.message must be a string up to 4096 bytes');
      if (record.retryable !== undefined && typeof record.retryable !== 'boolean')
        throw invalid('error.retryable must be a boolean when provided');
      return immutableEnvelope({
        ...base,
        kind: 'error',
        ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
        code: record.code,
        message: record.message,
        ...(record.retryable === undefined ? {} : { retryable: record.retryable })
      });
    }
    default:
      throw invalid('Unknown message kind');
  }
}

export function validateHello(value: unknown): HelloEnvelope {
  const envelope = validateEnvelope(value);
  if (envelope.kind !== 'hello') throw invalid('Expected hello envelope');
  return envelope;
}

export function validateEventEnvelope(value: unknown): EventEnvelope {
  const envelope = validateEnvelope(value);
  if (envelope.kind !== 'event') throw invalid('Expected event envelope');
  return envelope;
}

/** Revalidates unbranded runtime inputs and captures an immutable execution snapshot. */
export function validateExecution(value: unknown): AgentExecution {
  if (typeof value === 'object' && value !== null && validatedExecutions.has(value))
    return value as AgentExecution;
  if (!isRecord(value)) throw invalid('Execution must be a JSON-like object');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = boundedDescriptors(value, 4, 'Execution contains too many fields');
  } catch (error) {
    if (error instanceof AgentProtocolError && trustedProtocolErrors.has(error)) throw error;
    throw hostError('UNSAFE_VALUE', 'Execution cannot be inspected safely');
  }
  for (const key of ['requestId', 'capability', 'input'] as const) {
    if (!('value' in (descriptors[key] ?? {})))
      throw invalid(`execution.${key} must be a data property`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== 'requestId' && key !== 'capability' && key !== 'input')
      throw invalid('Execution contains an unknown field');
    if (!('value' in descriptors[key]!))
      throw invalid(`execution.${String(key)} must be a data property`);
  }
  const requestId = descriptors.requestId?.value;
  const capability = descriptors.capability?.value;
  const inputValue = descriptors.input?.value;
  if (!isIdentifier(requestId)) throw invalid('execution.requestId must be a valid identifier');
  if (!isCapability(capability)) throw invalid('execution.capability must be a capability');
  const input = snapshotRecord(inputValue, 'execution.input');
  const execution = Object.freeze({
    requestId,
    capability,
    input
  }) as AgentExecution;
  validatedExecutions.add(execution);
  return execution;
}

/** Parses a complete JSONL frame with bounded, iterative structural parsing. */
export function parseJsonlEnvelope(
  line: string,
  requested?: number | Partial<JsonBudgets>
): AgentEnvelope {
  const limit = budgets(requested);
  if (utf8ByteLengthAtMost(line, limit.maximumBytes) > limit.maximumBytes)
    throw hostError('LINE_TOO_LARGE', `JSONL frame exceeds ${limit.maximumBytes} bytes`);
  try {
    return validateEnvelope(new BoundedJsonParser(line, limit).parse());
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw hostError('INVALID_JSON', 'Malformed JSONL frame');
  }
}

/** Serializes only a validated snapshot and normalizes serialization failures to bounded protocol errors. */
export function encodeJsonlEnvelope(envelope: AgentEnvelope): string {
  const valid = validateEnvelope(envelope);
  try {
    const line = JSON.stringify(valid);
    if (utf8ByteLengthAtMost(line, MAX_JSONL_LINE_BYTES) > MAX_JSONL_LINE_BYTES)
      throw hostError('LINE_TOO_LARGE', `JSONL frame exceeds ${MAX_JSONL_LINE_BYTES} bytes`);
    return `${line}\n`;
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw hostError('SERIALIZATION_FAILED', 'Unable to serialize JSONL envelope');
  }
}

export function normalizeAdapterError(_error: unknown): AgentProtocolError {
  return hostError('ADAPTER_FAILURE', 'Agent adapter failed');
}

export class AgentProtocolSession {
  private remoteCapabilities = new Set<AgentCapability>();
  private helloAccepted = false;
  private closed = false;
  private readonly requests = new Map<string, 'active' | 'cancelling'>();
  private readonly retiredRequestIds = new Set<string>();
  private readonly retiredRequestOrder: string[] = [];
  private readonly messageIds = new Set<string>();
  private readonly messageIdOrder: string[] = [];
  public readonly localCapabilities: readonly AgentCapability[];

  public constructor(localCapabilities: readonly AgentCapability[]) {
    this.localCapabilities = snapshotCapabilities(localCapabilities, 'Local capabilities');
  }

  public acceptHello(hello: HelloEnvelope): void {
    this.assertOpen();
    if (this.helloAccepted) throw invalid('Hello has already been accepted for this session');
    const valid = validateHello(hello);
    this.remoteCapabilities = new Set(valid.capabilities);
    this.helloAccepted = true;
    this.trackMessageId(valid.messageId);
  }

  public supports(capability: AgentCapability): boolean {
    return (
      !this.closed &&
      isCapability(capability) &&
      this.localCapabilities.includes(capability) &&
      this.remoteCapabilities.has(capability)
    );
  }

  public assertNegotiated(capability: AgentCapability): void {
    this.assertOpen();
    if (!this.supports(capability)) throw invalid('Capability is not negotiated');
  }

  /** Registers an outbound request before a peer may refer to its request ID. */
  public beginRequest(requestId: string, capability: AgentCapability): void {
    this.assertOpen();
    if (!isIdentifier(requestId)) throw invalid('requestId must be a valid identifier');
    this.assertNegotiated(capability);
    if (this.requests.size >= MAX_IN_FLIGHT_REQUESTS)
      throw hostError('BUDGET_EXCEEDED', 'Too many tracked requests');
    if (this.requests.has(requestId) || this.retiredRequestIds.has(requestId))
      throw invalid('requestId has already been used');
    this.requests.set(requestId, 'active');
  }

  /** Marks an outbound cancellation and rejects duplicate or terminal cancellation. */
  public cancelRequest(requestId: string): void {
    this.assertOpen();
    const state = this.requests.get(requestId);
    if (state !== 'active') throw invalid('Cannot cancel request');
    this.requests.set(requestId, 'cancelling');
  }

  /** Validates remote lifecycle frames before a host dispatches them. */
  public acceptIncoming(value: unknown): AgentEnvelope {
    this.assertOpen();
    const envelope = validateEnvelope(value);
    if (this.messageIds.has(envelope.messageId)) throw invalid('Duplicate messageId');
    if (envelope.kind === 'hello') {
      this.acceptHello(envelope);
      return envelope;
    }
    if (envelope.kind === 'request' || envelope.kind === 'cancel')
      throw invalid('Unexpected inbound frame');
    if (envelope.kind === 'error' && envelope.requestId === undefined) {
      this.trackMessageId(envelope.messageId);
      return envelope;
    }
    const requestId = envelope.requestId;
    if (requestId === undefined) throw invalid('Inbound terminal frame requires requestId');
    const state = this.requests.get(requestId);
    if (state === undefined) throw invalid('Unknown or terminal requestId');
    if (envelope.kind === 'event') {
      const terminal = envelope.event === 'completed' || envelope.event === 'cancelled';
      if (state === 'cancelling' && envelope.event === 'completed')
        throw invalid('Cancelled request completed');
      if (terminal) this.retireRequest(requestId);
      this.trackMessageId(envelope.messageId);
      return envelope;
    }
    this.retireRequest(requestId);
    this.trackMessageId(envelope.messageId);
    return envelope;
  }

  public close(): void {
    this.closed = true;
    this.requests.clear();
    this.remoteCapabilities.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw invalid('Session is closed');
  }

  private retireRequest(requestId: string): void {
    this.requests.delete(requestId);
    this.trackBounded(this.retiredRequestIds, this.retiredRequestOrder, requestId);
  }

  private trackMessageId(messageId: string): void {
    this.trackBounded(this.messageIds, this.messageIdOrder, messageId);
  }

  private trackBounded(values: Set<string>, order: string[], value: string): void {
    values.add(value);
    order.push(value);
    if (order.length > MAX_IN_FLIGHT_REQUESTS) values.delete(order.shift()!);
  }
}

export interface AgentExecution {
  readonly requestId: string;
  readonly capability: AgentCapability;
  readonly input: JsonObject;
}

/** Agent-owned structural projection of a host-supervised provider call. */
export interface AgentProviderCallContext {
  readonly ownerGeneration: number;
  /** Remaining duration captured by the trusted runtime; never its absolute clock value. */
  readonly remainingMs?: number;
  readonly cancellation: {
    isCancellationRequested(): boolean;
    reason(): 'caller-aborted' | 'deadline-exceeded' | undefined;
    subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void;
  };
}

export type AgentProviderRuntimeErrorCode =
  | 'CALLER_ABORTED'
  | 'DEADLINE_EXCEEDED'
  | 'EFFECT_FAILED'
  | 'OWNER_CAPACITY_REACHED'
  | 'OWNER_QUARANTINED'
  | 'PROCESS_CAPACITY_REACHED';

/** Exact, redacted runtime outcome recognized by the SDK only when factory-issued. */
export interface AgentProviderRuntimeError extends Error {
  readonly code: AgentProviderRuntimeErrorCode;
}

const runtimeErrorCodes = new Set<AgentProviderRuntimeErrorCode>([
  'CALLER_ABORTED',
  'DEADLINE_EXCEEDED',
  'EFFECT_FAILED',
  'OWNER_CAPACITY_REACHED',
  'OWNER_QUARANTINED',
  'PROCESS_CAPACITY_REACHED'
]);
const issuedRuntimeErrors = new WeakSet<object>();

/** Creates an exact, message-redacted runtime result for trusted host adapters. */
export function createAgentProviderRuntimeError(code: unknown): AgentProviderRuntimeError {
  if (!runtimeErrorCodes.has(code as AgentProviderRuntimeErrorCode))
    throw new TypeError('Agent provider runtime error code is invalid');
  const error = new Error('Agent provider runtime rejected the call') as AgentProviderRuntimeError;
  Object.defineProperty(error, 'code', {
    value: code as AgentProviderRuntimeErrorCode,
    enumerable: true,
    writable: false,
    configurable: false
  });
  issuedRuntimeErrors.add(error);
  return error;
}

export interface AgentProviderCancellationPort {
  isAborted(): boolean;
  addAbortListener(listener: () => void): void;
  removeAbortListener(listener: () => void): void;
}

export interface AgentProviderRuntimeCallOptions {
  /** Positive timeout duration; only the trusted runtime converts it to its clock domain. */
  readonly timeoutMs?: number;
  readonly cancellation?: AgentProviderCancellationPort;
}

/**
 * Trusted hosts supply this port. The SDK never creates admission pools,
 * supervisors, timers, or provider-owned cancellation state itself.
 */
export interface AgentProviderRuntime {
  run<T>(
    owner: object,
    effect: (context: AgentProviderCallContext) => T,
    options?: AgentProviderRuntimeCallOptions
  ): Promise<T>;
  runCleanup<T>(
    owner: object,
    effect: (context: AgentProviderCallContext) => T,
    options?: AgentProviderRuntimeCallOptions
  ): Promise<T>;
  /** Starts a replacement adapter generation while late work remains fenced. */
  replaceGeneration(owner: object): void;
  /** Re-admits a settled quarantined generation; throws until late work settles. */
  recover(owner: object): void;
}

export interface AgentAdapter {
  readonly capabilities: readonly AgentCapability[];
  /** The provider receives the shared host-owned context for every stream creation. */
  stream(
    context: AgentProviderCallContext,
    execution: AgentExecution
  ): AsyncIterable<EventEnvelope>;
}

export interface ValidatedAgentAdapter {
  readonly capabilities: readonly AgentCapability[];
  stream(
    context: AgentProviderCallContext,
    execution: AgentExecution
  ): AsyncIterable<EventEnvelope>;
}

export interface StreamValidationOptions {
  /** Agent-owned handle that composes the shared provider-effect pool internally. */
  readonly runtime: AgentProviderRuntime;
  /** Optional positive timeout duration; never a supervisor clock value. */
  readonly timeoutMs?: number;
  /** Optional caller-abort port owned and validated by the trusted runtime. */
  readonly cancellation?: AgentProviderCancellationPort;
}

const MAX_ADAPTER_EVENTS = 1_024;
const MAX_ADAPTER_STREAM_BYTES = MAX_JSONL_LINE_BYTES;
const validatedAdapters = new WeakMap<object, ValidatedAgentAdapter>();
const adapterEffectOwners = new WeakMap<ValidatedAgentAdapter, object>();

function streamOptions(value: StreamValidationOptions | undefined): {
  readonly runtimeTarget: object;
  readonly run: (...arguments_: unknown[]) => unknown;
  readonly runCleanup: (...arguments_: unknown[]) => unknown;
  readonly timeoutMs?: number;
  readonly cancellation?: AgentProviderCancellationPort;
} {
  if (value === undefined)
    throw invalid('Stream options with a host-effect supervisor are required');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid('Stream options must be a plain data object');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw invalid('Stream options must be plain');
    descriptors = boundedDescriptors(value, 3, 'Stream options contain too many fields');
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw hostError('UNSAFE_VALUE', 'Stream options cannot be inspected safely');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== 'runtime' && key !== 'timeoutMs' && key !== 'cancellation')
      throw invalid('Stream options contain an unknown field');
    if (!('value' in descriptors[key]!))
      throw invalid('Stream options must contain data properties');
  }
  const runtime = descriptors.runtime?.value;
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime))
    throw invalid('Stream runtime must be an agent provider runtime');
  const run = safeDataProperty(runtime, 'run')?.value;
  if (typeof run !== 'function') throw invalid('Stream runtime must expose a data run function');
  const runCleanup = safeDataProperty(runtime, 'runCleanup')?.value;
  if (typeof runCleanup !== 'function')
    throw invalid('Stream runtime must expose a data runCleanup function');
  const timeoutMs = descriptors.timeoutMs?.value;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw invalid('Stream timeout is outside the supported range');
  const cancellation = descriptors.cancellation?.value;
  if (cancellation !== undefined && (typeof cancellation !== 'object' || cancellation === null))
    throw invalid('Stream cancellation must be a runtime-owned port');
  return Object.freeze({
    runtimeTarget: runtime,
    run: run as (...arguments_: unknown[]) => unknown,
    runCleanup: runCleanup as (...arguments_: unknown[]) => unknown,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    ...(cancellation === undefined
      ? {}
      : { cancellation: cancellation as AgentProviderCancellationPort })
  });
}

function validateIteratorResult(value: unknown): {
  readonly done: boolean;
  readonly value?: unknown;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid('Adapter iterator returned an invalid result');
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw invalid('Adapter iterator result must have a plain prototype');
    descriptors = boundedDescriptors(value, 2, 'Adapter iterator result contains too many fields');
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw hostError('UNSAFE_VALUE', 'Adapter iterator result cannot be inspected safely');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (key !== 'done' && key !== 'value'))
      throw invalid('Adapter iterator result contains an unknown field');
    if (!('value' in descriptors[key]!))
      throw invalid('Adapter iterator result must contain data properties');
  }
  const done = descriptors.done?.value;
  if (typeof done !== 'boolean') throw invalid('Adapter iterator result.done must be data boolean');
  const descriptor = descriptors.value;
  if (!done && (descriptor === undefined || !('value' in descriptor)))
    throw invalid('Adapter iterator result.value must be data');
  return Object.freeze({ done, ...(descriptor === undefined ? {} : { value: descriptor.value }) });
}

/** Captures an adapter's declared capabilities without invoking caller-defined accessors. */
export function validateAdapter(value: unknown): ValidatedAgentAdapter {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid('Agent adapter must be an object');
  const existing = validatedAdapters.get(value);
  if (existing !== undefined) return existing;
  const capabilities = safeDataProperty(value, 'capabilities')?.value;
  const stream = safeMethod(value, 'stream');
  if (stream === undefined) throw invalid('Agent adapter stream must be a data function');
  const owner = Object.freeze({});
  const validated = Object.freeze({
    capabilities: snapshotCapabilities(capabilities, 'Agent adapter capabilities'),
    stream: (context: AgentProviderCallContext, execution: AgentExecution) =>
      Reflect.apply(stream, value, [context, execution]) as AsyncIterable<EventEnvelope>
  });
  validatedAdapters.set(value, validated);
  validatedAdapters.set(validated, validated);
  adapterEffectOwners.set(validated, owner);
  return validated;
}

export function replaceAdapterGeneration(
  adapter: AgentAdapter,
  runtime: AgentProviderRuntime
): void {
  const owner = adapterEffectOwners.get(validateAdapter(adapter));
  if (owner === undefined)
    throw hostError('ADAPTER_FAILURE', 'Adapter effect owner is unavailable');
  invokeRuntimeLifecycle(runtime, 'replaceGeneration', owner);
}

export function recoverAdapterGeneration(
  adapter: AgentAdapter,
  runtime: AgentProviderRuntime
): void {
  const owner = adapterEffectOwners.get(validateAdapter(adapter));
  if (owner === undefined)
    throw hostError('ADAPTER_FAILURE', 'Adapter effect owner is unavailable');
  invokeRuntimeLifecycle(runtime, 'recover', owner);
}

function runtimeOutcome(error: unknown): never {
  if (typeof error === 'object' && error !== null && issuedRuntimeErrors.has(error)) {
    const code = (error as AgentProviderRuntimeError).code;
    if (code === 'CALLER_ABORTED')
      throw hostError('CANCELLED', 'Agent provider call was cancelled');
    if (code === 'DEADLINE_EXCEEDED')
      throw hostError('BUDGET_EXCEEDED', 'Agent provider call exceeded its deadline');
    if (
      code === 'OWNER_CAPACITY_REACHED' ||
      code === 'OWNER_QUARANTINED' ||
      code === 'PROCESS_CAPACITY_REACHED'
    )
      throw hostError('BUDGET_EXCEEDED', 'Agent provider runtime admission is unavailable');
    throw hostError('ADAPTER_FAILURE', 'Agent provider call failed');
  }
  throw normalizeAdapterError(error);
}

function invokeRuntimeLifecycle(
  runtime: AgentProviderRuntime,
  method: 'replaceGeneration' | 'recover',
  owner: object
): void {
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime))
    throw invalid('Agent provider runtime is invalid');
  const captured = safeDataProperty(runtime, method)?.value;
  if (typeof captured !== 'function') throw invalid(`Agent provider runtime must expose ${method}`);
  try {
    Reflect.apply(captured as (...arguments_: unknown[]) => unknown, runtime, [owner]);
  } catch (error) {
    runtimeOutcome(error);
  }
}

async function runProviderEffect<T>(
  control: {
    readonly runtimeTarget: object;
    readonly run: (...arguments_: unknown[]) => unknown;
    readonly runCleanup: (...arguments_: unknown[]) => unknown;
    readonly timeoutMs?: number;
    readonly cancellation?: AgentProviderCancellationPort;
  },
  owner: object,
  effect: (context: AgentProviderCallContext) => unknown,
  cleanup = false
): Promise<T> {
  try {
    return (await Reflect.apply(cleanup ? control.runCleanup : control.run, control.runtimeTarget, [
      owner,
      effect,
      control.timeoutMs === undefined && control.cancellation === undefined
        ? undefined
        : {
            ...(control.timeoutMs === undefined ? {} : { timeoutMs: control.timeoutMs }),
            ...(control.cancellation === undefined ? {} : { cancellation: control.cancellation })
          }
    ])) as T;
  } catch (error) {
    runtimeOutcome(error);
  }
}

/** Validates an adapter boundary and normalizes non-protocol failures. */
export async function* streamValidatedEvents(
  adapter: AgentAdapter,
  execution: AgentExecution,
  options: StreamValidationOptions
): AsyncIterable<EventEnvelope> {
  const safeExecution = validateExecution(execution);
  const safeAdapter = validateAdapter(adapter);
  const control = streamOptions(options);
  const owner = adapterEffectOwners.get(safeAdapter);
  if (owner === undefined)
    throw hostError('ADAPTER_FAILURE', 'Adapter effect owner is unavailable');
  if (!safeAdapter.capabilities.includes(safeExecution.capability))
    throw invalid(`Adapter does not declare capability: ${safeExecution.capability}`);
  let iterator: object | undefined;
  let close: ((...arguments_: unknown[]) => unknown) | undefined;
  let finished = false;
  try {
    const iterable = await runProviderEffect<unknown>(control, owner, (context) =>
      safeAdapter.stream(context, safeExecution)
    );
    if (typeof iterable !== 'object' || iterable === null)
      throw invalid('Adapter stream is not iterable');
    const iteratorFactory = safeMethod(iterable, Symbol.asyncIterator);
    if (iteratorFactory === undefined) throw invalid('Adapter stream is not async iterable');
    const candidateIterator = Reflect.apply(iteratorFactory, iterable, []);
    if (typeof candidateIterator !== 'object' || candidateIterator === null)
      throw invalid('Adapter iterator is not an object');
    iterator = candidateIterator;
    const next = safeMethod(iterator, 'next');
    if (next === undefined) throw invalid('Adapter iterator has no next method');
    close = safeMethod(iterator, 'return');
    let events = 0;
    let bytes = 0;
    while (true) {
      // Stream ordering is protocol state, so concurrent reads are unsafe.
      // eslint-disable-next-line no-await-in-loop
      const result = validateIteratorResult(
        await runProviderEffect(control, owner, () => Reflect.apply(next, iterator, []))
      );
      if (result.done) break;
      events += 1;
      if (events > MAX_ADAPTER_EVENTS)
        throw hostError('BUDGET_EXCEEDED', 'Adapter event budget exceeded');
      const candidate = result.value;
      const event = validateEventEnvelope(candidate);
      if (event.requestId !== safeExecution.requestId)
        throw invalid('Adapter event does not belong to the active request');
      bytes += byteLength(encodeJsonlEnvelope(event));
      if (bytes > MAX_ADAPTER_STREAM_BYTES)
        throw hostError('BUDGET_EXCEEDED', 'Adapter byte budget exceeded');
      if (event.event !== 'completed' && event.event !== 'cancelled') {
        yield event;
        continue;
      }
      // Consume one final item before exposing completion to the caller.
      // eslint-disable-next-line no-await-in-loop
      const trailing = validateIteratorResult(
        await runProviderEffect(control, owner, () => Reflect.apply(next, iterator, []))
      );
      if (trailing.done !== true) throw invalid('Adapter emitted output after terminal event');
      finished = true;
      yield event;
      return;
    }
    throw invalid('Adapter stream ended without a terminal event');
  } catch (error) {
    if (error instanceof AgentProtocolError && trustedProtocolErrors.has(error)) throw error;
    throw normalizeAdapterError(error);
  } finally {
    const closeMethod = close;
    if (!finished && iterator !== undefined && closeMethod !== undefined) {
      void runProviderEffect(
        control,
        owner,
        () => Reflect.apply(closeMethod, iterator, []),
        true
      ).then(
        (result) => {
          try {
            validateIteratorResult(result);
          } catch {
            // Adapter cleanup cannot replace the primary stream result.
          }
        },
        () => undefined
      );
    }
  }
}

export interface FakeAgentScenario {
  readonly events: readonly { readonly event: string; readonly output?: JsonObject }[];
}

/** A pure deterministic adapter that snapshots scenarios before a consumer can mutate them. */
export class DeterministicFakeAdapter implements AgentAdapter {
  public readonly capabilities: readonly AgentCapability[];
  private readonly scenarios: Readonly<Record<AgentCapability, FakeAgentScenario>>;
  private sequence = 0;

  public constructor(scenarios: Readonly<Record<AgentCapability, FakeAgentScenario>>) {
    const snapshot = snapshotRecord(scenarios, 'Fake scenarios');
    const safe: Record<string, FakeAgentScenario> = Object.create(null);
    for (const [capability, candidate] of Object.entries(snapshot)) {
      if (!isCapability(capability) || !isRecord(candidate) || !Array.isArray(candidate.events))
        throw invalid('Fake scenarios must map valid capabilities to event arrays');
      if (candidate.events.length === 0 || candidate.events.length > MAX_IN_FLIGHT_REQUESTS)
        throw invalid('Fake scenarios must have a bounded terminal event sequence');
      const events = candidate.events.map((event) => {
        if (!isRecord(event) || !isCapability(event.event))
          throw invalid('Fake events must have valid event names');
        const output =
          event.output === undefined
            ? undefined
            : snapshotRecord(event.output, 'Fake event output');
        return Object.freeze({ event: event.event, ...(output === undefined ? {} : { output }) });
      });
      if (
        !['completed', 'cancelled'].includes(events.at(-1)!.event) ||
        events.slice(0, -1).some((event) => ['completed', 'cancelled'].includes(event.event))
      )
        throw invalid('Fake scenarios must end with exactly one terminal event');
      safe[capability] = Object.freeze({ events: Object.freeze(events) });
    }
    if (Object.keys(safe).length > MAX_CAPABILITIES)
      throw hostError('BUDGET_EXCEEDED', 'Fake scenarios exceed capability budget');
    this.scenarios = Object.freeze(safe);
    this.capabilities = Object.freeze(Object.keys(safe).sort());
  }

  public async *stream(
    _context: AgentProviderCallContext,
    execution: AgentExecution
  ): AsyncIterable<EventEnvelope> {
    const safeExecution = validateExecution(execution);
    const scenario = this.scenarios[safeExecution.capability];
    if (scenario === undefined) throw invalid('Unsupported fake capability');
    for (const step of scenario.events) {
      yield validateEventEnvelope({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        kind: 'event',
        messageId: `fake-${++this.sequence}`,
        sentAt: '1970-01-01T00:00:00Z',
        requestId: safeExecution.requestId,
        event: step.event,
        ...(step.output === undefined ? {} : { output: step.output })
      });
    }
  }
}
