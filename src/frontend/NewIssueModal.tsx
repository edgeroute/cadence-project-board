import React from 'react';
import type { ProjectItem, ProjectField } from './types';
import { columnsFrom, NO_STATUS } from './types';

/**
 * The repositories this board already draws from, commonest first.
 *
 * Derived from the cards rather than configured, and that is the whole design of this
 * picker. A Projects v2 board is not a repository — it can hold issues from any number of
 * them — so there is no single "the repo" to store in config, and asking for one in
 * Settings would make the common case (a board that has only ever pointed at one repo)
 * pay for the rare one.
 *
 * Commonest first because the default matters more than the list: on a board where
 * everything comes from one repository, the right answer is already selected and nobody
 * has to think about this field at all.
 */
export function repositoriesOn(items: ProjectItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const repo = item.content?.repository;
    if (repo) counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo);
}

/** The value the repository `<select>` uses for "somewhere not on this board yet". */
const OTHER = '__other__';

export interface NewIssueInput {
  repository: string;
  title: string;
  body: string;
  /** A Status option name, or '' to leave the card with no status. */
  status: string;
}

interface Props {
  items: ProjectItem[];
  fields: ProjectField[];
  /** The owner from config, used only to shape the placeholder for a hand-typed repo. */
  owner: string;
  submitting: boolean;
  error: string;
  onCreate: (input: NewIssueInput) => void;
  onClose: () => void;
}

export const NewIssueModal: React.FC<Props> = ({
  items,
  fields,
  owner,
  submitting,
  error,
  onCreate,
  onClose
}) => {
  const repos = React.useMemo(() => repositoriesOn(items), [items]);
  const columns = React.useMemo(() => columnsFrom(fields).filter((c) => c.id !== NO_STATUS), [fields]);

  const [repoChoice, setRepoChoice] = React.useState(repos[0] ?? OTHER);
  const [typedRepo, setTypedRepo] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  /**
   * The first real column, not "No Status".
   *
   * A board's leftmost Status option is its intake by convention — Backlog, Triage, Todo —
   * and an issue filed from here is by definition new work. Landing it in "No Status"
   * instead would put it in the column that exists to hold items nobody has sorted yet,
   * which is a claim about the issue that filing it deliberately contradicts.
   */
  const [status, setStatus] = React.useState(columns[0]?.name ?? '');

  const repository = repoChoice === OTHER ? typedRepo.trim() : repoChoice;
  const dirty = title.trim() !== '' || body.trim() !== '' || typedRepo.trim() !== '';
  const canSubmit = !submitting && title.trim() !== '' && repository !== '';

  /**
   * Leaving with something typed asks first.
   *
   * There is no draft anywhere — closing this modal discards whatever is in it — and a
   * stray Escape or a click on the backdrop is exactly how someone loses a paragraph they
   * had just written. The confirm is skipped entirely while the form is untouched, so the
   * overwhelmingly common "opened it by accident" case still closes instantly.
   */
  const close = React.useCallback(() => {
    if (dirty && !window.confirm('Discard this issue?')) return;
    onClose();
  }, [dirty, onClose]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      // The shortcut every text box in a developer tool has. The title alone is enough to
      // file, so this works from either field.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
        onCreate({ repository, title: title.trim(), body: body.trim(), status });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [body, canSubmit, close, onCreate, repository, status, title]);

  return (
    <div className="cpb-overlay" onClick={close} role="presentation">
      <div
        className="cpb-modal cpb-modal--form"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
      >
        <div className="cpb-modal-head">
          <div className="cpb-modal-titles">
            <h2 className="cpb-modal-title">New issue</h2>
            <div className="cpb-modal-sub">Opens it on GitHub and puts it on this board.</div>
          </div>
          <button className="cpb-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cpb-modal-scroll">
          {error && (
            <div className="cpb-error" role="alert">
              {error}
            </div>
          )}

          <form
            className="cpb-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) onCreate({ repository, title: title.trim(), body: body.trim(), status });
            }}
          >
            <label className="cpb-form-row">
              <span className="cpb-form-label">Repository</span>
              {repos.length > 0 ? (
                <select
                  className="cpb-select cpb-form-control"
                  value={repoChoice}
                  onChange={(e) => setRepoChoice(e.target.value)}
                  disabled={submitting}
                >
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value={OTHER}>Another repository…</option>
                </select>
              ) : (
                // An empty board, or one holding only draft items: there is nothing to
                // infer from, so the field is simply typed. Not an error state — a board
                // starts empty, and this is the control that lets it stop being empty.
                <input
                  className="cpb-input cpb-form-control"
                  value={typedRepo}
                  onChange={(e) => setTypedRepo(e.target.value)}
                  placeholder={`${owner || 'owner'}/repository`}
                  disabled={submitting}
                />
              )}
            </label>

            {repos.length > 0 && repoChoice === OTHER && (
              <label className="cpb-form-row">
                <span className="cpb-form-label" />
                <input
                  className="cpb-input cpb-form-control"
                  value={typedRepo}
                  onChange={(e) => setTypedRepo(e.target.value)}
                  placeholder={`${owner || 'owner'}/repository`}
                  disabled={submitting}
                  autoFocus
                />
              </label>
            )}

            <label className="cpb-form-row">
              <span className="cpb-form-label">Title</span>
              <input
                className="cpb-input cpb-form-control"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs doing?"
                disabled={submitting}
                autoFocus={repos.length > 0 && repoChoice !== OTHER}
              />
            </label>

            <label className="cpb-form-row cpb-form-row--tall">
              <span className="cpb-form-label">Description</span>
              <textarea
                className="cpb-textarea cpb-form-control"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Markdown, optional."
                rows={8}
                disabled={submitting}
              />
            </label>

            {columns.length > 0 && (
              <label className="cpb-form-row">
                <span className="cpb-form-label">Column</span>
                <select
                  className="cpb-select cpb-form-control"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={submitting}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                  <option value="">No Status</option>
                </select>
              </label>
            )}

            <div className="cpb-form-actions">
              <button type="button" className="cpb-btn" onClick={close} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="cpb-btn cpb-btn--primary" disabled={!canSubmit}>
                {submitting ? 'Opening…' : 'Create issue'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
