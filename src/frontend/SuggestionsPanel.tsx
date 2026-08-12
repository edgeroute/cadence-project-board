import React from 'react';

export interface Suggestion {
  itemId: string;
  number: number | null;
  title: string;
  priority: string | null;
  size: string | null;
  reason: string;
}

export interface PrioritizeResult {
  suggestions: Suggestion[];
  source: 'claude-api' | 'claude-cli' | 'heuristic';
  note?: string;
}

/** Mirrors `PrioritizeResult['source']` on the backend — kept exhaustive on purpose. */
const ENGINE_LABEL: Record<PrioritizeResult['source'], string> = {
  'claude-api': 'Read by Claude',
  'claude-cli': 'Read by Claude, via your Claude Code login',
  heuristic: 'Keyword scoring'
};

interface Props {
  result: PrioritizeResult;
  /** Item id → what the board currently holds, so unchanged rows can be told apart. */
  current: Map<string, { priority: string | null; size: string | null }>;
  /** Rows the reader has ticked. */
  selected: Set<string>;
  applying: boolean;
  /** How many of the selected rows have been written so far, for the progress line. */
  applied: number;
  onToggle: (itemId: string) => void;
  onToggleAll: (next: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}

/**
 * The review step between a suggestion and a write.
 *
 * The plugin this feature is modelled on holds its AI priorities in memory and never
 * writes them anywhere, so it needs no review. This board has real `Priority` and `Size`
 * fields, which makes a suggestion here a *proposed mutation* to a shared board — and
 * applying seventeen of those from a model's first answer, unseen, is a large change made
 * on somebody's behalf without them looking at it.
 *
 * So the model proposes and the reader disposes: every row is a tick box, the reason is
 * on the row, and rows that would not change anything are pre-unticked so the list reads
 * as "here is what I would change" rather than "here is everything".
 */
export const SuggestionsPanel: React.FC<Props> = ({
  result,
  current,
  selected,
  applying,
  applied,
  onToggle,
  onToggleAll,
  onApply,
  onClose
}) => {
  const changes = result.suggestions.filter((s) => {
    const now = current.get(s.itemId);
    return !now || now.priority !== s.priority || now.size !== s.size;
  });
  const allSelected = changes.length > 0 && changes.every((s) => selected.has(s.itemId));

  return (
    <div className="cpb-overlay" onClick={applying ? undefined : onClose} role="presentation">
      <div
        className="cpb-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Suggested priorities and sizes"
      >
        <div className="cpb-modal-head">
          <div className="cpb-modal-titles">
            <h2 className="cpb-modal-title">Suggested Priority and Size</h2>
            <div className="cpb-modal-sub">
              {/* Which engine answered is stated plainly and always. A heuristic guess
                  presented as a model's read is the one thing that would make this
                  feature untrustworthy — and the heuristic runs whenever the model
                  cannot, which is not a rare path. The two Claude paths are named
                  apart because they spend different accounts. */}
              {ENGINE_LABEL[result.source] ?? 'Keyword scoring'} · {changes.length} of{' '}
              {result.suggestions.length} would change
            </div>
          </div>
          <button className="cpb-close" onClick={onClose} aria-label="Close" disabled={applying}>
            ✕
          </button>
        </div>

        <div className="cpb-modal-scroll">
          {result.note && <div className="cpb-error" role="status">{result.note}</div>}

          {changes.length === 0 ? (
            <div className="cpb-comments-empty">
              Nothing to change — every item already carries the suggested Priority and Size.
            </div>
          ) : (
            <>
              <label className="cpb-suggest-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  disabled={applying}
                />
                <span>Select all {changes.length}</span>
              </label>

              <div className="cpb-suggest-list">
                {changes.map((s) => {
                  const now = current.get(s.itemId);
                  return (
                    <label key={s.itemId} className="cpb-suggest">
                      <input
                        type="checkbox"
                        checked={selected.has(s.itemId)}
                        onChange={() => onToggle(s.itemId)}
                        disabled={applying}
                      />
                      <div className="cpb-suggest-body">
                        <div className="cpb-suggest-title">
                          {s.number !== null && <span className="cpb-card-number">#{s.number}</span>} {s.title}
                        </div>
                        <div className="cpb-suggest-change">
                          {/* Both halves of the change are shown, old → new, because
                              "set P1" is not reviewable without knowing what it replaces. */}
                          <Delta label="Priority" from={now?.priority ?? null} to={s.priority} />
                          <Delta label="Size" from={now?.size ?? null} to={s.size} />
                        </div>
                        <div className="cpb-suggest-reason">{s.reason}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="cpb-modal-foot">
          <span className="cpb-hint">
            {applying
              ? `Applying ${applied} of ${selected.size}…`
              : `${selected.size} selected · writes the project field and the matching label`}
          </span>
          <div className="cpb-actions">
            <button className="cpb-btn" onClick={onClose} disabled={applying}>
              Cancel
            </button>
            <button
              className="cpb-btn cpb-btn--primary"
              onClick={onApply}
              disabled={applying || selected.size === 0}
            >
              {applying ? 'Applying…' : `Apply ${selected.size}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** `Priority — (unset) → P1`, or nothing at all when this half is unchanged. */
const Delta: React.FC<{ label: string; from: string | null; to: string | null }> = ({ label, from, to }) => {
  if (from === to) return null;
  return (
    <span className="cpb-delta">
      <span className="cpb-delta-label">{label}</span>
      <span className="cpb-delta-from">{from ?? 'unset'}</span>
      <span className="cpb-delta-arrow">→</span>
      <span className="cpb-delta-to">{to ?? 'unset'}</span>
    </span>
  );
};
