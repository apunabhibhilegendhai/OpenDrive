import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.js';

/**
 * A small keyboard-accessible menu, used for the account menu and per-file overflow actions.
 *
 * Every item carries the same capability rules as the visible controls: a menu is a second
 * route to an action, never a way around one.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Short reason shown under a disabled item, so "why can't I" is answerable. */
  disabledReason?: string;
  danger?: boolean;
}

export function Menu({
  label,
  icon = 'more',
  items,
  align = 'end',
  buttonClassName = 'btn btn--ghost btn--icon',
}: {
  label: string;
  icon?: IconName;
  items: MenuItem[];
  align?: 'start' | 'end';
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (buttonRef.current?.contains(event.target)) return;
      const menus = document.querySelectorAll('[data-menu-list]');
      for (const menu of menus) {
        if (menu.contains(event.target)) return;
      }
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = items.findIndex((item) => item.disabled !== true);
    if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
  }, [open, items]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = itemRefs.current.findIndex((element) => element === document.activeElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    let next = current;
    for (let step = 0; step < items.length; step += 1) {
      next = (next + delta + items.length) % items.length;
      if (items[next]?.disabled !== true) break;
    }
    itemRefs.current[next]?.focus();
  };

  return (
    <span className="menu">
      <button
        type="button"
        ref={buttonRef}
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div
          className={`menu__list menu__list--${align}`}
          role="menu"
          aria-label={label}
          data-menu-list=""
          onKeyDown={onListKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              className={`menu__item${item.danger === true ? ' menu__item--danger' : ''}`}
              disabled={item.disabled === true}
              title={item.disabledReason}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon !== undefined && <Icon name={item.icon} size={16} />}
              <span className="menu__label">{item.label}</span>
              {item.disabled === true && item.disabledReason !== undefined && (
                <span className="menu__reason">{item.disabledReason}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
