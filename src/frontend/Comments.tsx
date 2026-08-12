import React from 'react';
import type { IssueComment } from './types';
import { usePluginAPI } from './PluginContext';

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * A timestamp in a thread answers "is this current?", not "when exactly?", and an ISO
 * string answers the second question at the cost of the first. The full date is on the
 * `title` for anyone who does want it.
 */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface Props {
  /** The **issue's** node id, not the project item's — see `ItemContent.id`. */
  issueId: string;
  /** From the board read, so the count is right before the thread has loaded. */
  knownCount: number;
  projectPath: string;
}

export const Comments: React.FC<Props> = ({ issueId, knownCount, projectPath }) => {
  const api = usePluginAPI();
  const [comments, setComments] = React.useState<IssueComment[] | null>(null);
  const [error, setError] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [posting, setPosting] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    setError('');
    try {
      const res = (await api.rpc(
        'GET',
        `/comments?path=${encodeURIComponent(projectPath)}&issueId=${encodeURIComponent(issueId)}`
      )) as { comments?: IssueComment[]; error?: string };
      if (res.error) setError(res.error);
      else setComments(res.comments ?? []);
    } catch (e) {
      setError((e as Error).message || 'Could not load the comments.');
    }
  }, [api, issueId, projectPath]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const post = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setError('');
    try {
      const res = (await api.rpc('POST', `/comments?path=${encodeURIComponent(projectPath)}`, {
        issueId,
        body: text
      })) as { ok?: boolean; comment?: IssueComment; error?: string };

      if (!res.ok || !res.comment) {
        setError(res.error || 'Could not post that comment.');
        return;
      }
      // Appended from the server's own copy, never from a local guess — the id, the
      // timestamp and the author are all GitHub's to state. See `addComment`.
      setComments((prev) => [...(prev ?? []), res.comment!]);
      // Only cleared once it is genuinely posted. A composer emptied on a failed send
      // is the reader's words destroyed by our error.
      setDraft('');
      window.setTimeout(() => endRef.current?.scrollIntoView({ block: 'nearest' }), 0);
    } catch (e) {
      setError((e as Error).message || 'Could not post that comment.');
    } finally {
      setPosting(false);
    }
  };

  const count = comments?.length ?? knownCount;

  return (
    <div className="cpb-comments">
      <div className="cpb-field-name">
        {count === 0 ? 'Comments' : `Comments · ${count}`}
        {comments === null && !error && <span className="cpb-comments-loading"> loading…</span>}
      </div>

      {error && <div className="cpb-error" role="alert">{error}</div>}

      {comments !== null && comments.length === 0 && (
        <div className="cpb-comments-empty">No comments yet.</div>
      )}

      {comments !== null && comments.length > 0 && (
        <div className="cpb-comment-list">
          {comments.map((c) => (
            <article key={c.id} className="cpb-comment">
              <div className="cpb-comment-head">
                {c.author && <img className="cpb-comment-avatar" src={c.author.avatarUrl} alt="" />}
                <span className="cpb-comment-author">{c.author?.login ?? 'ghost'}</span>
                {c.viewerDidAuthor && <span className="cpb-tag">you</span>}
                <time className="cpb-comment-time" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
                  {ago(c.createdAt)}
                </time>
              </div>
              {/* Plain text, as the issue body is. Rendering markdown here would mean
                  shipping a parser and a sanitiser for content written by other people,
                  which is a large surface to add for a panel that sets two fields. */}
              <div className="cpb-comment-body">{c.body}</div>
            </article>
          ))}
          <div ref={endRef} />
        </div>
      )}

      <div className="cpb-composer">
        <textarea
          className="cpb-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Same reasoning as the settings form: this host cancels paste events, so
          // nothing here may depend on the browser's default action. Capture phase, and
          // the text is spliced in at the caret by hand.
          onPasteCapture={(e) => {
            const text = e.clipboardData?.getData('text') ?? '';
            if (!text) return;
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart ?? draft.length;
            const end = el.selectionEnd ?? draft.length;
            setDraft(draft.slice(0, start) + text + draft.slice(end));
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends; a bare Enter is a newline, because these are prose.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void post();
            }
          }}
          placeholder="Leave a comment…"
          rows={3}
          disabled={posting}
        />
        <div className="cpb-composer-actions">
          <span className="cpb-hint">⌘/Ctrl + Enter to post</span>
          <button className="cpb-btn cpb-btn--primary" onClick={() => void post()} disabled={!draft.trim() || posting}>
            {posting ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
};
