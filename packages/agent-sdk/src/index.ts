/**
 * Provider- and runtime-neutral protocol primitives. This package deliberately
 * does not launch processes or access the filesystem, network, or Electron.
 */
export const agentSdkPackageName = '@selene/agent-sdk';

export const AGENT_PROTOCOL_VERSION = '1.0' as const;
export const MAX_JSONL_LINE_BYTES = 64 * 1024;

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
  | CancelEnvelope
  | ErrorEnvelope
  | EventEnvelope
  | HelloEnvelope
  | RequestEnvelope;

export class AgentProtocolError extends Error {
  public constructor(
    public readonly code:
      | 'DUPLICATE_KEY'
      | 'INVALID_ENVELOPE'
      | 'INVALID_JSON'
      | 'LINE_TOO_LARGE'
      | 'UNSUPPORTED_VERSION',
    message: string
  ) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value);
}

function isCapability(value: unknown): value is AgentCapability {
  return typeof value === 'string' && capabilityPattern.test(value);
}

function isDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' && dateTimePattern.test(value) && Number.isFinite(Date.parse(value))
  );
}

function optionalJsonObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw invalid(`${field} must be a JSON object`);
  return value;
}

function invalid(message: string): AgentProtocolError {
  return new AgentProtocolError('INVALID_ENVELOPE', message);
}

function requiredBase(value: Record<string, unknown>): EnvelopeBase {
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentProtocolError(
      'UNSUPPORTED_VERSION',
      `Unsupported protocol version: ${String(value.protocolVersion)}`
    );
  }
  if (!isIdentifier(value.messageId)) throw invalid('messageId must be a valid identifier');
  if (!isDateTime(value.sentAt)) throw invalid('sentAt must be an RFC 3339 date-time');
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    messageId: value.messageId,
    sentAt: value.sentAt
  };
}

/** Validates the v1 schema's supported fields while tolerating unknown optional fields. */
export function validateEnvelope(value: unknown): AgentEnvelope {
  if (!isRecord(value)) throw invalid('Envelope must be a JSON object');
  const base = requiredBase(value);

  switch (value.kind) {
    case 'hello': {
      if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)) {
        throw invalid('hello.capabilities must be an array of capabilities');
      }
      if (new Set(value.capabilities).size !== value.capabilities.length) {
        throw invalid('hello.capabilities must not contain duplicates');
      }
      if (value.implementation !== undefined && typeof value.implementation !== 'string') {
        throw invalid('hello.implementation must be a string');
      }
      return {
        ...base,
        kind: 'hello',
        capabilities: value.capabilities,
        ...(value.implementation === undefined ? {} : { implementation: value.implementation })
      };
    }
    case 'request': {
      if (!isIdentifier(value.requestId))
        throw invalid('request.requestId must be a valid identifier');
      if (!isCapability(value.operation)) throw invalid('request.operation must be a capability');
      if (!isJsonObject(value.input)) throw invalid('request.input must be a JSON object');
      return {
        ...base,
        kind: 'request',
        requestId: value.requestId,
        operation: value.operation,
        input: value.input
      };
    }
    case 'event': {
      if (!isIdentifier(value.requestId))
        throw invalid('event.requestId must be a valid identifier');
      if (!isCapability(value.event))
        throw invalid('event.event must be a capability-like event name');
      const output = optionalJsonObject(value.output, 'event.output');
      return {
        ...base,
        kind: 'event',
        requestId: value.requestId,
        event: value.event,
        ...(output === undefined ? {} : { output })
      };
    }
    case 'cancel':
      if (!isIdentifier(value.requestId))
        throw invalid('cancel.requestId must be a valid identifier');
      return { ...base, kind: 'cancel', requestId: value.requestId };
    case 'error': {
      if (!isIdentifier(value.requestId) && value.requestId !== undefined) {
        throw invalid('error.requestId must be a valid identifier when provided');
      }
      if (typeof value.code !== 'string' || !errorCodePattern.test(value.code)) {
        throw invalid('error.code must be an uppercase error code');
      }
      if (typeof value.message !== 'string' || value.message.length > 4096) {
        throw invalid('error.message must be a string up to 4096 characters');
      }
      if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
        throw invalid('error.retryable must be a boolean when provided');
      }
      return {
        ...base,
        kind: 'error',
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        code: value.code,
        message: value.message,
        ...(value.retryable === undefined ? {} : { retryable: value.retryable })
      };
    }
    default:
      throw invalid(`Unknown message kind: ${String(value.kind)}`);
  }
}

class DuplicateKeyScanner {
  private index = 0;

  public constructor(private readonly source: string) {}

  public scan(): void {
    this.value();
    this.space();
    if (this.index !== this.source.length)
      throw new SyntaxError('Unexpected trailing JSON content');
  }

  private value(): void {
    this.space();
    const character = this.source[this.index];
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    if (character === '"') return void this.string();
    if (character === 't') return this.literal('true');
    if (character === 'f') return this.literal('false');
    if (character === 'n') return this.literal('null');
    if (character === '-' || (character !== undefined && /[0-9]/.test(character)))
      return this.number();
    throw new SyntaxError('Expected a JSON value');
  }

  private object(): void {
    this.index += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.index] === '}') return void (this.index += 1);
    while (true) {
      this.space();
      if (this.source[this.index] !== '"') throw new SyntaxError('Expected an object key');
      const key = this.string();
      if (keys.has(key)) {
        throw new AgentProtocolError('DUPLICATE_KEY', `Duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      this.space();
      if (this.source[this.index] !== ':') throw new SyntaxError('Expected a colon');
      this.index += 1;
      this.value();
      this.space();
      const next = this.source[this.index];
      if (next === '}') return void (this.index += 1);
      if (next !== ',') throw new SyntaxError('Expected a comma or closing brace');
      this.index += 1;
    }
  }

  private array(): void {
    this.index += 1;
    this.space();
    if (this.source[this.index] === ']') return void (this.index += 1);
    while (true) {
      this.value();
      this.space();
      const next = this.source[this.index];
      if (next === ']') return void (this.index += 1);
      if (next !== ',') throw new SyntaxError('Expected a comma or closing bracket');
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      this.index += 1;
    }
    throw new SyntaxError('Unterminated JSON string');
  }

  private literal(value: string): void {
    if (this.source.slice(this.index, this.index + value.length) !== value) {
      throw new SyntaxError(`Expected ${value}`);
    }
    this.index += value.length;
  }

  private number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index)
    );
    if (match === null) throw new SyntaxError('Invalid JSON number');
    this.index += match[0].length;
  }

  private space(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }
}

/** Parses one complete JSONL frame and rejects duplicate object keys before JSON.parse can erase them. */
export function parseJsonlEnvelope(
  line: string,
  maximumBytes = MAX_JSONL_LINE_BYTES
): AgentEnvelope {
  if (new TextEncoder().encode(line).byteLength > maximumBytes) {
    throw new AgentProtocolError('LINE_TOO_LARGE', `JSONL frame exceeds ${maximumBytes} bytes`);
  }
  try {
    new DuplicateKeyScanner(line).scan();
    return validateEnvelope(JSON.parse(line) as unknown);
  } catch (error) {
    if (error instanceof AgentProtocolError) throw error;
    throw new AgentProtocolError(
      'INVALID_JSON',
      error instanceof Error ? `Malformed JSONL frame: ${error.message}` : 'Malformed JSONL frame'
    );
  }
}

export function encodeJsonlEnvelope(envelope: AgentEnvelope): string {
  validateEnvelope(envelope);
  return `${JSON.stringify(envelope)}\n`;
}

export class AgentProtocolSession {
  private remoteCapabilities = new Set<AgentCapability>();

  public constructor(public readonly localCapabilities: readonly AgentCapability[]) {
    if (
      !localCapabilities.every(isCapability) ||
      new Set(localCapabilities).size !== localCapabilities.length
    ) {
      throw new AgentProtocolError(
        'INVALID_ENVELOPE',
        'Local capabilities must be unique valid capabilities'
      );
    }
  }

  public acceptHello(hello: HelloEnvelope): void {
    this.remoteCapabilities = new Set(hello.capabilities);
  }

  public supports(capability: AgentCapability): boolean {
    return this.localCapabilities.includes(capability) && this.remoteCapabilities.has(capability);
  }

  public assertNegotiated(capability: AgentCapability): void {
    if (!this.supports(capability)) {
      throw new AgentProtocolError(
        'INVALID_ENVELOPE',
        `Capability is not negotiated: ${capability}`
      );
    }
  }
}

export interface AgentExecution {
  readonly requestId: string;
  readonly capability: AgentCapability;
  readonly input: JsonObject;
  readonly signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly capabilities: readonly AgentCapability[];
  stream(execution: AgentExecution): AsyncIterable<EventEnvelope>;
}

export interface FakeAgentScenario {
  readonly events: readonly { readonly event: string; readonly output?: JsonObject }[];
}

/** A pure, deterministic adapter for consumers that need streaming test doubles. */
export class DeterministicFakeAdapter implements AgentAdapter {
  public readonly capabilities: readonly AgentCapability[];

  public constructor(
    private readonly scenarios: Readonly<Record<AgentCapability, FakeAgentScenario>>
  ) {
    this.capabilities = Object.keys(scenarios);
  }

  public async *stream(execution: AgentExecution): AsyncIterable<EventEnvelope> {
    const scenario = this.scenarios[execution.capability];
    if (scenario === undefined) {
      throw new AgentProtocolError(
        'INVALID_ENVELOPE',
        `Unsupported fake capability: ${execution.capability}`
      );
    }
    for (const step of scenario.events) {
      if (execution.signal?.aborted) {
        throw new AgentProtocolError(
          'INVALID_ENVELOPE',
          `Request cancelled: ${execution.requestId}`
        );
      }
      yield {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        kind: 'event',
        messageId: `fake-${execution.requestId}-${step.event}`,
        sentAt: '1970-01-01T00:00:00Z',
        requestId: execution.requestId,
        event: step.event,
        ...(step.output === undefined ? {} : { output: step.output })
      };
    }
  }
}
