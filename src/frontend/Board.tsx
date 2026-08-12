import React from 'react';
import type { BoardData, ProjectItem } from './types';
import { columnsFrom, columnIdFor, fieldByName, STATUS_FIELD, NO_STATUS } from './types';
import { Column } from './Column';

interface Props {
  board: BoardData;
  items: ProjectItem[];
  collapsed: Set<string>;
  pending: Set<string>;
  onToggleColumn: (id: string) => void;
  onMove: (itemId: string, toColumnId: string) => void;
  onOpen: (item: ProjectItem) => void;
}

/** Below this, collapsed columns leave the grid rather than eating width as thin strips. */
const MOBILE_MAX = 640;

function useIsNarrow(): boolean {
  const q = `(max-width: ${MOBILE_MAX}px)`;
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(q).matches
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(q);
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

export const Board: React.FC<Props> = ({
  board,
  items,
  collapsed,
  pending,
  onToggleColumn,
  onMove,
  onOpen
}) => {
  const narrow = useIsNarrow();
  const statusField = fieldByName(board.fields, STATUS_FIELD);

  const columns = React.useMemo(() => columnsFrom(board.fields), [board.fields]);

  const byColumn = React.useMemo(() => {
    const map = new Map<string, ProjectItem[]>();
    for (const c of columns) map.set(c.id, []);
    for (const item of items) {
      const id = columnIdFor(item, statusField?.id ?? null);
      // An item whose Status option was deleted on github.com still carries the old
      // option id, which matches no column. It lands in No Status rather than being
      // dropped — a card that exists on the board but is invisible here is the one
      // outcome that would make this view untrustworthy.
      const bucket = map.get(id) ?? map.get(NO_STATUS);
      bucket?.push(item);
    }
    return map;
  }, [items, columns, statusField]);

  /**
   * "No Status" is hidden when it is empty *and* the project has a Status field.
   *
   * Most boards keep it empty, and a permanently empty first column is a column of
   * noise. It reappears the moment something lands in it, and it is always shown on a
   * project with no Status field at all — there, it is the only column there is.
   */
  const visible = columns.filter(
    (c) => c.id !== NO_STATUS || !statusField || (byColumn.get(NO_STATUS)?.length ?? 0) > 0
  );

  const inGrid = narrow ? visible.filter((c) => !collapsed.has(c.id)) : visible;
  const chips = narrow ? visible.filter((c) => collapsed.has(c.id)) : [];

  const gridTemplate = inGrid
    .map((c) => (collapsed.has(c.id) ? '44px' : 'minmax(220px, 1fr)'))
    .join(' ');

  return (
    <div className="cpb-board-wrap">
      {chips.length > 0 && (
        <div className="cpb-chips">
          {chips.map((c) => (
            <button key={c.id} className="cpb-chip" onClick={() => onToggleColumn(c.id)}>
              {c.name}
              <span className="cpb-chip-count">{byColumn.get(c.id)?.length ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cpb-board" style={{ gridTemplateColumns: gridTemplate }}>
        {inGrid.map((c) => (
          <Column
            key={c.id}
            column={c}
            items={byColumn.get(c.id) ?? []}
            fields={board.fields}
            collapsed={collapsed.has(c.id)}
            pending={pending}
            onToggle={() => onToggleColumn(c.id)}
            onMove={onMove}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
};
