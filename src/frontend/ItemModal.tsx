import React from 'react';
import type { ProjectItem, ProjectField } from './types';
import { itemTitle, fieldByName, STATUS_FIELD, PRIORITY_FIELD, SIZE_FIELD } from './types';
import { Comments } from './Comments';
import { RichText } from './RichText';

interface Props {
  item: ProjectItem;
  fields: ProjectField[];
  busy: boolean;
  error: string;
  /** Needed by every RPC; the modal has no context of its own. */
  projectPath: string | null;
  onSetField: (fieldName: string, optionName: string | null) => void;
  onClose: () => void;
}

/**
 * One single-select field as a row of options.
 *
 * Buttons rather than a `<select>`: there are three to five options, they are the
 * thing the reader came here to change, and a native select on this host's dark theme
 * is the one control that never matches the surrounding UI. "Clear" is offered
 * explicitly — every one of these fields is legitimately empty on most items, and a
 * picker with no way back to empty makes setting one by accident permanent.
 */
const FieldRow: React.FC<{
  field: ProjectField;
  currentId: string | undefined;
  disabled: boolean;
  onPick: (optionName: string | null) => void;
}> = ({ field, currentId, disabled, onPick }) => (
  <div className="cpb-field">
    <div className="cpb-field-name">{field.name}</div>
    <div className="cpb-field-options">
      {field.options.map((o) => (
        <button
          key={o.id}
          className={`cpb-opt${o.id === currentId ? ' cpb-opt--on' : ''}`}
          disabled={disabled}
          aria-pressed={o.id === currentId}
          onClick={() => onPick(o.id === currentId ? null : o.name)}
        >
          {o.name}
        </button>
      ))}
      {currentId && (
        <button className="cpb-opt cpb-opt--clear" disabled={disabled} onClick={() => onPick(null)}>
          Clear
        </button>
      )}
    </div>
  </div>
);

export const ItemModal: React.FC<Props> = ({ item, fields, busy, error, projectPath, onSetField, onClose }) => {
  const content = item.content;

  // Escape closes, and the listener is on document because focus may be on any of the
  // option buttons inside. Re-registered per render of this component only, so it
  // cannot outlive the modal and swallow Escape for the host.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = [STATUS_FIELD, PRIORITY_FIELD, SIZE_FIELD]
    .map((name) => fieldByName(fields, name))
    .filter((f): f is ProjectField => f !== null);

  return (
    <div className="cpb-overlay" onClick={onClose} role="presentation">
      <div
        className="cpb-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={itemTitle(item)}
      >
        <div className="cpb-modal-head">
          <div className="cpb-modal-titles">
            <h2 className="cpb-modal-title">{itemTitle(item)}</h2>
            {content && (
              <div className="cpb-modal-sub">
                {content.repository} · #{content.number} · {content.state.toLowerCase()}
                {content.comments > 0 && ` · ${content.comments} comment${content.comments === 1 ? '' : 's'}`}
              </div>
            )}
          </div>
          <button className="cpb-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="cpb-error" role="alert">{error}</div>}

        <div className="cpb-fields">
          {rows.map((f) => (
            <FieldRow
              key={f.id}
              field={f}
              currentId={item.singleSelect[f.id]}
              disabled={busy}
              onPick={(optionName) => onSetField(f.name, optionName)}
            />
          ))}
        </div>

        {content?.body && (
          // No character cap any more. It used to slice at 4000, which cuts mid-syntax:
          // a truncated fenced code block leaves the fence unclosed and the parser
          // swallows everything after it. The box scrolls instead.
          <div className="cpb-body">
            <RichText text={content.body} />
          </div>
        )}

        {content?.id && projectPath && (
          <Comments issueId={content.id} knownCount={content.comments} projectPath={projectPath} />
        )}

        {content && (
          <a className="cpb-open-link" href={content.url} target="_blank" rel="noreferrer noopener">
            Open on GitHub ↗
          </a>
        )}
      </div>
    </div>
  );
};
