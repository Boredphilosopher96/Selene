import { describe, expect, it, vi } from 'vitest';

import { rankWorkspaceCommands, type WorkspaceCommand } from './workspace-command-model';

function command(
  id: string,
  label: string,
  detail: string,
  keywords: readonly string[] = []
): WorkspaceCommand {
  return {
    id,
    label,
    detail,
    group: 'workspace',
    keywords,
    execute: vi.fn()
  };
}

describe('rankWorkspaceCommands', () => {
  it('ranks exact, prefix, token, detail, and keyword matches deterministically', () => {
    const commands = [
      command('review', 'Open review panel', 'Discuss stakeholder feedback'),
      command('prototype', 'Prototype mode', 'Run the connected design flow'),
      command('publish', 'Publish project', 'Create a developer handoff', ['ship'])
    ];

    expect(rankWorkspaceCommands(commands, 'prototype').map(({ id }) => id)).toEqual(['prototype']);
    expect(rankWorkspaceCommands(commands, 'review').map(({ id }) => id)).toEqual(['review']);
    expect(rankWorkspaceCommands(commands, 'connected').map(({ id }) => id)).toEqual(['prototype']);
    expect(rankWorkspaceCommands(commands, 'ship').map(({ id }) => id)).toEqual(['publish']);
  });

  it('normalizes designer input while retaining declaration order for equal matches', () => {
    const commands = [
      command('scenario-one', 'Résumé scenario', 'First'),
      command('scenario-two', 'Resume scenario', 'Second')
    ];

    expect(rankWorkspaceCommands(commands, '  RÉSUMÉ  ').map(({ id }) => id)).toEqual([
      'scenario-one',
      'scenario-two'
    ]);
  });

  it('bounds both the scanned registry and returned result count', () => {
    const commands = Array.from({ length: 160 }, (_, index) =>
      command(`command-${index}`, `Command ${index}`, 'Bounded command')
    );

    expect(rankWorkspaceCommands(commands, '', 200)).toHaveLength(24);
    expect(rankWorkspaceCommands(commands, 'command 129', 24)).toEqual([]);
  });
});
