import { Popover } from '@selene/ui/workspace';
import { rankWorkspaceCommands, type WorkspaceCommand } from './cockpit/workspace-command-model';

interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: readonly WorkspaceCommand[];
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (command: WorkspaceCommand) => void;
  readonly onOpenChange: (open: boolean) => void;
}

/** Keyboard-first renderer surface; hosts inject every command and effect. */
export function CommandPalette({
  commands,
  onOpenChange,
  onQueryChange,
  onSelect,
  open,
  query
}: CommandPaletteProps) {
  const visible = rankWorkspaceCommands(commands, query, 24);
  const first = visible.find(({ disabled }) => !disabled);
  return (
    <Popover
      contentLabel="Command palette"
      onOpenChange={onOpenChange}
      open={open}
      triggerText="Commands ⌘K"
    >
      <section className="sl-field">
        <label className="sl-field">
          <span className="sl-field__label">Search commands</span>
          <input
            autoFocus
            className="sl-field__control"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && first !== undefined) {
                event.preventDefault();
                onSelect(first);
              }
            }}
          />
        </label>
        {visible.length === 0 ? <p role="status">No matching commands.</p> : null}
        <div className="conversation-history" role="group" aria-label="Available commands">
          {visible.map((command) => (
            <button
              key={command.id}
              className="sl-list-row sl-popover__trigger"
              type="button"
              disabled={command.disabled}
              onClick={() => onSelect(command)}
            >
              {command.label} — {command.detail}
            </button>
          ))}
        </div>
        <small>Type to filter · Tab to navigate · Esc closes</small>
      </section>
    </Popover>
  );
}
