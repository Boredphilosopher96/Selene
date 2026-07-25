export type WorkspaceCommandGroup =
  'navigate' | 'create' | 'prototype' | 'review' | 'publish' | 'workspace';

export interface WorkspaceCommand {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: WorkspaceCommandGroup;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** The cockpit injects capabilities; the command model owns no host authority. */
  readonly execute: () => void | Promise<void>;
}

const MAX_COMMANDS = 128;
const MAX_QUERY_LENGTH = 160;
const DEFAULT_RESULT_LIMIT = 12;
const MAX_RESULT_LIMIT = 24;

function searchable(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(command: WorkspaceCommand, query: string): number | undefined {
  const label = searchable(command.label);
  if (label === query) return 0;
  if (label.startsWith(query)) return 10;
  if (label.split(' ').some((token) => token.startsWith(query))) return 20;
  if (label.includes(query)) return 30;

  const detail = searchable(command.detail);
  if (detail.startsWith(query)) return 40;
  if (detail.includes(query)) return 50;

  if (command.shortcut) {
    const shortcut = searchable(command.shortcut);
    if (shortcut === query) return 55;
    if (shortcut.includes(query)) return 58;
  }

  for (const keyword of command.keywords?.slice(0, 24) ?? []) {
    const normalized = searchable(keyword);
    if (normalized === query) return 60;
    if (normalized.startsWith(query)) return 70;
    if (normalized.includes(query)) return 80;
  }
  return undefined;
}

/**
 * Deterministic, renderer-only command ranking. It never enumerates more than the
 * bounded cockpit registry and retains declaration order for equal matches.
 */
export function rankWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  input: string,
  limit = DEFAULT_RESULT_LIMIT
): readonly WorkspaceCommand[] {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_RESULT_LIMIT;
  const boundedLimit = Math.max(1, Math.min(MAX_RESULT_LIMIT, requestedLimit));
  const bounded = commands.slice(0, MAX_COMMANDS);
  const query = searchable(input.slice(0, MAX_QUERY_LENGTH));
  if (query.length === 0) return bounded.slice(0, boundedLimit);
  return bounded
    .map((command, index) => ({ command, index, score: score(command, query) }))
    .filter(
      (
        result
      ): result is {
        readonly command: WorkspaceCommand;
        readonly index: number;
        readonly score: number;
      } => result.score !== undefined
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, boundedLimit)
    .map(({ command }) => command);
}
