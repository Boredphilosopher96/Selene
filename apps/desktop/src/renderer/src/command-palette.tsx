import { useId, useMemo, useRef, type ChangeEvent, type KeyboardEvent } from 'react';

import { Dialog } from '@selene/ui/workspace';
import { rankWorkspaceCommands, type WorkspaceCommand } from './cockpit/workspace-command-model';
import './command-palette.css';

export type CommandPaletteCommand = WorkspaceCommand;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly query: string;
  readonly commands: readonly CommandPaletteCommand[];
  readonly activeCommandId?: string;
  readonly onQueryChange: (query: string) => void;
  readonly onActiveCommandIdChange: (commandId: string) => void;
  readonly onSelect: (commandId: string) => void;
  readonly onDismiss: () => void;
}

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

/** Controlled, renderer-only command palette. The host supplies every command and effect. */
export function CommandPalette({
  activeCommandId,
  commands,
  onActiveCommandIdChange,
  onDismiss,
  onQueryChange,
  onSelect,
  open,
  query
}: CommandPaletteProps) {
  const search = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const visibleCommands = useMemo(
    () => filterCommandPaletteCommands(commands, query),
    [commands, query]
  );
  const activeId =
    activeCommandId !== undefined &&
    visibleCommands.some((command) => command.id === activeCommandId)
      ? activeCommandId
      : nextCommandPaletteCommandId(visibleCommands, undefined, 'first');

  const runAction = (action: CommandPaletteKeyboardAction): void => {
    if (action === undefined) return;
    if (action.kind === 'dismiss') {
      onDismiss();
      return;
    }
    if (action.kind === 'activate') {
      onActiveCommandIdChange(action.commandId);
      return;
    }
    onSelect(action.commandId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const action = commandPaletteKeyboardAction(event.key, visibleCommands, activeId);
    if (action === undefined) return;
    event.preventDefault();
    runAction(action);
  };
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onQueryChange(event.currentTarget.value);
  };

  return (
    <Dialog
      closeLabel="Close command palette"
      initialFocusRef={search}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      open={open}
      title="Command palette"
    >
      <section className="command-palette" onKeyDown={onKeyDown}>
        <p className="command-palette__eyebrow">Workspace commands</p>
        <label className="command-palette__search-label" htmlFor={`${listboxId}-search`}>
          Search commands
        </label>
        <input
          ref={search}
          id={`${listboxId}-search`}
          className="command-palette__search"
          role="combobox"
          type="search"
          value={query}
          onChange={onChange}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={activeId === undefined ? undefined : `${listboxId}-${activeId}`}
          aria-expanded="true"
          autoComplete="off"
          spellCheck={false}
        />
        {visibleCommands.length === 0 ? (
          <p className="command-palette__empty" role="status">
            No commands match this search.
          </p>
        ) : null}
        <ul id={listboxId} className="command-palette__list" role="listbox">
          {visibleCommands.map((command) => {
            const selected = command.id === activeId;
            return (
              <li
                key={command.id}
                id={`${listboxId}-${command.id}`}
                className="command-palette__option"
                role="option"
                aria-selected={selected}
                aria-disabled={command.disabled === true}
                tabIndex={-1}
                onPointerEnter={() => {
                  if (command.disabled !== true) onActiveCommandIdChange(command.id);
                }}
                onClick={() => {
                  if (command.disabled !== true) onSelect(command.id);
                }}
              >
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </span>
                <span className="command-palette__metadata" aria-hidden="true">
                  <small className="command-palette__group">{command.group}</small>
                  {command.shortcut === undefined ? null : <kbd>{command.shortcut}</kbd>}
                </span>
              </li>
            );
          })}
        </ul>
        <footer className="command-palette__help" aria-label="Command palette keyboard help">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Run
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </section>
    </Dialog>
  );
}
