import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * Command palette (Ctrl/Cmd + K).
 *
 * The command list is assembled by the app from what is actually available: navigation that
 * exists, and actions whose prerequisites are met. A command for a capability the API does not
 * support is never registered, so the palette cannot promise something the product cannot do.
 */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  keywords?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const restoreFocus = useRef<Element | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
      return;
    }
    restoreFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const target = restoreFocus.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const activeCommand = matches[active];

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              activeCommand === undefined ? undefined : `${listId}-${activeCommand.id}`
            }
            aria-label="Search commands"
            placeholder="Type a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => (matches.length === 0 ? 0 : (value + 1) % matches.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) =>
                  matches.length === 0 ? 0 : (value - 1 + matches.length) % matches.length,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (activeCommand !== undefined) {
                  onClose();
                  activeCommand.run();
                }
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette__list" id={listId} role="listbox" aria-label="Commands">
          {matches.length === 0 && <li className="palette__empty">No command matches that.</li>}
          {matches.map((command, index) => (
            <li key={command.id} role="presentation">
              <button
                type="button"
                id={`${listId}-${command.id}`}
                role="option"
                aria-selected={index === active}
                className={`palette__item${index === active ? ' palette__item--active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onClose();
                  command.run();
                }}
              >
                {command.icon !== undefined && <Icon name={command.icon} size={16} />}
                <span className="palette__label">{command.label}</span>
                {command.hint !== undefined && (
                  <span className="palette__hint">{command.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
