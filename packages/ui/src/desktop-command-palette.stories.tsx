import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { CommandPalette } from '../../../apps/desktop/src/renderer/src/command-palette';
import type { WorkspaceCommand } from '../../../apps/desktop/src/renderer/src/cockpit/workspace-command-model';
import './designer-workspace.css';

const commands: readonly WorkspaceCommand[] = [
  {
    id: 'render-preview',
    label: 'Render current revision',
    detail: 'Compile and refresh the secure React preview.',
    group: 'workspace',
    keywords: ['refresh', 'compile', 'canvas'],
    execute: () => undefined
  },
  {
    id: 'ready-review',
    label: 'Mark ready for review',
    detail: 'Create the design baseline stakeholders will review.',
    group: 'review',
    keywords: ['baseline', 'stakeholder'],
    execute: () => undefined
  },
  {
    id: 'resume-previews',
    label: 'Resume previews',
    detail: 'Leave crash-recovery mode and enable preview execution.',
    group: 'workspace',
    keywords: ['recover', 'safe mode'],
    disabled: true,
    execute: () => undefined
  }
];

function CommandPaletteStory({ noMatches = false }: { readonly noMatches?: boolean }) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState(noMatches ? 'unavailable command' : '');
  const [activeCommandId, setActiveCommandId] = useState<string>();
  const [status, setStatus] = useState('No command executed.');
  return (
    <main className="designer-workspace" aria-label="Command palette fixture">
      <header className="workspace-topbar">
        <div>
          <span className="brand-mark">S</span>
          <span className="project-kicker">Desktop production designer</span>
        </div>
        <div className="project-actions">
          <button type="button" onClick={() => setOpen(true)}>
            Commands <kbd>⌘K</kbd>
          </button>
        </div>
      </header>
      <p className="workspace-notice" role="status">
        {status}
      </p>
      <CommandPalette
        open={open}
        query={query}
        commands={commands}
        {...(activeCommandId === undefined ? {} : { activeCommandId })}
        onQueryChange={(next) => {
          setQuery(next);
          setActiveCommandId(undefined);
        }}
        onActiveCommandIdChange={setActiveCommandId}
        onSelect={(commandId) => {
          setStatus(`Executed ${commandId}.`);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
      />
    </main>
  );
}

const meta = {
  title: 'Desktop/Command Palette',
  component: CommandPaletteStory,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof CommandPaletteStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NoMatches: Story = { args: { noMatches: true } };
