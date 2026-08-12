import React from 'react';
import { usePluginAPI, useProjectPath, useTheme } from './PluginContext';
import type { BoardData, ProjectItem, BoardResponse, ProjectField } from './types';
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
import { FilterBar, NO_FILTERS, passesFilter, type Filters } from './FilterBar';
import { GitHubMark } from './GitHubMark';
import { SORT_LABELS, DEFAULT_SORT, availableSortKeys, sortItems, type Sort, type SortKey } from './sortUtils';
import { SuggestionsPanel, type PrioritizeResult } from './SuggestionsPanel';
import { PRIORITY_FIELD, SIZE_FIELD } from './types';

interface ConfigShape {
  owner: string;
  projectNumber: number | null;
  enabled: boolean;
  tokenSource: 'config' | 'env' | 'none';
  aiKeySource: 'config' | 'env' | 'none';
  claudeCli: boolean;
  aiModel: string;
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
  const [filters, setFilters] = React.useState<Filters>(NO_FILTERS);
  const [sort, setSort] = React.useState<Sort>(DEFAULT_SORT);
  const [prioritizing, setPrioritizing] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<PrioritizeResult | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [applying, setApplying] = React.useState(false);
  const [appliedCount, setAppliedCount] = React.useState(0);
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
      setSettings({ owner: '', projectNumber: null, enabled: true, tokenSource: 'none', aiKeySource: 'none', claudeCli: false, aiModel: 'claude-opus-5' });
      setSettingsError((e as Error).message);
    }
  };

  const saveSettings = async (input: {
    owner: string;
    projectNumber: number;
    token?: string;
    anthropicKey?: string;
    aiModel?: string;
  }) => {
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
        })) as { ok?: boolean; error?: string; warning?: string };

        if (!res.ok) {
          patch(previous);
          setError(res.error || `Could not update ${fieldName}.`);
        } else if (res.warning) {
          // The field write landed; only the label mirror failed. The card stays where
          // the reader put it and the message explains what is out of step, rather than
          // rolling back a change that actually happened.
          setError(res.warning);
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

  /**
   * What the board actually draws: the search and both field filters, applied together.
   *
   * The columns are deliberately *not* rebuilt from this — every column still renders,
   * empty if the filter excluded all of it. A filter that made columns disappear would
   * change the shape of the board under the reader, and "Ready is empty" is the answer
   * they are looking for as often as "here is what is in Ready".
   */
  const filtered = React.useMemo(() => {
    if (!board) return [];
    const priorityField = fieldByName(board.fields, PRIORITY_FIELD);
    const sizeField = fieldByName(board.fields, SIZE_FIELD);
    return board.items.filter(
      (i) =>
        itemMatches(i, search) &&
        passesFilter(i.singleSelect, priorityField, filters.priority) &&
        passesFilter(i.singleSelect, sizeField, filters.size)
    );
  }, [board, search, filters]);

  const sorted = React.useMemo(
    () => (board ? sortItems(filtered, sort, board.fields) : filtered),
    [board, filtered, sort]
  );

  /**
   * Ask for suggestions for what is currently on screen.
   *
   * The *sorted and filtered* set, not the whole board: triaging "everything in Backlog"
   * should cost a Backlog-sized request, and a reader who has filtered the view has
   * already said which items they mean.
   */
  const prioritize = React.useCallback(async () => {
    if (!projectPath || !board) return;
    setPrioritizing(true);
    setError('');
    try {
      const res = (await api.rpc('POST', `/prioritize?path=${encodeURIComponent(projectPath)}`, {
        itemIds: sorted.map((i) => i.id)
      })) as PrioritizeResult & { error?: string };
      if (res.error) {
        setError(res.error);
        return;
      }
      setSuggestions(res);
      // Pre-ticked: every row that would actually change something. The panel hides
      // no-op rows, so this matches what the reader is shown.
      const priorityField = fieldByName(board.fields, PRIORITY_FIELD);
      const sizeField = fieldByName(board.fields, SIZE_FIELD);
      const nameOf = (item: ProjectItem, f: ProjectField | null) =>
        f ? f.options.find((o) => o.id === item.singleSelect[f.id])?.name ?? null : null;
      const changed = new Set<string>();
      for (const s of res.suggestions) {
        const item = board.items.find((i) => i.id === s.itemId);
        if (!item) continue;
        if (nameOf(item, priorityField) !== s.priority || nameOf(item, sizeField) !== s.size) {
          changed.add(s.itemId);
        }
      }
      setPicked(changed);
    } catch (e) {
      setError((e as Error).message || 'Could not get suggestions.');
    } finally {
      setPrioritizing(false);
    }
  }, [api, board, projectPath, sorted]);

  /**
   * Write the ticked suggestions.
   *
   * Sequentially, through the same `applyField` a drag uses — so each write gets the
   * optimistic patch, the rollback, and the label mirror for free, and a failure part
   * way through leaves the earlier writes standing rather than half-applying something
   * that claims to be atomic. GitHub has no batch mutation for this, so a parallel fan
   * out would only trade a progress count for rate-limit risk.
   */
  const applySuggestions = React.useCallback(async () => {
    if (!suggestions) return;
    setApplying(true);
    setAppliedCount(0);
    let done = 0;
    for (const s of suggestions.suggestions) {
      if (!picked.has(s.itemId)) continue;
      if (s.priority) await applyField(s.itemId, PRIORITY_FIELD, s.priority);
      if (s.size) await applyField(s.itemId, SIZE_FIELD, s.size);
      done += 1;
      setAppliedCount(done);
    }
    setApplying(false);
    setSuggestions(null);
    setPicked(new Set());
  }, [applyField, picked, suggestions]);

  /** What the board holds now, for the panel's old → new column. */
  const currentValues = React.useMemo(() => {
    const map = new Map<string, { priority: string | null; size: string | null }>();
    if (!board) return map;
    const p = fieldByName(board.fields, PRIORITY_FIELD);
    const z = fieldByName(board.fields, SIZE_FIELD);
    for (const item of board.items) {
      map.set(item.id, {
        priority: p ? p.options.find((o) => o.id === item.singleSelect[p.id])?.name ?? null : null,
        size: z ? z.options.find((o) => o.id === item.singleSelect[z.id])?.name ?? null : null
      });
    }
    return map;
  }, [board]);

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
          {board && (
            <>
              <select
                className="cpb-select"
                value={sort.key}
                onChange={(e) => setSort({ ...sort, key: e.target.value as SortKey })}
                aria-label="Sort cards by"
                title="Sort cards within each column"
              >
                {availableSortKeys(board.fields).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABELS[k]}
                  </option>
                ))}
              </select>
              {/* Hidden on Board order: there is no ascending or descending version of
                  "however the owner arranged it", and a live control that does nothing
                  is worse than an absent one. */}
              {sort.key !== 'manual' && (
                <button
                  className="cpb-btn cpb-icon-btn"
                  onClick={() => setSort({ ...sort, dir: sort.dir === 'desc' ? 'asc' : 'desc' })}
                  title={sort.dir === 'desc' ? 'Descending — click for ascending' : 'Ascending — click for descending'}
                  aria-label={`Sort direction: ${sort.dir === 'desc' ? 'descending' : 'ascending'}`}
                >
                  {sort.dir === 'desc' ? '↓' : '↑'}
                </button>
              )}
              <button
                className="cpb-btn"
                onClick={() => void prioritize()}
                disabled={prioritizing}
                title="Suggest a Priority and Size for the cards currently shown"
              >
                {prioritizing ? 'Reading…' : 'AI Prioritize'}
              </button>
            </>
          )}
          <button className="cpb-btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {board && (
            <a
              className="cpb-btn cpb-icon-btn"
              href={board.url}
              target="_blank"
              rel="noreferrer noopener"
              title="Open the project on GitHub"
              aria-label="Open the project on GitHub"
            >
              <GitHubMark />
            </a>
          )}
          <button className="cpb-btn" onClick={() => void openSettings()} aria-label="Board settings">
            ⚙
          </button>
        </div>
      </header>

      {board && <FilterBar fields={board.fields} filters={filters} onChange={setFilters} />}

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
          items={sorted}
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

      {suggestions && (
        <SuggestionsPanel
          result={suggestions}
          current={currentValues}
          selected={picked}
          applying={applying}
          applied={appliedCount}
          onToggle={(id) =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onToggleAll={(on) =>
            setPicked(
              on
                ? new Set(
                    suggestions.suggestions
                      .filter((s) => {
                        const now = currentValues.get(s.itemId);
                        return !now || now.priority !== s.priority || now.size !== s.size;
                      })
                      .map((s) => s.itemId)
                  )
                : new Set()
            )
          }
          onApply={() => void applySuggestions()}
          onClose={() => {
            setSuggestions(null);
            setPicked(new Set());
          }}
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
