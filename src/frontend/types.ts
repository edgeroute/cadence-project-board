/**
 * The shapes the board is drawn from. Shared with the backend, which imports this
 * file directly — one definition of the wire format rather than two that can drift.
 *
 * The single most important difference from the plugin this one is modelled on
 * (szmidtpiotr/claude-github-issue, which boards repo issues by label): in Projects
 * v2 an item is NOT an issue. It is a `ProjectV2Item` — a join row with its own
 * `PVTI_…` node id — that happens to point at an issue. Every mutation addresses the
 * item id; the issue number is display text and cannot be used to write anything.
 * Conflating the two is the mistake this comment exists to prevent.
 */

/** One option of a single-select field — "Backlog", "P1", "XS". */
export interface FieldOption {
  id: string;
  name: string;
}

/** A single-select project field. The only field type this plugin writes. */
export interface ProjectField {
  id: string;
  name: string;
  options: FieldOption[];
}

export interface IssueLabel {
  name: string;
  color: string;
}

export interface IssueActor {
  login: string;
  avatarUrl: string;
}

/** The issue (or PR) an item points at. Null for draft items, which have no content. */
export interface ItemContent {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  updatedAt: string;
  repository: string;
  author: IssueActor | null;
  labels: IssueLabel[];
  assignees: IssueActor[];
  comments: number;
  isPullRequest: boolean;
}

export interface ProjectItem {
  /** The `PVTI_…` id. This is what mutations address — see the note at the top. */
  id: string;
  /** Draft items have no issue behind them; they are rendered but not linked. */
  content: ItemContent | null;
  /** Draft-only title, from `DraftIssue`. */
  draftTitle: string | null;
  /**
   * fieldId → optionId, for single-select fields only. Deliberately keyed by id
   * rather than by name: names are user-editable on github.com and two fields can
   * share one ("Status" on two projects), while ids are stable.
   */
  singleSelect: Record<string, string>;
}

export interface BoardData {
  projectId: string;
  title: string;
  url: string;
  fields: ProjectField[];
  items: ProjectItem[];
}

/** What the backend answers with when the project has not been configured yet. */
export interface NotConfigured {
  notConfigured: true;
  error: string;
}

export type BoardResponse = BoardData | NotConfigured;

export function isNotConfigured(r: BoardResponse): r is NotConfigured {
  return (r as NotConfigured).notConfigured === true;
}

export interface BoardConfig {
  owner: string;
  projectNumber: number;
  enabled: boolean;
  /** Present only when the config file holds one; never echoed back to the frontend. */
  hasToken?: boolean;
  /** Where the token came from, so the settings UI can explain itself. */
  tokenSource?: 'config' | 'env' | 'none';
}

export interface PluginAPI {
  context: {
    theme: 'dark' | 'light';
    project: { name: string; path: string } | null;
    session: { id: string; title: string } | null;
  };
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
  onContextChange(cb: () => void): () => void;
}

/**
 * The three fields this plugin writes, by name.
 *
 * Looked up by name at runtime rather than by hardcoded id, which is what lets the
 * same public bundle serve any project: the ids are per-project (`PVTSSF_…` encodes
 * the project) and baking one in would tie the repo to a single account's board.
 * A project missing any of these simply doesn't render that control.
 */
export const STATUS_FIELD = 'Status';
export const PRIORITY_FIELD = 'Priority';
export const SIZE_FIELD = 'Size';

export function fieldByName(fields: ProjectField[], name: string): ProjectField | null {
  const lowered = name.toLowerCase();
  return fields.find((f) => f.name.toLowerCase() === lowered) ?? null;
}

/**
 * The columns, in the order github.com shows them.
 *
 * Derived from the live `Status` options rather than from a constant, so a column
 * added on github.com appears here on the next refresh instead of silently swallowing
 * every item assigned to it. The reference plugin's five-column `COLUMNS` constant is
 * the thing this replaces, and the reason it could afford one is that its columns were
 * labels it defined itself.
 *
 * The leading `null` column is items with no Status set. GitHub shows these in a "No
 * Status" column and so do we — without it they would vanish from a board that claims
 * to show everything, which is the worst failure a board can have.
 */
export const NO_STATUS = '__none__';

export interface Column {
  /** The option id, or `NO_STATUS`. */
  id: string;
  name: string;
}

export function columnsFrom(fields: ProjectField[]): Column[] {
  const status = fieldByName(fields, STATUS_FIELD);
  const options = status ? status.options.map((o) => ({ id: o.id, name: o.name })) : [];
  return [{ id: NO_STATUS, name: 'No Status' }, ...options];
}

/** Which column an item sits in. `NO_STATUS` when the field is unset or absent. */
export function columnIdFor(item: ProjectItem, statusFieldId: string | null): string {
  if (!statusFieldId) return NO_STATUS;
  return item.singleSelect[statusFieldId] ?? NO_STATUS;
}

/** The title to draw on a card — the issue's, or a draft's own. */
export function itemTitle(item: ProjectItem): string {
  return item.content?.title ?? item.draftTitle ?? 'Untitled';
}

/** Cards are searched on number, title and repository. */
export function itemMatches(item: ProjectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const c = item.content;
  if (c && (`#${c.number}`.includes(q) || String(c.number) === q)) return true;
  if (c && c.repository.toLowerCase().includes(q)) return true;
  return itemTitle(item).toLowerCase().includes(q);
}
