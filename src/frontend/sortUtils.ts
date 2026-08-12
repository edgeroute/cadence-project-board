import type { ProjectItem, ProjectField } from './types';
import { itemTitle, fieldByName, PRIORITY_FIELD, SIZE_FIELD } from './types';

/**
 * Ordering the cards inside a column.
 *
 * Ported in shape from szmidtpiotr/claude-github-issue's `sortIssues` (MIT), with the
 * comparators rewritten for this board's data: it sorts issues by label-derived priority,
 * this sorts project items by a real single-select field's **option order**.
 *
 * That last point is the whole difference. A label-based priority has to be mapped
 * through a hardcoded `{high: 0, medium: 1, low: 2}` table, which only knows the words
 * its author thought of. A single-select field already carries its options in the order
 * the project owner arranged them on github.com, so `P0 < P1 < P2` — or
 * `Critical < Major < Minor`, or any other scheme — falls out of the field itself with
 * nothing to keep in sync.
 */

export type SortKey = 'manual' | 'number' | 'updated' | 'created' | 'comments' | 'title' | 'priority' | 'size';
export type SortDir = 'asc' | 'desc';

export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/**
 * `manual` is the board's own order, and it is the default.
 *
 * Projects v2 items come back in the order the owner arranged them, and that order is
 * information — it is how somebody left the board. A view that silently re-sorted on
 * open would throw that away and make the plugin disagree with github.com for no reason
 * the reader asked for.
 */
export const DEFAULT_SORT: Sort = { key: 'manual', dir: 'desc' };

export const SORT_LABELS: Record<SortKey, string> = {
  manual: 'Board order',
  number: 'Number',
  updated: 'Updated',
  created: 'Created',
  comments: 'Comments',
  title: 'Title',
  priority: 'Priority',
  size: 'Size'
};

/** Which keys make sense given the fields this project actually defines. */
export function availableSortKeys(fields: ProjectField[]): SortKey[] {
  const keys: SortKey[] = ['manual', 'number', 'updated', 'created', 'comments', 'title'];
  if (fieldByName(fields, PRIORITY_FIELD)) keys.push('priority');
  if (fieldByName(fields, SIZE_FIELD)) keys.push('size');
  return keys;
}

/**
 * An item's position in a field's option list — its rank, not its name.
 *
 * Unset sorts **last** under either direction, by returning a rank past the end rather
 * than by being special-cased in the comparator. "No priority yet" is not more urgent
 * than P2 and it is not less urgent than P0; it is absent, and absent belongs at the
 * bottom of a list someone is reading top-down for what to do next.
 */
function optionRank(item: ProjectItem, field: ProjectField | null): number {
  if (!field) return Number.MAX_SAFE_INTEGER;
  const optionId = item.singleSelect[field.id];
  if (!optionId) return Number.MAX_SAFE_INTEGER;
  const i = field.options.findIndex((o) => o.id === optionId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * A stable sort of one column's items.
 *
 * `dir` flips every comparator except the unset-last rule above, which is why that rule
 * lives in `optionRank` rather than in the comparison: a reader who reverses a Priority
 * sort wants P2 first, not a block of unset items first.
 */
export function sortItems(items: ProjectItem[], sort: Sort, fields: ProjectField[]): ProjectItem[] {
  if (sort.key === 'manual') return items;

  const priority = fieldByName(fields, PRIORITY_FIELD);
  const size = fieldByName(fields, SIZE_FIELD);
  const flip = sort.dir === 'asc' ? -1 : 1;

  const compare = (a: ProjectItem, b: ProjectItem): number => {
    switch (sort.key) {
      case 'number':
        return (b.content?.number ?? 0) - (a.content?.number ?? 0);
      case 'updated':
        return time(b.content?.updatedAt) - time(a.content?.updatedAt);
      case 'created':
        return time(b.content?.createdAt) - time(a.content?.createdAt);
      case 'comments':
        return (b.content?.comments ?? 0) - (a.content?.comments ?? 0);
      case 'title':
        // Negated so `desc` — the shared default direction — reads A→Z for a title,
        // which is what anyone picking "Title" expects to see first.
        return -itemTitle(a).localeCompare(itemTitle(b));
      case 'priority':
        return optionRank(b, priority) - optionRank(a, priority);
      case 'size':
        return optionRank(b, size) - optionRank(a, size);
      default:
        return 0;
    }
  };

  /*
    Sorted by index as a tiebreak rather than by `Array.sort` alone.

    `Array.prototype.sort` is specified as stable, but "stable" only preserves the order
    of items the comparator calls equal *within one call*. This function runs per column
    on a freshly filtered array, so without an explicit tiebreak two items with the same
    priority could swap places between renders as the filter changes what precedes them.
    Cards quietly rearranging under a cursor is worse than any ordering.
  */
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const c = compare(a.item, b.item) * flip;
      return c !== 0 ? c : a.index - b.index;
    })
    .map((x) => x.item);
}
