import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTtlCache } from "./ttlCache.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTtlCache", () => {
  it("returns the value before TTL and undefined after it expires", () => {
    const cache = createTtlCache({ ttlMs: 1000 });
    cache.set("a", 42);

    expect(cache.get("a")).toBe(42);

    // Just before expiry it is still live.
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe(42);

    // At/after ttlMs it is gone (and removed from the store).
    vi.advanceTimersByTime(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const cache = createTtlCache({ ttlMs: 10_000, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);

    // Inserting a 4th distinct key evicts the oldest ("a").
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("is true LRU: a get() on the oldest key spares it from eviction", () => {
    const cache = createTtlCache({ ttlMs: 10_000, maxEntries: 3 });
    cache.set("a", 1); // oldest
    cache.set("b", 2);
    cache.set("c", 3);

    // Touch "a" so it becomes the most-recently-used; "b" is now oldest.
    expect(cache.get("a")).toBe(1);

    // Insert a 4th key: the next-oldest ("b") is evicted, "a" survives.
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("clear() empties the cache", () => {
    const cache = createTtlCache({ ttlMs: 10_000, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});
