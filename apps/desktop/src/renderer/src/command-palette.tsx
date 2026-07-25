import { useId, useState, type KeyboardEvent } from 'react';

import { Popover } from '@selene/ui/workspace';
import { rankWorkspaceCommands, type WorkspaceCommand } from './cockpit/workspace-command-model';
import { nextCommandPaletteCommandId } from './command-palette-model';
import './command-palette.css';

interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: readonly WorkspaceCommand[];
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (commandId: string) => void;
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
  const listId = useId();
  const [active, setActive] = useState<string>();
  const visible = rankWorkspaceCommands(commands, query, 24);
  const activeId = visible.some(({ id }) => id === active)
    ? active
    : nextCommandPaletteCommandId(visible, undefined, 'first');

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      const command = visible.find(({ id }) => id === activeId);
      if (command !== undefined && !command.disabled) {
        event.preventDefault();
        onSelect(command.id);
      }
      return;
    }
    const direction =
      event.key === 'ArrowDown'
        ? 'next'
        : event.key === 'ArrowUp'
          ? 'previous'
          : event.key === 'Home'
            ? 'first'
            : event.key === 'End'
              ? 'last'
              : undefined;
    if (direction === undefined) return;
    event.preventDefault();
    setActive(nextCommandPaletteCommandId(visible, activeId, direction));
  };

  return (
    <Popover
      contentLabel="Command palette"
      onOpenChange={onOpenChange}
      open={open}
      triggerText="Commands ⌘K"
    >
      <section className="command-palette" onKeyDown={onKeyDown}>
        <label className="sl-field" htmlFor={`${listId}-search`}>
          <span className="sl-field__label">Search commands</span>
          <input
            autoFocus
            id={`${listId}-search`}
            className="sl-field__control"
            role="combobox"
            type="search"
            value={query}
            onChange={(event) => {
              setActive(undefined);
              onQueryChange(event.currentTarget.value);
            }}
            aria-controls={listId}
            aria-activedescendant={activeId === undefined ? undefined : `${listId}-${activeId}`}
            aria-expanded="true"
            autoComplete="off"
          />
        </label>
        {visible.length === 0 ? <p role="status">No matching commands.</p> : null}
        <ul id={listId} className="command-palette__list" role="listbox">
          {visible.map((command) => (
            <li
              key={command.id}
              id={`${listId}-${command.id}`}
              className="sl-list-row command-palette__option"
              role="option"
              aria-selected={command.id === activeId}
              aria-disabled={command.disabled === true}
              data-emphasized={command.id === activeId}
              onPointerEnter={() => (!command.disabled ? setActive(command.id) : undefined)}
              onClick={() => (!command.disabled ? onSelect(command.id) : undefined)}
            >
              <span>
                <strong>{command.label}</strong>
                <small>{command.detail}</small>
              </span>
              <small aria-hidden="true">{command.group}</small>
            </li>
          ))}
        </ul>
        <small className="command-palette__help">↑↓ Navigate · ↵ Run · Esc Close</small>
      </section>
    </Popover>
  );
}
