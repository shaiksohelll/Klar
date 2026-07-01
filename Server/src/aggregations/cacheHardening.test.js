import { describe, it, expect } from "vitest";
import { createTtlCache } from "../lib/ttlCache.js";

// ── Cache-hardening unit tests ─────────────────────────────────────────────
// The four in-memory aggregation caches share createTtlCache (a bounded LRU +
// TTL helper). These tests pin the invariant the hardening relies on: the
// store never grows past maxEntries, and the oldest key is evicted on insert.
//
// The taxonomy gate (only writing known skill/role keys) is verified end-to-end
// against the real aggregations in their own DB-backed suites; here we lock the
// eviction guarantee that caps memory even if a gate is ever bypassed.

describe("cache hardening — createTtlCache eviction cap", () => {
  it("never grows past maxEntries, evicting the oldest on each insert", () => {
    const cap = 500;
    const cache = createTtlCache({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: cap });

    // Spray 5x the cap of unique keys, mimicking an attacker sending junk
    // skill/role values that slipped past a gate.
    for (let i = 0; i < cap * 5; i++) {
      cache.set(`junk-key-${i}`, i);
    }

    // The store is hard-capped regardless of how many uniques were inserted.
    expect(cache.size).toBe(cap);

    // The oldest keys were evicted; only the most recent `cap` survive.
    expect(cache.get("junk-key-0")).toBeUndefined();
    expect(cache.get(`junk-key-${cap - 1}`)).toBeUndefined();
    expect(cache.get(`junk-key-${cap * 5 - 1}`)).toBe(cap * 5 - 1);
    expect(cache.get(`junk-key-${cap * 5 - cap}`)).toBe(cap * 5 - cap);
  });

  it("evicts exactly the oldest entry once the cap is exceeded by one", () => {
    const cache = createTtlCache({ ttlMs: 10_000, maxEntries: 2 });
    cache.set("oldest", 1);
    cache.set("middle", 2);
    expect(cache.size).toBe(2);

    cache.set("newest", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("oldest")).toBeUndefined();
    expect(cache.get("middle")).toBe(2);
    expect(cache.get("newest")).toBe(3);
  });
});
