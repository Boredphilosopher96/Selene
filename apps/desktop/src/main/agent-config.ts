import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { AgentCapability, JsonObject } from '@selene/agent-sdk';
import {
  applyAgentSourcePatch,
  normalizeSourcePath,
  validateReactSourceWorkspace,
  type AgentFileOperation,
  type AgentSourcePatch,
  type EnterpriseScenario,
  type ReactSourceWorkspace
} from '@selene/core';

import { ElectronAgentHost, type AgentHostLaunchConfig } from './agent-host';
import type { CrashDiagnosticSink } from './crash-diagnostics';
import type { DesignerAgentAdapter, DesignerGenerationContext } from './designer-service';
import type { AuthenticatedArtifactElementTarget } from '../shared/designer-api';
import { type DesignerAgentSummary, validateDesignerIdentifier } from '../shared/designer-api';

export const TRUSTED_AGENT_CONFIG_VERSION = 'selene-desktop-agents/v1' as const;
export const MAX_TRUSTED_AGENT_CONFIG_BYTES = 64 * 1024;
export const MAX_TRUSTED_AGENTS = 16;
export const MAX_AGENT_ARGS = 32;
export const MAX_AGENT_ARG_BYTES = 4 * 1024;
export const MAX_AGENT_REQUEST_BYTES = 512 * 1024;
export const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_AGENT_REQUEST_TIMEOUT_MS = 60_000;

export interface TrustedAgentConfiguration {
  readonly version: typeof TRUSTED_AGENT_CONFIG_VERSION;
  readonly agents: readonly {
    readonly id: string;
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly workspaceRoot: string;
    readonly readOnly: boolean;
    readonly capabilityGrants: readonly AgentCapability[];
    readonly designOperation: AgentCapability;
    readonly requestTimeoutMs: number;
  }[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  )
    throw new Error(`${name} must be a non-empty string up to ${maximum} characters`);
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0'))
    throw new Error(`${name} must be a string up to ${maximum} characters`);
  return value;
}

function strings(
  value: unknown,
  name: string,
  maximum: number,
  itemMaximum: number
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${name} must contain at most ${maximum} strings`);
  return value.map((item, index) => boundedString(item, `${name}.${index}`, itemMaximum));
}

function capability(value: unknown, name: string): AgentCapability {
  const candidate = boundedString(value, name, 128);
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(candidate)) throw new Error(`${name} is invalid`);
  return candidate;
}

function boundedPositiveInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}

/** Parses only a bounded, trusted main-process configuration file; never renderer input. */
export function parseTrustedAgentConfiguration(value: unknown): TrustedAgentConfiguration {
  const config = record(value, 'agent configuration');
  if (config.version !== TRUSTED_AGENT_CONFIG_VERSION)
    throw new Error('Unsupported trusted agent configuration version');
  if (!Array.isArray(config.agents) || config.agents.length > MAX_TRUSTED_AGENTS)
    throw new Error(`agent configuration requires at most ${MAX_TRUSTED_AGENTS} agents`);
  const ids = new Set<string>();
  const agents = config.agents.map((agentValue, index) => {
    const agent = record(agentValue, `agents.${index}`);
    const id = validateDesignerIdentifier(agent.id, `agents.${index}.id`);
    if (ids.has(id)) throw new Error(`Duplicate configured agent: ${id}`);
    ids.add(id);
    const label = boundedString(agent.label, `agents.${index}.label`, 128).trim();
    if (!label) throw new Error(`agents.${index}.label must not be blank`);
    const command = boundedString(agent.command, `agents.${index}.command`, 4 * 1024);
    if (!isAbsolute(command))
      throw new Error(`agents.${index}.command must be an absolute executable path`);
    const args = strings(agent.args, `agents.${index}.args`, MAX_AGENT_ARGS, MAX_AGENT_ARG_BYTES);
    const workspaceRoot = boundedString(
      agent.workspaceRoot,
      `agents.${index}.workspaceRoot`,
      4 * 1024
    );
    if (!isAbsolute(workspaceRoot))
      throw new Error(`agents.${index}.workspaceRoot must be absolute`);
    if (typeof agent.readOnly !== 'boolean')
      throw new Error(`agents.${index}.readOnly must be boolean`);
    const capabilityGrants = strings(
      agent.capabilityGrants,
      `agents.${index}.capabilityGrants`,
      16,
      128
    ).map((grant, capabilityIndex) =>
      capability(grant, `agents.${index}.capabilityGrants.${capabilityIndex}`)
    );
    if (capabilityGrants.length === 0 || new Set(capabilityGrants).size !== capabilityGrants.length)
      throw new Error(`agents.${index}.capabilityGrants must be unique and non-empty`);
    const designOperation =
      agent.designOperation === undefined
        ? ('react.revise' as AgentCapability)
        : capability(agent.designOperation, `agents.${index}.designOperation`);
    if (!capabilityGrants.includes(designOperation))
      throw new Error(`agents.${index}.designOperation must be present in capabilityGrants`);
    const requestTimeoutMs =
      agent.requestTimeoutMs === undefined
        ? DEFAULT_AGENT_REQUEST_TIMEOUT_MS
        : boundedPositiveInteger(
            agent.requestTimeoutMs,
            `agents.${index}.requestTimeoutMs`,
            1_000,
            MAX_AGENT_REQUEST_TIMEOUT_MS
          );
    return {
      id,
      label,
      command,
      args,
      workspaceRoot,
      readOnly: agent.readOnly,
      capabilityGrants,
      designOperation,
      requestTimeoutMs
    };
  });
  return { version: TRUSTED_AGENT_CONFIG_VERSION, agents };
}

export async function loadTrustedAgentConfiguration(
  path: string
): Promise<TrustedAgentConfiguration> {
  if (!isAbsolute(path)) throw new Error('Trusted agent configuration path must be absolute');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_TRUSTED_AGENT_CONFIG_BYTES)
    throw new Error(`Trusted agent configuration exceeds ${MAX_TRUSTED_AGENT_CONFIG_BYTES} bytes`);
  const source = await readFile(path, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > MAX_TRUSTED_AGENT_CONFIG_BYTES)
    throw new Error(`Trusted agent configuration exceeds ${MAX_TRUSTED_AGENT_CONFIG_BYTES} bytes`);
  return parseTrustedAgentConfiguration(JSON.parse(source) as unknown);
}

function optionalDependencies(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const dependencies = strings(value, 'agent dependencies', 16, 128);
  if (new Set(dependencies).size !== dependencies.length)
    throw new Error('agent dependencies must not contain duplicates');
  return dependencies;
}

function optionalNodeIdMapping(
  value: unknown,
  workspace: ReactSourceWorkspace
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const mapping = record(value, 'agent nodeIdMapping');
  const entries = Object.entries(mapping);
  if (entries.length > 1_024) throw new Error('agent nodeIdMapping exceeds 1024 entries');
  const currentIds = new Set(workspace.nodes.map((node) => node.nodeId));
  const validated: Record<string, string> = {};
  for (const [from, to] of entries) {
    const source = validateDesignerIdentifier(from, 'agent nodeIdMapping key');
    if (!currentIds.has(source))
      throw new Error(`agent nodeIdMapping has unknown source ID: ${source}`);
    validated[source] = validateDesignerIdentifier(to, 'agent nodeIdMapping value');
  }
  return validated;
}

/** Validates the entire returned patch before the service can mutate its workspace. */
export function parseAgentSourcePatch(
  value: JsonObject,
  workspace: ReactSourceWorkspace
): AgentSourcePatch {
  validateReactSourceWorkspace(workspace);
  const result = record(value, 'agent result');
  const summary = boundedString(result.summary, 'agent result summary', 4_000).trim();
  if (!summary) throw new Error('agent result summary must not be blank');
  if (
    !Array.isArray(result.operations) ||
    result.operations.length === 0 ||
    result.operations.length > 128
  )
    throw new Error('agent result requires 1 to 128 source operations');
  const existingPaths = new Set(workspace.files.map((file) => file.path));
  const operationPaths = new Set<string>();
  const operations: AgentFileOperation[] = result.operations.map((operation, index) => {
    const item = record(operation, `agent operation ${index}`);
    const path = normalizeSourcePath(
      boundedString(item.path, `agent operation ${index}.path`, 512)
    );
    if (operationPaths.has(path)) throw new Error(`agent operations duplicate path: ${path}`);
    operationPaths.add(path);
    if (item.type === 'write') {
      return {
        type: 'write',
        path,
        content: boundedText(item.content, `agent operation ${index}.content`, 1_000_000)
      };
    }
    if (item.type === 'delete') {
      if (!existingPaths.has(path))
        throw new Error(`agent delete references unknown path: ${path}`);
      return { type: 'delete', path };
    }
    throw new Error(`agent operation ${index}.type must be write or delete`);
  });
  const dependencies = optionalDependencies(result.dependencies);
  const nodeIdMapping = optionalNodeIdMapping(result.nodeIdMapping, workspace);
  const patch: AgentSourcePatch = {
    summary,
    operations,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(nodeIdMapping === undefined ? {} : { nodeIdMapping })
  };
  const candidate = applyAgentSourcePatch(workspace, patch, {
    id: 'agent-proposal-validation',
    createdAt: '1970-01-01T00:00:00.000Z'
  });
  if (nodeIdMapping !== undefined) {
    const nextIds = new Set(candidate.nodes.map((node) => node.nodeId));
    for (const target of Object.values(nodeIdMapping)) {
      if (!nextIds.has(target))
        throw new Error(`agent nodeIdMapping target does not exist: ${target}`);
    }
  }
  return patch;
}

function boundedJsonObject(value: unknown, name: string, maximumBytes: number): JsonObject {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes)
    throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  return record(JSON.parse(serialized) as unknown, name) as JsonObject;
}

/** Uses the JSONL host behind an explicit, trusted and bounded designer operation. */
export class ConfiguredProcessDesignerAdapter implements DesignerAgentAdapter {
  public readonly descriptor: DesignerAgentSummary;
  private readonly launch: AgentHostLaunchConfig;

  public constructor(
    private readonly config: TrustedAgentConfiguration['agents'][number],
    private readonly diagnostics?: CrashDiagnosticSink
  ) {
    this.descriptor = {
      id: config.id,
      label: config.label,
      capabilities: [...config.capabilityGrants]
    };
    this.launch = {
      command: config.command,
      args: config.args,
      capabilityGrants: config.capabilityGrants,
      workspace: { root: config.workspaceRoot, readOnly: config.readOnly }
    };
  }

  public async propose(input: {
    readonly instruction: string;
    readonly target: AuthenticatedArtifactElementTarget | undefined;
    readonly workspace: ReactSourceWorkspace;
    readonly scenario: EnterpriseScenario;
    readonly generationContext?: DesignerGenerationContext;
    readonly signal: AbortSignal;
    readonly progress: (message: string) => void;
  }): Promise<AgentSourcePatch> {
    validateReactSourceWorkspace(input.workspace);
    const host = new ElectronAgentHost(this.launch);
    try {
      const output = await host.request(
        this.config.designOperation,
        boundedJsonObject(
          {
            instruction: input.instruction,
            target: input.target,
            workspace: input.workspace,
            scenario: input.scenario,
            ...(input.generationContext === undefined
              ? {}
              : { generationContext: input.generationContext })
          },
          'configured agent request',
          MAX_AGENT_REQUEST_BYTES
        ),
        {
          signal: input.signal,
          timeoutMs: this.config.requestTimeoutMs,
          onEvent: (event) => input.progress(event.event)
        }
      );
      if (output === undefined) throw new Error('Configured agent did not return a source patch');
      return parseAgentSourcePatch(output, input.workspace);
    } catch (error) {
      try {
        await this.diagnostics?.capture('agent', 'adapter-failure', error);
      } catch {
        // Diagnostics are non-authoritative and must not affect agent failure semantics.
      }
      throw error;
    } finally {
      host.stop();
    }
  }
}
