import { describe, expect, it } from 'vitest';

import {
  commandPaletteKeyboardAction,
  filterCommandPaletteCommands,
  nextCommandPaletteCommandId,
  type CommandPaletteCommand
} from './command-palette';

const commands: readonly CommandPaletteCommand[] = [
  { id: 'render', label: 'Render preview', description: 'Compile the current workspace.' },
  {
    id: 'publish',
    label: 'Publish review',
    description: 'Prepare a hosted review.',
    shortcut: '⌘P'
  },
  {
    id: 'recover',
    label: 'Recover workspace',
    description: 'Restore the safe workspace.',
    disabled: true
  }
];

describe('command palette navigation', () => {
  it('filters command labels, descriptions, and shortcuts', () => {
    expect(filterCommandPaletteCommands(commands, 'HOSTED')).toEqual([commands[1]]);
    expect(filterCommandPaletteCommands(commands, '⌘p')).toEqual([commands[1]]);
  });

  it('wraps navigation while skipping disabled commands', () => {
    expect(nextCommandPaletteCommandId(commands, 'publish', 'next')).toBe('render');
    expect(nextCommandPaletteCommandId(commands, 'render', 'previous')).toBe('publish');
  });

  it('resolves only safe keyboard actions for the active command', () => {
    expect(commandPaletteKeyboardAction('Escape', commands, 'render')).toEqual({ kind: 'dismiss' });
    expect(commandPaletteKeyboardAction('ArrowDown', commands, 'render')).toEqual({
      kind: 'activate',
      commandId: 'publish'
    });
    expect(commandPaletteKeyboardAction('Enter', commands, 'recover')).toBeUndefined();
    expect(commandPaletteKeyboardAction('Enter', commands, 'publish')).toEqual({
      kind: 'select',
      commandId: 'publish'
    });
  });
});
