/**
 * When the board is allowed to refresh itself.
 *
 * WHY THIS IS NOT THE REFERENCE'S POLL
 *
 * `szmidtpiotr/claude-github-issue` refreshes on a flat 30-second timer:
 *
 *   const schedule = () => {
 *     fetchRef.current = setTimeout(() => { fetchIssues().then(schedule); }, POLL_INTERVAL_MS);
 *   };
 *
 * Two things in that are worth copying outright. It reschedules **after** the fetch
 * resolves rather than on a bare `setInterval`, so a slow request can never stack ticks
 * behind it. And the whole chain is torn down on unmount, so a hidden tab stops asking.
 *
 * The rest does not survive contact with this board, because this board has state the
 * reference's does not:
 *
 *  - **Optimistic writes.** A drag patches the card locally and the mutation follows. A
 *    poll that lands in that window answers with GitHub's copy — which is still the *old*
 *    column — and the card jumps back under the reader's cursor, indistinguishable from
 *    the rejection the rollback exists to show. This is the exact objection recorded in
 *    `cache.ts` when the poll was first declined, and it is still right; what changed is
 *    that it argues for a *guarded* poll rather than for no poll.
 *  - **Drag in flight.** Re-rendering a column mid-drag moves the drop target out from
 *    under the pointer.
 *  - **Open modals and the suggestions panel.** The item modal reads from `board.items`,
 *    so a refresh underneath it can swap the fields being edited. The suggestions panel is
 *    worse: its rows are keyed to item ids the reader has been ticking, and a refresh
 *    resets nothing visibly while changing what "apply" would write.
 *
 * So the timer is the reference's and the gate is this board's. Everything below is one
 * question — *is anything happening that a redraw would interrupt?* — and the honest
 * default when the answer is yes is to skip the tick entirely rather than to queue it:
 * the next one is thirty seconds away, and the reader dragging cards is not waiting on it.
 */

/** The reference's interval, kept deliberately. It is a good number and this is a fork of its idea. */
export const REFRESH_INTERVAL_MS = 30_000;

/** Everything that makes a redraw unwelcome right now. */
export interface RefreshGate {
  /** A write is in flight, so GitHub's copy is knowably behind the screen. */
  writesPending: boolean;
  /** A card is being dragged. */
  dragging: boolean;
  /** The item modal, the settings modal, the new-issue modal, or the suggestions panel. */
  overlayOpen: boolean;
  /** An AI request or a batch apply is running. */
  working: boolean;
  /** The host tab is not on screen. */
  hidden: boolean;
  /** A manual refresh or the first load is already running. */
  loading: boolean;
}

/**
 * Whether this tick should actually fetch.
 *
 * Written as a single `every` over the gate rather than a chain of `||`s so that adding a
 * reason later is a one-line change in one place, and so the reason a tick was skipped can
 * be named if this ever needs to explain itself.
 */
export function canRefresh(gate: RefreshGate): boolean {
  return !(gate.writesPending || gate.dragging || gate.overlayOpen || gate.working || gate.hidden || gate.loading);
}

/**
 * "Updated 2m ago", for the header.
 *
 * A board that silently reloads itself is a board with no way to tell a live view from a
 * frozen one — which is precisely the failure the manual Refresh button used to make
 * impossible to have, because pressing it *was* the evidence. Replacing a manual action
 * with an automatic one removes that evidence unless something puts it back.
 *
 * Seconds are rounded away above a minute. The number is read to answer "is this current",
 * not to be arithmetic on.
 */
export function agoLabel(since: number | null, now: number): string {
  if (since === null) return '';
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
