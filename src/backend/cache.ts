/**
 * A very small TTL cache over the board read.
 *
 * The board is one GraphQL query, but Projects v2 is scored against a points budget
 * rather than a flat request count, and the tab re-reads on every mount, focus and
 * context change. Without this, switching away and back is a fresh query every time.
 *
 * Deliberately *not* a background poll. The reference plugin refreshes every 30
 * seconds; on a board someone is dragging cards around, a poll that lands mid-drag
 * re-renders the column under the cursor. Refresh is manual, plus an automatic
 * invalidation after any write — see `invalidate`.
 */
interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

/** Long enough to absorb a tab switch, short enough that github.com edits show up. */
export const TTL_MS = 20_000;

export function get<T>(key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.value as T;
}

export function set<T>(key: string, value: T, ttl = TTL_MS): void {
  store.set(key, { value, expires: Date.now() + ttl });
}

/**
 * Drop a project's cached board.
 *
 * Called after every write. The alternative — patching the cached copy in place to
 * match the mutation — is how a cache starts lying: the frontend has already applied
 * the change optimistically, so the only job left for the cache is to not serve a
 * stale copy to the *next* read.
 */
export function invalidate(key: string): void {
  store.delete(key);
}

export function clear(): void {
  store.clear();
}
