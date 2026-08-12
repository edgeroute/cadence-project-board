import React from 'react';
import { usePluginAPI, useProjectPath, useTheme } from './PluginContext';
import type { BoardData, ProjectItem, BoardResponse } from './types';
import {
  isNotConfigured,
  itemMatches,
  fieldByName,
  columnsFrom,
  STATUS_FIELD,
  NO_STATUS
} from './types';
import { Board } from './Board';
import { ItemModal } from './ItemModal';
import { SettingsModal } from './SettingsModal';

interface ConfigShape {
  owner: string;
  projectNumber: number | null;
  enabled: boolean;
  tokenSource: 'config' | 'env' | 'none';
}

export const App: React.FC = () => {
  const api = usePluginAPI();
  const projectPath = useProjectPath();
  const theme = useTheme();

  const [board, setBoard] = React.useState<BoardData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notConfigured, setNotConfigured] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<ConfigShape | null>(null);
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [settingsError, setSettingsError] = React.useState('');

  /**
   * Collapsed columns, remembered per project.
   *
   * localStorage rather than the config file: this is a view preference, not
   * configuration, and it should not turn into a diff in a file the reader shares
   * with themselves across machines. Keyed by project path so two projects do not
   * inherit each other's layout.
   */
  const collapseKey = projectPath ? `cpb:collapsed:${projectPath}` : null;
  React.useEffect(() => {
    if (!collapseKey) return;
    try {
      const raw = window.localStorage.getItem(collapseKey);
      setCollapsed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setCollapsed(new Set());
    }
  }, [collapseKey]);

  const toggleColumn = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (collapseKey) {
        try {
          window.localStorage.setItem(collapseKey, JSON.stringify([...next]));
        } catch {
          /* private mode, or a full quota: the board still works, it just forgets */
        }
      }
      return next;
    });
  };

  const load = React.useCallback(
    async (fresh: boolean) => {
      if (!projectPath) {
        setLoading(false);
        setNotConfigured('Open a project to see its board.');
        return;
      }
      setLoading(true);
      setError('');
      setNotConfigured('');
      try {
        const res = (await api.rpc(
          'GET',
          `/board?path=${encodeURIComponent(projectPath)}${fresh ? '&fresh=1' : ''}`
        )) as BoardResponse & { error?: string };

        if (isNotConfigured(res)) {
          setBoard(null);
          setNotConfigured(res.error);
        } else if (res.error) {
          // A reachable backend that could not reach GitHub. The board (if we already
          // have one) deliberately stays on screen under the message — taking a
          // working view away because a refresh failed is the same mistake the
          // Cadence app fixed in its own `/me` gate.
          setError(res.error);
        } else {
          setBoard(res);
        }
      } catch (e) {
        setError((e as Error).message || 'Could not reach the plugin backend.');
      } finally {
        setLoading(false);
      }
    },
    [api, projectPath]
  );

  React.useEffect(() => {
    void load(false);
  }, [load]);

  const openSettings = async () => {
    setSettingsError('');
    if (!projectPath) return;
    try {
      const cfg = (await api.rpc('GET', `/config?path=${encodeURIComponent(projectPath)}`)) as ConfigShape;
      setSettings(cfg);
    } catch (e) {
      setSettings({ owner: '', projectNumber: null, enabled: true, tokenSource: 'none' });
      setSettingsError((e as Error).message);
    }
  };

  const saveSettings = async (input: { owner: string; projectNumber: number; token?: string }) => {
    if (!projectPath) return;
    setSavingSettings(true);
    setSettingsError('');
    try {
      const res = (await api.rpc('POST', `/config?path=${encodeURIComponent(projectPath)}`, input)) as {
        ok?: boolean;
        error?: string;
        gitignored?: boolean;
      };
      if (res.error) {
        setSettingsError(res.error);
        return;
      }
      setSettings(null);
      // Surfaced rather than swallowed: the token is now sitting in the project and
      // the one thing keeping it out of a commit did not happen.
      if (res.gitignored === false) {
        setError('Saved, but .gitignore could not be updated — add .CadenceBoard/ to it yourself.');
      }
      await load(true);
    } catch (e) {
      setSettingsError((e as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  /**
   * Move a card, or set any single-select field on it.
   *
   * Optimistic, with a real rollback. The card moves the instant it is dropped, the
   * mutation goes out, and a rejection puts it back where it came from *and says why*.
   * A card that silently returns to its old column is indistinguishable from a drop
   * that never registered — the same reasoning behind `mark()` in the Cadence app's
   * Today screen, which is where this pattern comes from.
   *
   * The board is not refetched on success. The optimistic patch already describes the
   * new state exactly (one field, one value, and the server agreed), so a refetch
   * would spend a request to redraw an identical board — and would fight the next drag
   * if the reader is moving several cards in a row.
   */
  const applyField = React.useCallback(
    async (itemId: string, fieldName: string, optionName: string | null) => {
      if (!projectPath || !board) return;
      const field = fieldByName(board.fields, fieldName);
      if (!field) return;

      const before = board.items.find((i) => i.id === itemId);
      if (!before) return;
      const previous = before.singleSelect[field.id];

      const nextOptionId = optionName
        ? field.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase())?.id
        : undefined;

      const patch = (optionId: string | undefined) =>
        setBoard((b) =>
          b
            ? {
                ...b,
                items: b.items.map((i) => {
                  if (i.id !== itemId) return i;
                  const singleSelect = { ...i.singleSelect };
                  if (optionId) singleSelect[field.id] = optionId;
                  else delete singleSelect[field.id];
                  return { ...i, singleSelect };
                })
              }
            : b
        );

      setError('');
      patch(nextOptionId);
      setPending((p) => new Set(p).add(itemId));

      try {
        const res = (await api.rpc('POST', `/field?path=${encodeURIComponent(projectPath)}`, {
          itemId,
          field: fieldName,
          option: optionName
        })) as { ok?: boolean; error?: string };

        if (!res.ok) {
          patch(previous);
          setError(res.error || `Could not update ${fieldName}.`);
        }
      } catch (e) {
        patch(previous);
        setError((e as Error).message || `Could not update ${fieldName}.`);
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(itemId);
          return next;
        });
      }
    },
    [api, board, projectPath]
  );

  /** A drop: translate the target column back into a Status option name. */
  const onMove = React.useCallback(
    (itemId: string, toColumnId: string) => {
      if (!board) return;
      if (toColumnId === NO_STATUS) {
        void applyField(itemId, STATUS_FIELD, null);
        return;
      }
      const status = fieldByName(board.fields, STATUS_FIELD);
      const option = status?.options.find((o) => o.id === toColumnId);
      if (option) void applyField(itemId, STATUS_FIELD, option.name);
    },
    [applyField, board]
  );

  const filtered = React.useMemo(
    () => (board ? board.items.filter((i) => itemMatches(i, search)) : []),
    [board, search]
  );

  const selected = board?.items.find((i) => i.id === selectedId) ?? null;
  const columnCount = board ? columnsFrom(board.fields).length : 0;

  return (
    <div className={`cpb-root cpb-root--${theme}`}>
      <header className="cpb-bar">
        <div className="cpb-bar-left">
          <h1 className="cpb-h1">{board?.title ?? 'Project Board'}</h1>
          {board && (
            <span className="cpb-count">
              {filtered.length}
              {filtered.length !== board.items.length ? ` of ${board.items.length}` : ''} item
              {board.items.length === 1 ? '' : 's'} · {columnCount} columns
            </span>
          )}
        </div>
        <div className="cpb-bar-right">
          <input
            className="cpb-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number, title, repo…"
            aria-label="Search the board"
          />
          <button className="cpb-btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {board && (
            <a className="cpb-btn" href={board.url} target="_blank" rel="noreferrer noopener">
              GitHub ↗
            </a>
          )}
          <button className="cpb-btn" onClick={() => void openSettings()} aria-label="Board settings">
            ⚙
          </button>
        </div>
      </header>

      {error && (
        <div className="cpb-error cpb-error--bar" role="alert">
          <span>{error}</span>
          <button className="cpb-error-dismiss" onClick={() => setError('')} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {notConfigured ? (
        <div className="cpb-setup">
          <h2 className="cpb-setup-title">No board yet</h2>
          <p className="cpb-setup-body">{notConfigured}</p>
          <button className="cpb-btn cpb-btn--primary" onClick={() => void openSettings()}>
            Set up the board
          </button>
        </div>
      ) : loading && !board ? (
        <div className="cpb-setup">
          <p className="cpb-setup-body">Loading the board…</p>
        </div>
      ) : board ? (
        <Board
          board={board}
          items={filtered}
          collapsed={collapsed}
          pending={pending}
          onToggleColumn={toggleColumn}
          onMove={onMove}
          onOpen={(item: ProjectItem) => setSelectedId(item.id)}
        />
      ) : null}

      {selected && board && (
        <ItemModal
          item={selected}
          fields={board.fields}
          busy={pending.has(selected.id)}
          error={error}
          projectPath={projectPath}
          onSetField={(fieldName, optionName) => void applyField(selected.id, fieldName, optionName)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {settings && (
        <SettingsModal
          initial={settings}
          saving={savingSettings}
          error={settingsError}
          onSave={(input) => void saveSettings(input)}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
};
