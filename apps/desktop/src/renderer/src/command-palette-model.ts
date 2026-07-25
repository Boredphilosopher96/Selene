import { rankWorkspaceCommands, type WorkspaceCommand } from './cockpit/workspace-command-model';

export type CommandPaletteCommand = WorkspaceCommand;

type CommandPaletteDirection = 'next' | 'previous' | 'first' | 'last';

export type CommandPaletteKeyboardAction =
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'activate'; readonly commandId: string }
  | { readonly kind: 'select'; readonly commandId: string }
  | undefined;

export function filterCommandPaletteCommands(
  commands: readonly CommandPaletteCommand[],
  query: string
): readonly CommandPaletteCommand[] {
  return rankWorkspaceCommands(commands, query, 24);
}

export function nextCommandPaletteCommandId(
  commands: readonly CommandPaletteCommand[],
  activeCommandId: string | undefined,
  direction: CommandPaletteDirection
): string | undefined {
  const selectable = commands.filter((command) => command.disabled !== true);
  if (selectable.length === 0) return undefined;
  if (direction === 'first') return selectable[0]?.id;
  if (direction === 'last') return selectable.at(-1)?.id;
  const currentIndex = selectable.findIndex((command) => command.id === activeCommandId);
  if (currentIndex === -1) return direction === 'next' ? selectable[0]?.id : selectable.at(-1)?.id;
  const offset = direction === 'next' ? 1 : -1;
  return selectable[(currentIndex + offset + selectable.length) % selectable.length]?.id;
}

export function commandPaletteKeyboardAction(
  key: string,
  commands: readonly CommandPaletteCommand[],
  activeCommandId: string | undefined
): CommandPaletteKeyboardAction {
  if (key === 'Escape') return { kind: 'dismiss' };
  const direction =
    key === 'ArrowDown'
      ? 'next'
      : key === 'ArrowUp'
        ? 'previous'
        : key === 'Home'
          ? 'first'
          : key === 'End'
            ? 'last'
            : undefined;
  if (direction !== undefined) {
    const commandId = nextCommandPaletteCommandId(commands, activeCommandId, direction);
    return commandId === undefined ? undefined : { kind: 'activate', commandId };
  }
  if (key !== 'Enter') return undefined;
  const active = commands.find((command) => command.id === activeCommandId);
  return active === undefined || active.disabled === true
    ? undefined
    : { kind: 'select', commandId: active.id };
}
