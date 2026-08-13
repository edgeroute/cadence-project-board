import type { BoardData, ProjectItem } from './types';

/**
 * Holding a just-created card on the board until GitHub admits it exists.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * Projects v2 is eventually consistent on the create path. `addProjectV2ItemById` returns
 * the new item's id, and the project's `items` connection then does not include it for
 * roughly two to three seconds. Measured against the live board, polling as fast as the
 * read completes:
 *
 *     +1333ms  absent
 *     +2432ms  absent
 *     +3516ms  present
 *
 * The board refetches the moment the create returns, so it read a board that genuinely did
 * not contain the card and drew exactly that — the reader's chosen column, without their
 * issue in it. Two real issues were filed this way before anyone realised they had worked.
 *
 * WHY A HOLD RATHER THAN A DELAY
 *
 * Waiting three seconds and then refetching would paper over the measurement taken today
 * and break on the day GitHub is slower, which is precisely the class of fix that fails
 * quietly. Holding the card until a read comes back carrying it is correct at any latency,
 * and self-clearing: the moment the server's own copy contains the item, the local one is
 * dropped and never consulted again.
 *
 * WHY NOT SIMPLY TRUST THE 30-SECOND POLL
 *
 * It would arrive eventually. "Eventually" is up to half a minute of a board that appears
 * to have thrown away what the reader just wrote, which is the report this fixes.
 */

/**
 * How long a held card may survive without the server ever confirming it.
 *
 * A backstop, not a timing assumption — the hold clears on confirmation, and this only
 * decides how long a card that is *never* confirmed lingers. That happens if the issue is
 * deleted, or removed from the project, in the seconds after being filed. Generous against
 * the ~3s the lag actually runs to, and short enough that a phantom card cannot outlive the
 * reader's memory of having created it.
 */
export const HOLD_MS = 60_000;

export interface HeldItem {
  item: ProjectItem;
  /** When it was created, for {@link HOLD_MS}. */
  at: number;
}

/**
 * Merge a held card into a freshly-read board.
 *
 * Returns the board unchanged, and reports `settled: true`, as soon as the server's copy
 * carries the item — that is the caller's signal to stop holding it. Matching is by item id
 * (`PVTI_…`), the only identifier that is stable across both sides of this.
 *
 * Ordering is deliberate: the held card goes to the **front**. It is the newest thing on the
 * board and every sort this plugin offers puts newest first by default, so appending it
 * would file it under the oldest card in its column for the two seconds it is held and then
 * make it jump. Sorting runs over the merged list afterwards regardless; this only decides
 * where an unsorted list would put it.
 */
export function mergeHeld(
  board: BoardData,
  held: HeldItem | null,
  now: number
): { board: BoardData; settled: boolean } {
  if (!held) return { board, settled: false };
  if (board.items.some((i) => i.id === held.item.id)) return { board, settled: true };
  if (now - held.at > HOLD_MS) return { board, settled: true };
  return { board: { ...board, items: [held.item, ...board.items] }, settled: false };
}
