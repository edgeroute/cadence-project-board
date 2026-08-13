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
import { NewIssueModal, type NewIssueInput } from './NewIssueModal';
import { agoLabel, canRefresh, REFRESH_INTERVAL_MS } from './refreshPolicy';
import { mergeHeld, type HeldItem } from './pendingInsert';
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
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<ConfigShape | null>(null);
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [settingsError, setSettingsError] = React.useState('');
  const [newIssue, setNewIssue] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState('');
  /**
   * Something that went right, said in the bar the errors use.
   *
   * Separate state rather than a reuse of `error`, because the one thing this reports —
   * "#231 is open and on the board" — is the opposite of an error and carries a link. Two
   * states, one strip: they never coexist in practice, because the create that sets this
   * clears that.
   */
  const [notice, setNotice] = React.useState<{ text: string; url: string } | null>(null);
  /** When the board on screen was last answered for. Drives the "updated" label. */
  const [loadedAt, setLoadedAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [dragging, setDragging] = React.useState(false);
  /**
   * A card filed seconds ago that GitHub has not yet admitted into the project's `items`
   * connection — see `pendingInsert`. A ref rather than state: it is consulted inside
   * `load`, and as state it would have to be a dependency of it, which would rebuild the
   * fetch callback and restart the refresh timer every time an issue was created.
   */
  const heldRef = React.useRef<HeldItem | null>(null);

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

  /**
   * Fetch the board.
   *
   * `quiet` is what makes the automatic refresh bearable. Without it every tick flips
   * `loading`, which relabels the Refresh button to "Loading…" and — on a board that has
   * not arrived yet — swaps the whole view for the loading panel. A background refresh
   * that redraws the chrome every thirty seconds looks like a fault, not like being
   * up to date. A quiet load also leaves `error` alone until it has something new to say,
   * so a failed tick does not silently clear a message the reader has not read yet.
   */
  const load = React.useCallback(
    async (fresh: boolean, quiet = false) => {
      if (!projectPath) {
        setLoading(false);
        setNotConfigured('Open a project to see its board.');
        return;
      }
      if (!quiet) {
        setLoading(true);
        setError('');
      }
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
          // A just-created card rides along until the server's own copy carries it. Every
          // read goes through here — the manual Refresh, the 30-second poll, the refetch the
          // create itself fires — so there is one place where a held card can be dropped.
          const merged = mergeHeld(res, heldRef.current, Date.now());
          if (merged.settled) heldRef.current = null;
          setBoard(merged.board);
          // The server's stamp, not this moment: a response served from the 20-second cache
          // is a fresh delivery of an older board. See `BoardData.fetchedAt`.
          setLoadedAt(res.fetchedAt ?? Date.now());
        }
      } catch (e) {
        setError((e as Error).message || 'Could not reach the plugin backend.');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api, projectPath]
  );

  React.useEffect(() => {
    void load(false);
  }, [load]);

  /**
   * Is a drag happening right now?
   *
   * On `document` rather than threaded down through `Board` → `Column` → `Card`: the
   * question is "is the reader dragging anything", which is a fact about the page and not
   * about any one column, and `dragend` fires on the source element even when the drop
   * lands outside the board entirely. A per-column boolean would miss exactly that case
   * and leave the poll suspended forever.
   */
  React.useEffect(() => {
    const start = () => setDragging(true);
    const end = () => setDragging(false);
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);

  /**
   * The gate the automatic refresh is held behind — see `refreshPolicy`.
   *
   * Kept in a ref as well as computed for render, because the timer chain below is
   * installed once and must read the *current* answer rather than the one that was true
   * when it was scheduled. Re-subscribing the timer on every state change would restart
   * the interval each time a card was ticked, which is a poll that never actually fires.
   */
  const gateRef = React.useRef({
    writesPending: false,
    dragging: false,
    overlayOpen: false,
    working: false,
    hidden: false,
    loading: false
  });
  gateRef.current = {
    writesPending: pending.size > 0,
    dragging,
    overlayOpen: Boolean(selectedId || settings || suggestions || newIssue),
    working: prioritizing || applying || creating || savingSettings,
    hidden: typeof document !== 'undefined' && document.hidden,
    loading
  };

  /**
   * The automatic refresh.
   *
   * The timer chain is the reference plugin's — rescheduled after each fetch resolves
   * rather than a bare `setInterval`, so a slow request cannot stack ticks behind it. What
   * is added is the gate: a tick that arrives while something is happening skips its fetch
   * and simply books the next one, because the interruption costs more than the staleness.
   *
   * The dependency list is deliberately just `load`. Everything else the tick consults is
   * read through `gateRef` at fire time, so the chain survives the reader dragging cards
   * and opening modals instead of being torn down and restarted by each one.
   */
  React.useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        const tick = canRefresh(gateRef.current) ? load(false, true) : Promise.resolve();
        void tick.finally(schedule);
      }, REFRESH_INTERVAL_MS);
    };
    schedule();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [load, projectPath]);

  /**
   * Coming back to the tab refreshes immediately rather than waiting out the interval.
   *
   * Ticks are skipped while the tab is hidden — there is no one to show them to, and the
   * board is re-read on mount anyway — so without this, returning to a tab left open
   * overnight would show yesterday's board for up to thirty seconds. That is the single
   * most likely moment for the board to be wrong and the most likely moment for someone to
   * be looking at it.
   */
  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && canRefresh(gateRef.current)) void load(false, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  /**
   * Ticks the "updated 2m ago" label along.
   *
   * Its own slow timer rather than a re-render of the board: the label is the only thing on
   * screen that changes with the clock, and tying it to the refresh would leave it reading
   * "just now" for the entire thirty seconds between fetches.
   */
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

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
   * Write the ticked suggestions, in one request.
   *
   * This used to loop over `applyField` — the same call a drag makes — so that each write
   * got the optimistic patch, the rollback and the label mirror for free. It was tidy and
   * it was far too slow: every one of those calls refetched the entire board from GitHub
   * to resolve ids that were identical each time, and there are two writes per item, so
   * seventeen items meant thirty-four board fetches and about ten seconds per issue.
   *
   * `/fields` resolves against one snapshot and applies them all. The board is refreshed
   * once at the end rather than patched per write, because after a batch the server's
   * answer is cheaper and more truthful than replaying every change locally.
   *
   * Writes are still serial — on the server now, and for the same reason as before:
   * GitHub's secondary rate limits treat parallel mutations as abuse.
   */
  const applySuggestions = React.useCallback(async () => {
    if (!suggestions || !projectPath) return;
    setApplying(true);

    const writes: { itemId: string; field: string; option: string }[] = [];
    for (const s of suggestions.suggestions) {
      if (!picked.has(s.itemId)) continue;
      if (s.priority) writes.push({ itemId: s.itemId, field: PRIORITY_FIELD, option: s.priority });
      if (s.size) writes.push({ itemId: s.itemId, field: SIZE_FIELD, option: s.size });
    }

    try {
      const res = (await api.rpc('POST', `/fields?path=${encodeURIComponent(projectPath)}`, { writes })) as {
        ok?: boolean;
        error?: string;
        outcomes?: { itemId: string; field: string; ok: boolean; error?: string; warning?: string }[];
      };

      if (!res.ok) {
        setError(res.error || 'Could not apply the suggestions.');
      } else {
        // One line naming what failed, rather than a message per item: on a batch this
        // size a stack of identical errors buries the count of what did land.
        const failed = (res.outcomes ?? []).filter((o) => !o.ok);
        const warned = (res.outcomes ?? []).filter((o) => o.ok && o.warning);
        if (failed.length) {
          setError(`${failed.length} of ${res.outcomes!.length} changes failed — ${failed[0].error}`);
        } else if (warned.length) {
          setError(`Applied, but ${warned.length} label${warned.length === 1 ? '' : 's'} could not be updated.`);
        }
      }
    } catch (e) {
      setError((e as Error).message || 'Could not apply the suggestions.');
    } finally {
      setApplying(false);
      setSuggestions(null);
      setPicked(new Set());
      // `fresh`, not the cache: the writes just invalidated it server-side, and a batch
      // is exactly the case where showing stale values back to the reader would look
      // like the apply silently did nothing.
      void load(true);
    }
  }, [api, load, picked, projectPath, suggestions]);

  /**
   * File an issue and put it on the board.
   *
   * Not optimistic, unlike every other write here. A drag knows exactly what the board will
   * look like afterwards — one field, one value — but a new issue has a number, a URL, an
   * author and a timestamp that only GitHub can assign, and a card drawn from guesses at
   * those is a card claiming things that are not yet true. So the modal stays up and busy
   * until the server answers, and the board is refetched rather than patched.
   *
   * The failure is reported *into the modal* rather than into the page's error bar, because
   * the modal is still open and still holds everything the reader typed. Closing it to show
   * an error elsewhere would throw away the draft in order to explain why it was not saved.
   */
  const createIssue = React.useCallback(
    async (input: NewIssueInput) => {
      if (!projectPath) return;
      setCreating(true);
      setCreateError('');
      try {
        const res = (await api.rpc('POST', `/issues?path=${encodeURIComponent(projectPath)}`, input)) as {
          ok?: boolean;
          error?: string;
          warning?: string;
          item?: ProjectItem;
          issue?: { number: number; url: string; title: string };
        };
        if (res.error || !res.ok || !res.issue || !res.item) {
          setCreateError(res.error || 'Could not open the issue.');
          return;
        }
        setNewIssue(false);
        setNotice({ text: `Opened #${res.issue.number} — ${res.issue.title}`, url: res.issue.url });

        /*
          Put the card on the board now, from the server's answer, and go on holding it until
          a read comes back carrying it.

          Projects v2 does not list a just-added item for two to three seconds, so the
          refetch below reads a board without it — which is how an issue that filed perfectly
          appeared to vanish. See `pendingInsert`. Nothing here is invented: every field came
          from GitHub's own reply to the mutation, or from the Status write it confirmed.
        */
        const held: HeldItem = { item: res.item, at: Date.now() };
        heldRef.current = held;
        setBoard((b) => (b ? mergeHeld(b, held, Date.now()).board : b));

        // `fresh`, and *after* the local insert rather than instead of it: the server dropped
        // its cache on the write, so this is the read that will eventually carry the real
        // card and retire the held one.
        await load(true);
        // Set last, because a non-quiet `load` clears `error` on its way in — reporting the
        // Status warning before it would have wiped the one message explaining why the card
        // is not in the column the reader picked.
        if (res.warning) setError(res.warning);
      } catch (e) {
        setCreateError((e as Error).message || 'Could not open the issue.');
      } finally {
        setCreating(false);
      }
    },
    [api, load, projectPath]
  );

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
              {/* The evidence that the board is live. Pressing Refresh used to be its own
                  proof that the view was current; an automatic refresh takes that away
                  unless something puts it back. See `agoLabel`. */}
              {loadedAt !== null && <span className="cpb-updated"> · updated {agoLabel(loadedAt, now)}</span>}
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
          {/* Still here, and still the first thing anyone reaches for after editing on
              github.com. The automatic refresh makes it unnecessary rather than redundant:
              it is also the way to skip the gate, which is exactly what a reader who has
              just moved something in another tab wants. */}
          <button className="cpb-btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {board && (
            <button
              className="cpb-btn cpb-btn--primary"
              onClick={() => {
                setCreateError('');
                setNewIssue(true);
              }}
              title="Open a new issue and put it on this board"
            >
              New issue
            </button>
          )}
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

      {/* `role="status"` and not `alert`: this reports something that went right, and an
          alert interrupts a screen reader mid-sentence to say so. The link is the point of
          the message — a number with no way to reach it is a fact, not a result. */}
      {notice && (
        <div className="cpb-notice cpb-error--bar" role="status">
          <span>
            {notice.text}{' '}
            <a href={notice.url} target="_blank" rel="noreferrer noopener">
              Open on GitHub
            </a>
          </span>
          <button className="cpb-error-dismiss" onClick={() => setNotice(null)} aria-label="Dismiss">
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

      {newIssue && board && (
        <NewIssueModal
          items={board.items}
          fields={board.fields}
          owner={settings?.owner ?? ''}
          submitting={creating}
          error={createError}
          onCreate={(input) => void createIssue(input)}
          onClose={() => setNewIssue(false)}
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
