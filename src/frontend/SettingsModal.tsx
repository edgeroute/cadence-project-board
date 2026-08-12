import React from 'react';

interface Props {
  initial: { owner: string; projectNumber: number | null; tokenSource: 'config' | 'env' | 'none' };
  saving: boolean;
  error: string;
  onSave: (input: { owner: string; projectNumber: number; token?: string }) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<Props> = ({ initial, saving, error, onSave, onClose }) => {
  const [owner, setOwner] = React.useState(initial.owner);
  const [number, setNumber] = React.useState(initial.projectNumber ? String(initial.projectNumber) : '');
  const [token, setToken] = React.useState('');

  const parsed = Number(number);
  const valid = owner.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;

  /**
   * Paste the project URL, get the fields filled in.
   *
   * The owner and the number are both in the URL the reader already has open, and
   * "project number" is not a thing anyone knows off-hand — it is neither the project
   * id nor its title. Accepting the URL is the difference between a form you can fill
   * from memory and one you have to go and look something up for.
   */
  const applyUrl = (value: string) => {
    const m = /github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(value);
    if (!m) return false;
    setOwner(m[2]);
    setNumber(m[3]);
    return true;
  };

  return (
    <div className="cpb-overlay" onClick={onClose} role="presentation">
      <div className="cpb-modal cpb-modal--narrow" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Board settings">
        <div className="cpb-modal-head">
          <h2 className="cpb-modal-title">Board settings</h2>
          <button className="cpb-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div className="cpb-error" role="alert">{error}</div>}

        <label className="cpb-label" htmlFor="cpb-url">Project URL</label>
        <input
          id="cpb-url"
          className="cpb-input"
          placeholder="https://github.com/users/you/projects/1"
          onChange={(e) => applyUrl(e.target.value)}
          onPaste={(e) => {
            if (applyUrl(e.clipboardData.getData('text'))) e.preventDefault();
          }}
        />
        <div className="cpb-hint">Paste it and the two fields below fill themselves in.</div>

        <div className="cpb-row2">
          <div>
            <label className="cpb-label" htmlFor="cpb-owner">Owner</label>
            <input id="cpb-owner" className="cpb-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="edgeroute" />
          </div>
          <div>
            <label className="cpb-label" htmlFor="cpb-number">Project #</label>
            <input id="cpb-number" className="cpb-input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="1" inputMode="numeric" />
          </div>
        </div>

        <label className="cpb-label" htmlFor="cpb-token">
          GitHub token
          {initial.tokenSource === 'config' && <span className="cpb-tag">saved</span>}
          {initial.tokenSource === 'env' && <span className="cpb-tag">from GH_TOKEN</span>}
        </label>
        <input
          id="cpb-token"
          className="cpb-input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={initial.tokenSource === 'none' ? 'ghp_…' : 'leave blank to keep the current one'}
          autoComplete="off"
        />
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

        <div className="cpb-actions">
          <button className="cpb-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="cpb-btn cpb-btn--primary"
            disabled={!valid || saving}
            onClick={() => onSave({ owner: owner.trim(), projectNumber: parsed, token: token.trim() || undefined })}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
