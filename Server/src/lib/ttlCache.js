// Bounded in-memory cache: TTL + LRU eviction.
//
// Several aggregations cache results keyed partly on arbitrary user input
// (skill / role / :name). A plain Map grows unbounded, so spraying unique keys
// is a memory-growth vector on a small single instance. createTtlCache caps the
// number of live entries and evicts the least-recently-used key once full.
//
// Two eviction triggers:
//   1. TTL - an entry older than ttlMs is treated as absent (and deleted on the
//            read that observes it expired).
//   2. LRU - after an insert, the oldest entries are evicted until the store
//            holds at most maxEntries. Recency is tracked via Map insertion
//            order: every live get() re-inserts its key (delete + set) so it
//            becomes the newest, and set() always inserts last. The oldest key
//            is therefore store.keys().next().value.
//
// Stored values are opaque - the helper never inspects or reshapes them, so
// callers get back exactly what they put in.

/**
 * Create a bounded LRU + TTL cache.
 *
 * @param {{ ttlMs: number, maxEntries?: number }} opts
 * @returns {{ get(key: any): any, set(key: any, value: any): void, clear(): void, readonly size: number }}
 */
export function createTtlCache({ ttlMs, maxEntries = 500 }) {
  // key -> { value, expiresAt }
  const store = new Map();

  return {
    /**
     * Return the cached value for key, or undefined if absent/expired.
     * A live hit refreshes recency (moves the key to newest) for true LRU.
     */
    get(key) {
      const entry = store.get(key);
      if (entry === undefined) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key); // expired - drop it
        return undefined;
      }
      // Refresh recency: re-insert so this key becomes the newest.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    /**
     * Insert/replace key with a fresh expiry, then evict oldest entries
     * until the store holds at most maxEntries.
     */
    set(key, value) {
      // Delete first so a replaced key also moves to newest position.
      store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },

    /** Empty the cache (used by the clearXCache() ingest hooks). */
    clear() {
      store.clear();
    },

    get size() {
      return store.size;
    },
  };
}
