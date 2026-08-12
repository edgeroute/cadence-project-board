import React from 'react';
import type { ProjectItem, ProjectField } from './types';
import { itemTitle, PRIORITY_FIELD, SIZE_FIELD, fieldByName } from './types';

interface Props {
  item: ProjectItem;
  columnId: string;
  fields: ProjectField[];
  /** True while this card's own write is in flight — see App's `pending` set. */
  busy: boolean;
  onOpen: () => void;
}

/** Priority colours. Only these three names are tinted; anything else falls back to neutral. */
const PRIORITY_TINT: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f59e0b',
  P2: '#6b7280'
};

function optionName(item: ProjectItem, fields: ProjectField[], fieldName: string): string | null {
  const field = fieldByName(fields, fieldName);
  if (!field) return null;
  const optionId = item.singleSelect[field.id];
  if (!optionId) return null;
  return field.options.find((o) => o.id === optionId)?.name ?? null;
}

function labelTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000';
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 140 ? '#000' : '#fff';
}

export const Card: React.FC<Props> = ({ item, columnId, fields, busy, onOpen }) => {
  const [dragging, setDragging] = React.useState(false);
  const content = item.content;
  const priority = optionName(item, fields, PRIORITY_FIELD);
  const size = optionName(item, fields, SIZE_FIELD);

  const handleDragStart = (e: React.DragEvent) => {
    // `text/plain` rather than a custom MIME type: Safari and older WebKit silently
    // drop unknown types on dragstart, and the drop handler then reads an empty
    // string. The payload carries the source column so a drop back into the same
    // column can be ignored without a round trip.
    e.dataTransfer.setData('text/plain', JSON.stringify({ itemId: item.id, fromColumnId: columnId }));
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  };

  return (
    <div
      className={`cpb-card${dragging ? ' cpb-card--dragging' : ''}${busy ? ' cpb-card--busy' : ''}`}
      // Not draggable while a write is in flight. Two overlapping mutations on one item
      // race, and the loser silently wins on GitHub — the board would settle on whichever
      // request the server finished last, not on the reader's last gesture.
      draggable={!busy}
      onDragStart={handleDragStart}
      onDragEnd={() => setDragging(false)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${content ? `#${content.number} ` : ''}${itemTitle(item)}${priority ? `, ${priority}` : ''}${size ? `, size ${size}` : ''}`}
    >
      <div className="cpb-card-top">
        {content ? <span className="cpb-card-number">#{content.number}</span> : <span className="cpb-card-draft">DRAFT</span>}
        {priority && (
          <span
            className="cpb-card-priority"
            style={{ color: PRIORITY_TINT[priority] ?? 'var(--cpb-dim)', borderColor: (PRIORITY_TINT[priority] ?? '#8884') + '66' }}
          >
            {priority}
          </span>
        )}
        {size && <span className="cpb-card-size">{size}</span>}
        {busy && <span className="cpb-card-spinner" aria-label="Saving" />}
      </div>

      <div className="cpb-card-title">{itemTitle(item)}</div>

      {content && (content.labels.length > 0 || content.assignees.length > 0) && (
        <div className="cpb-card-bottom">
          <div className="cpb-card-labels">
            {content.labels.slice(0, 3).map((l) => (
              <span
                key={l.name}
                className="cpb-card-label"
                style={{ background: `#${l.color}`, color: labelTextColor(l.color) }}
              >
                {l.name}
              </span>
            ))}
          </div>
          <div className="cpb-card-avatars">
            {content.assignees.slice(0, 3).map((a) => (
              <img key={a.login} className="cpb-card-avatar" src={a.avatarUrl} alt={a.login} title={a.login} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
