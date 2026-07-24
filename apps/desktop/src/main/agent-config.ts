import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { AgentCapability, JsonObject } from '@selene/agent-sdk';

import { ElectronAgentHost, type AgentHostLaunchConfig } from './agent-host';
import type { DesignerAgentAdapter } from './designer-service';
import type { EnterpriseScenario, ReactSourceWorkspace } from '@selene/core';
import type { AIChangeRequest } from '../shared/designer-api';
import { type DesignerAgentSummary, validateDesignerIdentifier } from '../shared/designer-api';

export const TRUSTED_AGENT_CONFIG_VERSION = 'selene-desktop-agents/v1' as const;

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
  }[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`${name} must be an array of strings`);
  return value;
}

/** Parses only a trusted main-process configuration file; this is never renderer input. */
export function parseTrustedAgentConfiguration(value: unknown): TrustedAgentConfiguration {
  const config = record(value, 'agent configuration');
  if (config.version !== TRUSTED_AGENT_CONFIG_VERSION)
    throw new Error('Unsupported trusted agent configuration version');
  if (!Array.isArray(config.agents)) throw new Error('agent configuration requires agents');
  const ids = new Set<string>();
  const agents = config.agents.map((agentValue, index) => {
    const agent = record(agentValue, `agents.${index}`);
    const id = validateDesignerIdentifier(agent.id, `agents.${index}.id`);
    if (ids.has(id)) throw new Error(`Duplicate configured agent: ${id}`);
    ids.add(id);
    if (typeof agent.label !== 'string' || !agent.label.trim() || agent.label.length > 128)
      throw new Error(`agents.${index}.label must be a non-empty label`);
    if (
      typeof agent.command !== 'string' ||
      !isAbsolute(agent.command) ||
      agent.command.includes('\0')
    )
      throw new Error(`agents.${index}.command must be an absolute executable path`);
    const args = strings(agent.args, `agents.${index}.args`);
    if (args.some((item) => item.length === 0 || item.includes('\0')))
      throw new Error(`agents.${index}.args contains an invalid argv value`);
    if (typeof agent.workspaceRoot !== 'string' || !isAbsolute(agent.workspaceRoot))
      throw new Error(`agents.${index}.workspaceRoot must be absolute`);
    if (typeof agent.readOnly !== 'boolean')
      throw new Error(`agents.${index}.readOnly must be boolean`);
    const capabilityGrants = strings(agent.capabilityGrants, `agents.${index}.capabilityGrants`);
    if (capabilityGrants.length === 0 || new Set(capabilityGrants).size !== capabilityGrants.length)
      throw new Error(`agents.${index}.capabilityGrants must be unique and non-empty`);
    if (!capabilityGrants.every((capability) => /^[a-z][a-z0-9.-]{0,127}$/.test(capability)))
      throw new Error(`agents.${index}.capabilityGrants contains an invalid capability`);
    return {
      id,
      label: agent.label.trim(),
      command: agent.command,
      args,
      workspaceRoot: agent.workspaceRoot,
      readOnly: agent.readOnly,
      capabilityGrants: capabilityGrants as readonly AgentCapability[]
    };
  });
  return { version: TRUSTED_AGENT_CONFIG_VERSION, agents };
}

export async function loadTrustedAgentConfiguration(
  path: string
): Promise<TrustedAgentConfiguration> {
  if (!isAbsolute(path)) throw new Error('Trusted agent configuration path must be absolute');
  return parseTrustedAgentConfiguration(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function patchFromAgentOutput(value: JsonObject): {
  readonly operations: readonly {
    readonly type: 'write';
    readonly path: string;
    readonly content: string;
  }[];
  readonly summary: string;
} {
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0)
    throw new Error('Agent result requires a summary');
  if (!Array.isArray(value.operations) || value.operations.length === 0)
    throw new Error('Agent result requires source operations');
  const operations = value.operations.map((operation) => {
    const item = record(operation, 'agent operation');
    if (item.type !== 'write' || typeof item.path !== 'string' || typeof item.content !== 'string')
      throw new Error('Agent operation must be a source write');
    return { type: 'write' as const, path: item.path, content: item.content };
  });
  return { summary: value.summary, operations };
}

/** Uses the existing JSONL host, including negotiated capabilities, behind the same adapter port. */
export class ConfiguredProcessDesignerAdapter implements DesignerAgentAdapter {
  public readonly descriptor: DesignerAgentSummary;
  private readonly launch: AgentHostLaunchConfig;

  public constructor(private readonly config: TrustedAgentConfiguration['agents'][number]) {
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
    readonly target: AIChangeRequest['target'];
    readonly workspace: ReactSourceWorkspace;
    readonly scenario: EnterpriseScenario;
    readonly signal: AbortSignal;
    readonly progress: (message: string) => void;
  }) {
    const operation = this.config.capabilityGrants.includes('react.revise')
      ? 'react.revise'
      : this.config.capabilityGrants[0];
    if (operation === undefined) throw new Error('Configured agent has no granted capability');
    const host = new ElectronAgentHost(this.launch);
    try {
      const output = await host.request(
        operation,
        {
          instruction: input.instruction,
          revisionId: input.workspace.revision.id,
          scenarioId: input.scenario.id,
          target: JSON.parse(JSON.stringify(input.target)) as JsonObject
        },
        { signal: input.signal, onEvent: (event) => input.progress(event.event) }
      );
      if (output === undefined) throw new Error('Configured agent did not return a source patch');
      return patchFromAgentOutput(output);
    } finally {
      host.stop();
    }
  }
}
