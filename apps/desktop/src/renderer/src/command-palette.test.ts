import { describe, expect, it, vi } from 'vitest';

import {
  commandPaletteKeyboardAction,
  filterCommandPaletteCommands,
  nextCommandPaletteCommandId,
  type CommandPaletteCommand
} from './command-palette-model';

const commands: readonly CommandPaletteCommand[] = [
  {
    id: 'render',
    label: 'Render preview',
    detail: 'Compile the current workspace.',
    group: 'workspace',
    execute: vi.fn()
  },
  {
    id: 'publish',
    label: 'Publish review',
    detail: 'Prepare a hosted review.',
    group: 'publish',
    shortcut: '⌘P',
    execute: vi.fn()
  },
  {
    id: 'recover',
    label: 'Recover workspace',
    detail: 'Restore the safe workspace.',
    group: 'workspace',
    disabled: true,
    execute: vi.fn()
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
