import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

import {
  AGENT_PROTOCOL_VERSION,
  type AgentCapability,
  type AgentEnvelope,
  AgentProtocolSession,
  type CancelEnvelope,
  type ErrorEnvelope,
  type EventEnvelope,
  type HelloEnvelope,
  type JsonObject,
  MAX_JSONL_LINE_BYTES,
  parseJsonlEnvelope,
  type RequestEnvelope,
  type WorkspaceGrant
} from '@selene/agent-sdk';

export const SAFE_ENVIRONMENT_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM'
] as const;

export interface AgentHostLaunchConfig {
  /** Executed directly with spawn({ shell: false }); it is never passed to a shell. */
  readonly command: string;
  readonly args: readonly string[];
  readonly capabilityGrants: readonly AgentCapability[];
  readonly workspace: WorkspaceGrant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly environmentAllowlist?: readonly string[];
  readonly helloTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
}

export interface AgentRequestOptions {
  readonly onEvent?: (event: EventEnvelope) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class AgentHostError extends Error {
  public constructor(
    public readonly code:
      | 'CANCELLED'
      | 'INVALID_CONFIGURATION'
      | 'MALFORMED_PROTOCOL'
      | 'PROCESS_FAILURE'
      | 'REQUEST_TIMEOUT'
      | 'UNAUTHORIZED_CAPABILITY'
      | 'UNSUPPORTED_CAPABILITY',
    message: string
  ) {
    super(message);
    this.name = 'AgentHostError';
  }
}

interface PendingRequest {
  readonly onEvent?: (event: EventEnvelope) => void;
  readonly reject: (reason: Error) => void;
  readonly resolve: (output: JsonObject | undefined) => void;
  cancellationTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

function isValidChildArgument(value: string): boolean {
  return value.length > 0 && !value.includes('\0');
}

export function validateAgentLaunchConfig(config: AgentHostLaunchConfig): void {
  if (!isValidChildArgument(config.command) || config.command.trim() !== config.command) {
    throw new AgentHostError(
      'INVALID_CONFIGURATION',
      'command must be a non-empty, unpadded string'
    );
  }
  if (!config.args.every(isValidChildArgument)) {
    throw new AgentHostError(
      'INVALID_CONFIGURATION',
      'each argv entry must be non-empty and contain no NUL'
    );
  }
  if (!isAbsolute(config.workspace.root)) {
    throw new AgentHostError('INVALID_CONFIGURATION', 'workspace.root must be an absolute path');
  }
  if (new Set(config.capabilityGrants).size !== config.capabilityGrants.length) {
    throw new AgentHostError('INVALID_CONFIGURATION', 'capability grants must be unique');
  }
}

/** Copies only explicit allowlisted values into the child environment. */
export function createSafeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[] = SAFE_ENVIRONMENT_ALLOWLIST
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Safe for diagnostics: likely credential values are never returned verbatim. */
export function redactEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    redacted[name] = /authorization|credential|key|password|secret|token/i.test(name)
      ? '[REDACTED]'
      : (value ?? '');
  }
  return redacted;
}

function messageId(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

function hostEnvelope<T extends AgentEnvelope>(envelope: T): T {
  return envelope;
}

export class ElectronAgentHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly session: AgentProtocolSession;
  private stdoutBuffer = '';
  private sequence = 0;
  private helloPromise: Promise<HelloEnvelope> | undefined;
  private resolveHello: ((hello: HelloEnvelope) => void) | undefined;
  private rejectHello: ((error: Error) => void) | undefined;
  private helloTimer?: ReturnType<typeof setTimeout>;

  public constructor(private readonly config: AgentHostLaunchConfig) {
    validateAgentLaunchConfig(config);
    this.session = new AgentProtocolSession(config.capabilityGrants);
  }

  public async start(): Promise<HelloEnvelope> {
    if (this.helloPromise !== undefined) return this.helloPromise;
    const environment = createSafeEnvironment(
      this.config.environment ?? process.env,
      this.config.environmentAllowlist ?? SAFE_ENVIRONMENT_ALLOWLIST
    );
    this.child = spawn(this.config.command, [...this.config.args], {
      cwd: this.config.workspace.root,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.on('error', (error) =>
      this.failAll(new AgentHostError('PROCESS_FAILURE', error.message))
    );
    this.child.on('exit', (code, signal) => {
      if (this.pending.size > 0 || this.helloPromise !== undefined) {
        this.failAll(
          new AgentHostError(
            'PROCESS_FAILURE',
            `Agent exited with code ${String(code)} and signal ${String(signal)}`
          )
        );
      }
    });
    this.helloPromise = new Promise<HelloEnvelope>((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    this.helloTimer = setTimeout(() => {
      this.failAll(
        new AgentHostError('REQUEST_TIMEOUT', 'Agent did not send hello before timeout')
      );
      this.child?.kill();
    }, this.config.helloTimeoutMs ?? 5_000);
    this.write(
      hostEnvelope({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        kind: 'hello',
        messageId: messageId('host', ++this.sequence),
        sentAt: new Date().toISOString(),
        implementation: 'selene-electron-host',
        capabilities: this.config.capabilityGrants
      })
    );
    return this.helloPromise;
  }

  public async request(
    capability: AgentCapability,
    input: JsonObject,
    options: AgentRequestOptions = {}
  ): Promise<JsonObject | undefined> {
    await this.start();
    if (!this.config.capabilityGrants.includes(capability)) {
      throw new AgentHostError(
        'UNAUTHORIZED_CAPABILITY',
        `Capability was not granted: ${capability}`
      );
    }
    if (!this.session.supports(capability)) {
      throw new AgentHostError('UNSUPPORTED_CAPABILITY', `Agent did not negotiate: ${capability}`);
    }
    if (options.signal?.aborted)
      throw new AgentHostError('CANCELLED', 'Request was already cancelled');

    const requestId = messageId('request', ++this.sequence);
    const envelope: RequestEnvelope = hostEnvelope({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      kind: 'request',
      messageId: messageId('host', ++this.sequence),
      sentAt: new Date().toISOString(),
      requestId,
      operation: capability,
      input
    });
    return new Promise<JsonObject | undefined>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent })
      };
      this.pending.set(requestId, pending);
      if (options.timeoutMs !== undefined) {
        pending.timeoutTimer = setTimeout(() => {
          this.cancel(requestId, 'REQUEST_TIMEOUT', 'Request exceeded its timeout');
        }, options.timeoutMs);
      }
      options.signal?.addEventListener(
        'abort',
        () => this.cancel(requestId, 'CANCELLED', 'Request cancelled by host'),
        { once: true }
      );
      this.write(envelope);
    });
  }

  public stop(): void {
    this.failAll(new AgentHostError('PROCESS_FAILURE', 'Agent host stopped'));
    this.child?.kill();
    this.child = undefined;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (
      Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_JSONL_LINE_BYTES &&
      !this.stdoutBuffer.includes('\n')
    ) {
      this.protocolFailure('Agent emitted an oversized JSONL frame');
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.receive(parseJsonlEnvelope(line));
        } catch (error) {
          this.protocolFailure(error instanceof Error ? error.message : 'Malformed agent JSONL');
          return;
        }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private receive(envelope: AgentEnvelope): void {
    if (envelope.kind === 'hello') {
      this.session.acceptHello(envelope);
      if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
      this.resolveHello?.(envelope);
      this.resolveHello = undefined;
      this.rejectHello = undefined;
      return;
    }
    if (envelope.kind === 'event') return this.receiveEvent(envelope);
    if (envelope.kind === 'error') return this.receiveError(envelope);
  }

  private receiveEvent(event: EventEnvelope): void {
    const pending = this.pending.get(event.requestId);
    if (pending === undefined) return;
    pending.onEvent?.(event);
    if (event.event === 'completed') {
      this.finish(event.requestId, () => pending.resolve(event.output));
    }
    if (event.event === 'cancelled') {
      this.finish(event.requestId, () =>
        pending.reject(new AgentHostError('CANCELLED', 'Agent acknowledged cancellation'))
      );
    }
  }

  private receiveError(error: ErrorEnvelope): void {
    if (error.requestId === undefined)
      return this.failAll(new AgentHostError('PROCESS_FAILURE', error.message));
    const pending = this.pending.get(error.requestId);
    if (pending !== undefined) {
      this.finish(error.requestId, () =>
        pending.reject(new AgentHostError('PROCESS_FAILURE', `${error.code}: ${error.message}`))
      );
    }
  }

  private cancel(requestId: string, code: 'CANCELLED' | 'REQUEST_TIMEOUT', reason: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    const envelope: CancelEnvelope = hostEnvelope({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      kind: 'cancel',
      messageId: messageId('host', ++this.sequence),
      sentAt: new Date().toISOString(),
      requestId
    });
    this.write(envelope);
    pending.cancellationTimer = setTimeout(() => {
      this.finish(requestId, () => pending.reject(new AgentHostError(code, reason)));
      this.child?.kill();
    }, this.config.cancellationTimeoutMs ?? 500);
  }

  private write(envelope: AgentEnvelope): void {
    if (this.child === undefined || !this.child.stdin.writable) {
      throw new AgentHostError('PROCESS_FAILURE', 'Agent process is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private finish(requestId: string, callback: () => void): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    if (pending.cancellationTimer !== undefined) clearTimeout(pending.cancellationTimer);
    if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer);
    this.pending.delete(requestId);
    callback();
  }

  private protocolFailure(message: string): void {
    this.failAll(new AgentHostError('MALFORMED_PROTOCOL', message));
    this.child?.kill();
  }

  private failAll(error: Error): void {
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
    this.rejectHello?.(error);
    this.resolveHello = undefined;
    this.rejectHello = undefined;
    for (const [requestId, pending] of this.pending) {
      this.finish(requestId, () => pending.reject(error));
    }
  }
}
