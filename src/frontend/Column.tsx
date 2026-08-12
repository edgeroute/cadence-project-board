import React from 'react';
import type { ProjectItem, ProjectField, Column as ColumnDef } from './types';
import { Card } from './Card';

interface Props {
  column: ColumnDef;
  items: ProjectItem[];
  fields: ProjectField[];
  collapsed: boolean;
  pending: Set<string>;
  onToggle: () => void;
  onMove: (itemId: string, toColumnId: string) => void;
  onOpen: (item: ProjectItem) => void;
}

export const Column: React.FC<Props> = ({
  column,
  items,
  fields,
  collapsed,
  pending,
  onToggle,
  onMove,
  onOpen
}) => {
  const [dragOver, setDragOver] = React.useState(false);
  /**
   * Depth counter, not a boolean.
   *
   * `dragenter`/`dragleave` fire for every descendant the pointer crosses, so moving
   * over a card inside the column fires `leave` on the column and `enter` on the card
   * in that order. A boolean flickers off on every card boundary; counting depth and
   * only clearing at zero is the standard fix.
   */
  const depth = React.useRef(0);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    depth.current++;
    setDragOver(true);
  };

  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragOver(false);
  };

  const onDragOver = (e: React.DragEvent) => {
    // Without preventDefault on dragover the element is not a valid drop target and
    // `drop` never fires — the single most common reason HTML5 drag "doesn't work".
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragOver(false);
    try {
      const payload = JSON.parse(e.dataTransfer.getData('text/plain')) as {
        itemId?: string;
        fromColumnId?: string;
      };
      // A drop back into the origin column is a no-op rather than a write. It is the
      // commonest way a drag ends — the reader changed their mind — and issuing the
      // mutation anyway would spend a request to set the value it already has.
      if (payload.itemId && payload.fromColumnId !== column.id) {
        onMove(payload.itemId, column.id);
      }
    } catch {
      /* a drop from outside the board: nothing to do */
    }
  };

  return (
    <section
      className={`cpb-column${dragOver ? ' cpb-column--over' : ''}${collapsed ? ' cpb-column--collapsed' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      aria-label={`${column.name}, ${items.length} items`}
    >
      <button
        className="cpb-column-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${column.name}` : `Collapse ${column.name}`}
      >
        <span className="cpb-column-name">{collapsed ? '' : column.name}</span>
        <span className="cpb-column-count">{items.length}</span>
        <span className="cpb-column-chev">{collapsed ? '▸' : '▾'}</span>
      </button>

      {collapsed ? (
        <button className="cpb-column-collapsed" onClick={onToggle}>
          <span className="cpb-column-collapsed-label">{column.name}</span>
        </button>
      ) : (
        <div className="cpb-column-body">
          {items.length === 0 ? (
            <div className={`cpb-column-empty${dragOver ? ' cpb-column-empty--over' : ''}`}>
              {dragOver ? '↓ Drop here' : 'Nothing here'}
            </div>
          ) : (
            items.map((item) => (
              <Card
                key={item.id}
                item={item}
                columnId={column.id}
                fields={fields}
                busy={pending.has(item.id)}
                onOpen={() => onOpen(item)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
};
