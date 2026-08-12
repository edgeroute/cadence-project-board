import React from 'react';

interface Props {
  initial: {
    owner: string;
    projectNumber: number | null;
    tokenSource: 'config' | 'env' | 'none';
    aiKeySource: 'config' | 'env' | 'none';
    claudeCli: boolean;
    aiModel: string;
  };
  saving: boolean;
  error: string;
  onSave: (input: {
    owner: string;
    projectNumber: number;
    token?: string;
    anthropicKey?: string;
    aiModel?: string;
  }) => void;
  onClose: () => void;
}

/** `https://github.com/users/edgeroute/projects/1` → owner and number. */
const PROJECT_URL = /github\.com\/(?:users|orgs)\/([^/\s]+)\/projects\/(\d+)/;

/**
 * Insert text at the caret, the way the browser would have.
 *
 * Needed because this form does its own pasting — see `handlePaste`. Splicing at the
 * selection rather than replacing the whole value is what keeps paste behaving like
 * paste when the field already has something in it and the caret is mid-string.
 */
function spliceAtCaret(el: HTMLInputElement, current: string, insert: string): string {
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  return current.slice(0, start) + insert + current.slice(end);
}

export const SettingsModal: React.FC<Props> = ({ initial, saving, error, onSave, onClose }) => {
  const [owner, setOwner] = React.useState(initial.owner);
  const [number, setNumber] = React.useState(initial.projectNumber ? String(initial.projectNumber) : '');
  const [token, setToken] = React.useState('');
  const [anthropicKey, setAnthropicKey] = React.useState('');
  const [aiModel, setAiModel] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [clipboardNote, setClipboardNote] = React.useState('');

  const parsed = Number(number);
  const valid = owner.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;

  /** Fill owner and number from anything that looks like a project URL. */
  const applyUrl = React.useCallback((value: string): boolean => {
    const m = PROJECT_URL.exec(value);
    if (!m) return false;
    setOwner(m[1]);
    setNumber(m[2]);
    return true;
  }, []);

  /**
   * Paste, implemented here rather than left to the browser.
   *
   * Reported from a real install: the fields could be typed into but not pasted into.
   * Two causes, and this handles both.
   *
   * The first was mine — the URL field called `preventDefault()` whenever the pasted
   * text parsed, so a *successful* paste was the one that left the box looking empty.
   *
   * The second is not mine to fix directly: claudecodeui is a full application with
   * its own document-level key and clipboard handling, and a host that cancels the
   * paste event (a "paste an image into the chat" feature is the usual culprit) leaves
   * a controlled input's `onChange` never firing at all. Nothing about the input can
   * change that.
   *
   * So the value is taken straight off `clipboardData` and written to state, and the
   * default action is cancelled deliberately — the insertion has already happened by
   * then. Whether the host would have cancelled it too stops mattering, because this
   * no longer depends on the default action running.
   *
   * Registered on the **capture** phase (`onPasteCapture` at the call sites) so a host
   * listener that stops propagation on the way up cannot get there first.
   */
  const handlePaste = React.useCallback(
    (current: string, set: (v: string) => void, opts?: { detectUrl?: boolean; digitsOnly?: boolean }) =>
      (e: React.ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData?.getData('text') ?? '';
        // Nothing on the clipboard we can use: let the default run rather than
        // cancelling a paste we are not replacing.
        if (!text) return;
        e.preventDefault();
        setClipboardNote('');

        const cleaned = text.trim();
        // A project URL fills both fields wherever it is pasted — including into the
        // token box, which is where it lands when someone pastes on autopilot.
        if (opts?.detectUrl !== false && applyUrl(cleaned)) {
          if (opts?.detectUrl) setUrl(cleaned);
          return;
        }

        const insert = opts?.digitsOnly ? cleaned.replace(/\D/g, '') : cleaned;
        if (!insert) return;
        set(spliceAtCaret(e.currentTarget, current, insert));
      },
    [applyUrl]
  );

  /**
   * The escape hatch, for a host that suppresses the paste event outright.
   *
   * If the event never fires, `handlePaste` never runs and there is nothing an input
   * can do about it. Reading the clipboard directly goes around the event entirely.
   * It needs a user gesture and can still be refused — in a cross-origin frame, or
   * where the reader declines the permission prompt — so the failure says so instead
   * of leaving a button that does nothing.
   */
  const pasteFromClipboard = React.useCallback(
    async (set: (v: string) => void, opts?: { detectUrl?: boolean; digitsOnly?: boolean }) => {
      setClipboardNote('');
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) {
          setClipboardNote('The clipboard is empty.');
          return;
        }
        if (opts?.detectUrl !== false && applyUrl(text)) {
          if (opts?.detectUrl) setUrl(text);
          return;
        }
        set(opts?.digitsOnly ? text.replace(/\D/g, '') : text);
      } catch {
        setClipboardNote('This window will not let the plugin read the clipboard. Use ⌘/Ctrl+V in the field, or type it.');
      }
    },
    [applyUrl]
  );

  return (
    <div className="cpb-overlay" onClick={onClose} role="presentation">
      <div
        className="cpb-modal cpb-modal--narrow"
        onClick={(e) => e.stopPropagation()}
        // A project URL pasted anywhere in this dialog fills the fields, even with
        // nothing focused. Capture phase, same reasoning as the fields themselves.
        onPasteCapture={(e) => {
          const text = e.clipboardData?.getData('text')?.trim() ?? '';
          if (text && PROJECT_URL.test(text) && !(e.target instanceof HTMLInputElement)) {
            e.preventDefault();
            setUrl(text);
            applyUrl(text);
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Board settings"
      >
        <div className="cpb-modal-head">
          <h2 className="cpb-modal-title">Board settings</h2>
          <button className="cpb-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Same split as the item modal: the header stays, the form scrolls. */}
        <div className="cpb-modal-scroll">
        {error && <div className="cpb-error" role="alert">{error}</div>}
        {clipboardNote && <div className="cpb-error" role="alert">{clipboardNote}</div>}

        <label className="cpb-label" htmlFor="cpb-url">Project URL</label>
        <div className="cpb-input-row">
          <input
            id="cpb-url"
            className="cpb-input"
            // Controlled now. Uncontrolled plus a cancelled default was the reason a
            // recognised URL left this box blank.
            value={url}
            placeholder="https://github.com/users/you/projects/1"
            onChange={(e) => {
              setUrl(e.target.value);
              applyUrl(e.target.value);
            }}
            onPasteCapture={handlePaste(url, setUrl, { detectUrl: true })}
            autoFocus
          />
          <button className="cpb-btn cpb-paste" onClick={() => void pasteFromClipboard(setUrl, { detectUrl: true })} title="Paste from clipboard">
            Paste
          </button>
        </div>
        <div className="cpb-hint">Paste it and the two fields below fill themselves in.</div>

        <div className="cpb-row2">
          <div>
            <label className="cpb-label" htmlFor="cpb-owner">Owner</label>
            <input
              id="cpb-owner"
              className="cpb-input"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onPasteCapture={handlePaste(owner, setOwner)}
              placeholder="edgeroute"
            />
          </div>
          <div>
            <label className="cpb-label" htmlFor="cpb-number">Project #</label>
            <input
              id="cpb-number"
              className="cpb-input"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              // Pasting the whole URL here is the commonest mis-aim, so it is detected
              // rather than stripped down to the digits it happens to contain.
              onPasteCapture={handlePaste(number, setNumber, { digitsOnly: true })}
              placeholder="1"
              inputMode="numeric"
            />
          </div>
        </div>

        <label className="cpb-label" htmlFor="cpb-token">
          GitHub token
          {initial.tokenSource === 'config' && <span className="cpb-tag">saved</span>}
          {initial.tokenSource === 'env' && <span className="cpb-tag">from GH_TOKEN</span>}
        </label>
        <div className="cpb-input-row">
          <input
            id="cpb-token"
            className="cpb-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            // `detectUrl: false` — a token is opaque and must never be reinterpreted,
            // and the URL check would be a needless look at a secret besides.
            onPasteCapture={handlePaste(token, setToken, { detectUrl: false })}
            placeholder={initial.tokenSource === 'none' ? 'ghp_…' : 'leave blank to keep the current one'}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="cpb-btn cpb-paste" onClick={() => void pasteFromClipboard(setToken, { detectUrl: false })} title="Paste from clipboard">
            Paste
          </button>
        </div>
        {/*
          This warning is the single most valuable thing on this form. A fine-grained
          token is the obvious modern choice and it cannot work: GitHub exposes a
          "Projects" permission only for organizations, so a user-owned project is
          unreachable no matter which boxes are ticked. Without saying so, the failure
          is an INSUFFICIENT_SCOPES wall that reads like a bug in this plugin.
        */}
        <div className="cpb-hint">
          Must be a <strong>classic</strong> token with <code>repo</code> and <code>project</code> scopes.
          Fine-grained tokens cannot read user-owned projects at all.
        </div>
        <div className="cpb-hint">
          It is written to <code>.CadenceBoard/project-board.json</code> in this project, and that
          directory is added to <code>.gitignore</code>.
        </div>

        {/*
          AI Prioritize's own credentials.

          These existed in the config file, in `publicConfig`, and in the message the
          board shows when it falls back to keyword scoring — "Add one in Settings" —
          for a whole release before this form had anywhere to put them. The feature
          told readers to do something the UI gave them no way to do.
        */}
        <div className="cpb-section-rule" />

        <label className="cpb-label" htmlFor="cpb-ai-key">
          Anthropic API key
          {initial.aiKeySource === 'config' && <span className="cpb-tag">saved</span>}
          {initial.aiKeySource === 'env' && <span className="cpb-tag">from ANTHROPIC_API_KEY</span>}
          {/* "optional" and "not needed" are different claims, and the difference is
              whether leaving this blank costs you the feature. Only the CLI probe can
              tell them apart, so the tag reports the probe rather than guessing. */}
          {initial.aiKeySource === 'none' && (
            <span className="cpb-tag cpb-tag--muted">
              {initial.claudeCli ? 'not needed' : 'optional'}
            </span>
          )}
        </label>
        <div className="cpb-input-row">
          <input
            id="cpb-ai-key"
            className="cpb-input"
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            // `detectUrl: false` for the same reason as the GitHub token: a secret is
            // opaque and must never be reinterpreted as something else.
            onPasteCapture={handlePaste(anthropicKey, setAnthropicKey, { detectUrl: false })}
            placeholder={initial.aiKeySource === 'none' ? 'sk-ant-…' : 'leave blank to keep the current one'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="cpb-btn cpb-paste"
            onClick={() => void pasteFromClipboard(setAnthropicKey, { detectUrl: false })}
            title="Paste from clipboard"
          >
            Paste
          </button>
        </div>
        <div className="cpb-hint">
          {initial.claudeCli ? (
            <>
              Only used by <strong>AI Prioritize</strong>, and only if you want it to bill an API
              account. Left blank, that button uses the <code>claude</code> CLI you are already
              signed in to on this machine — same models, no second credential.
            </>
          ) : (
            <>
              Only used by <strong>AI Prioritize</strong>. The <code>claude</code> CLI could not be
              run here, so without a key that button falls back to keyword scoring — which needs no
              key and sends nothing anywhere.
            </>
          )}
        </div>
        <div className="cpb-hint">
          Either way, what leaves this machine is the same: the title, labels, comment count, age and
          the first 600 characters of each issue body. Nothing else — not your token, not the comment
          threads, not the repository.
        </div>

        <label className="cpb-label" htmlFor="cpb-ai-model">Model</label>
        <input
          id="cpb-ai-model"
          className="cpb-input"
          value={aiModel}
          onChange={(e) => setAiModel(e.target.value)}
          onPasteCapture={handlePaste(aiModel, setAiModel, { detectUrl: false })}
          placeholder={initial.aiModel}
          spellCheck={false}
        />
        <div className="cpb-hint">
          Defaults to <code>{initial.aiModel}</code>. A cheaper model will cost less and judge
          less well; because these suggestions become writes to a shared board, that trade is
          yours to make rather than one this plugin makes for you.
        </div>

        <div className="cpb-actions">
          <button className="cpb-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="cpb-btn cpb-btn--primary"
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                owner: owner.trim(),
                projectNumber: parsed,
                // Blank means "leave it alone", never "clear it" — the form is never
                // given the current secrets back, so an empty box carries no intent.
                // `writeConfig` keeps the stored value when these are undefined.
                token: token.trim() || undefined,
                anthropicKey: anthropicKey.trim() || undefined,
                aiModel: aiModel.trim() || undefined
              })
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
};
