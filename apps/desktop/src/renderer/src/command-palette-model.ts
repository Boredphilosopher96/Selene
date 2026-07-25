import type { WorkspaceCommand } from './cockpit/workspace-command-model';

type Direction = 'next' | 'previous' | 'first' | 'last';

export function nextCommandPaletteCommandId(
  commands: readonly WorkspaceCommand[],
  activeId: string | undefined,
  direction: Direction
): string | undefined {
  const enabled = commands.filter(({ disabled }) => !disabled);
  if (direction === 'first') return enabled[0]?.id;
  if (direction === 'last') return enabled.at(-1)?.id;
  const current = enabled.findIndex(({ id }) => id === activeId);
  const index = current < 0 ? (direction === 'next' ? 0 : enabled.length - 1) : current;
  const offset = direction === 'next' ? 1 : -1;
  return enabled[(index + offset + enabled.length) % enabled.length]?.id;
}
