import { describe, expect, it } from 'vitest';

import type { WorkspaceCommand } from './cockpit/workspace-command-model';
import { nextCommandPaletteCommandId } from './command-palette-model';

const command = (id: string, disabled = false): WorkspaceCommand => ({
  id,
  label: id,
  detail: id,
  group: 'workspace',
  disabled,
  execute: () => undefined
});

describe('command palette navigation', () => {
  const commands = [command('render'), command('disabled', true), command('publish')];

  it('wraps and skips unavailable commands', () => {
    expect(nextCommandPaletteCommandId(commands, 'publish', 'next')).toBe('render');
    expect(nextCommandPaletteCommandId(commands, 'render', 'previous')).toBe('publish');
    expect(nextCommandPaletteCommandId(commands, undefined, 'first')).toBe('render');
    expect(nextCommandPaletteCommandId(commands, undefined, 'last')).toBe('publish');
  });
});
