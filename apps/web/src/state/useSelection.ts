import { useCallback, useRef, useState } from 'react';

/**
 * Multi-select over the rows currently on screen.
 *
 * Shift extends from the last row that was clicked, Ctrl/Cmd toggles one row. Selection is by
 * id, so it survives a re-sort, and it is cleared whenever the visible set changes owner or
 * folder — a stale id must never act on something that is no longer shown.
 */
export function useSelection(orderedIds: string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set());
  }, []);

  const select = useCallback(
    (id: string, modifiers: { shift?: boolean; toggle?: boolean }) => {
      setSelected((current) => {
        const next = new Set(current);
        if (modifiers.shift === true && anchorRef.current !== null) {
          const from = orderedIds.indexOf(anchorRef.current);
          const to = orderedIds.indexOf(id);
          if (from !== -1 && to !== -1) {
            const [start, end] = from <= to ? [from, to] : [to, from];
            for (let index = start; index <= end; index += 1) {
              const candidate = orderedIds[index];
              if (candidate !== undefined) next.add(candidate);
            }
            return next;
          }
        }
        if (modifiers.toggle === true) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
          anchorRef.current = id;
          return next;
        }
        next.clear();
        next.add(id);
        anchorRef.current = id;
        return next;
      });
    },
    [orderedIds],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(orderedIds));
  }, [orderedIds]);

  const remove = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  return {
    selected,
    count: selected.size,
    isSelected,
    select,
    selectAll,
    remove,
    clear,
    /** Ids in the order they appear on screen, so bulk work follows what the user sees. */
    ordered: orderedIds.filter((id) => selected.has(id)),
  };
}
