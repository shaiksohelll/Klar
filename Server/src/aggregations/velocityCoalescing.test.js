import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import SkillSnapshot from "../models/SkillSnapshot.js";
import {
  _loadVelocityContext,
  clearTrendingCaches,
} from "./trendingSkills.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await SkillSnapshot.deleteMany({});
  clearTrendingCaches(); // flush the coalescing cache between tests
});

// ── Helpers ────────────────────────────────────────────────────────
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

/** Seed two snapshot batches with a realistic gap. */
async function seedSnapshots() {
  const latestCapturedAt = daysAgo(0);
  const baseCapturedAt = daysAgo(10);
  await SkillSnapshot.insertMany([
    { skill: "react", count30: 50, capturedAt: latestCapturedAt },
    { skill: "vue",   count30: 20, capturedAt: latestCapturedAt },
    { skill: "react", count30: 40, capturedAt: baseCapturedAt },
    { skill: "vue",   count30: 25, capturedAt: baseCapturedAt },
  ]);
}

/** Seed snapshots with gap < 2 days so velocity returns tooClose. */
async function seedTooCloseSnapshots() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  await SkillSnapshot.insertMany([
    { skill: "react", count30: 50, capturedAt: now },
    { skill: "react", count30: 48, capturedAt: yesterday },
  ]);
}

// ── Tests ──────────────────────────────────────────────────────────
describe("_loadVelocityContext — coalescing", () => {
  it("returns null when no snapshots exist", async () => {
    const ctx = await _loadVelocityContext();
    expect(ctx).toBeNull();
  });

  it("returns nowMap/baseMap when snapshots have enough gap", async () => {
    await seedSnapshots();
    const ctx = await _loadVelocityContext();
    expect(ctx).not.toBeNull();
    expect(ctx.tooClose).toBe(false);
    expect(ctx.gapDays).toBeGreaterThanOrEqual(2);
    expect(ctx.nowMap.get("react")).toBe(50);
    expect(ctx.baseMap.get("react")).toBe(40);
  });

  it("concurrent calls hit the DB only once (coalescing)", async () => {
    await seedSnapshots();

    // Spy on the DB findOne used by _loadVelocityContext.
    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");

    // Fire 5 concurrent calls — they should all share one DB flight.
    const results = await Promise.all([
      _loadVelocityContext(),
      _loadVelocityContext(),
      _loadVelocityContext(),
      _loadVelocityContext(),
      _loadVelocityContext(),
    ]);

    // All 5 should resolve to the same (identical-reference) object.
    for (const r of results) {
      expect(r).toBe(results[0]);
    }

    // Total findOne calls must be well under 15 (= 3 per caller without coalescing).
    // We don't hard-code 3 because the exact count may change if the query
    // structure is refactored; we just prove coalescing happened.
    expect(findOneSpy.mock.calls.length).toBeLessThan(15);

    findOneSpy.mockRestore();
  });

  it("cached result is reused for subsequent calls", async () => {
    await seedSnapshots();

    // First call populates the cache.
    const first = await _loadVelocityContext();
    expect(first).not.toBeNull();

    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");

    // Second call (after the first has resolved and cached) should not hit DB.
    const second = await _loadVelocityContext();
    expect(second).toBe(first);
    expect(findOneSpy).not.toHaveBeenCalled();

    findOneSpy.mockRestore();
  });

  it("clearTrendingCaches invalidates the velocity context cache", async () => {
    await seedSnapshots();

    // Populate.
    await _loadVelocityContext();

    // Clear.
    clearTrendingCaches();

    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");

    // Must hit DB again.
    const ctx = await _loadVelocityContext();
    expect(ctx).not.toBeNull();
    expect(findOneSpy).toHaveBeenCalled();

    findOneSpy.mockRestore();
  });

  it("does NOT cache a stale result when clearTrendingCaches fires mid-flight", async () => {
    await seedSnapshots();

    // Fire the clear AFTER the in-flight promise is published (i.e. after the
    // IIFE has been assigned to _velocityCtxPromise and the first await has
    // suspended it). We do this by deferring via a resolved Promise so the
    // microtask runs while _loadVelocityContext() is awaiting its first query.
    let clearFired = false;
    const originalFindOne = SkillSnapshot.findOne.bind(SkillSnapshot);
    const spy = vi.spyOn(SkillSnapshot, "findOne").mockImplementation((...args) => {
      const query = originalFindOne(...args);
      if (!clearFired) {
        clearFired = true;
        // Defer the clear so it fires while the IIFE is awaiting, after the
        // promise is already stored in _velocityCtxPromise.
        Promise.resolve().then(() => clearTrendingCaches());
      }
      return query;
    });

    // This call starts a load; the clear fires mid-await.
    // The result should still be returned to THIS caller (no wasted work)...
    const ctx = await _loadVelocityContext();
    expect(ctx).not.toBeNull();
    expect(ctx.tooClose).toBe(false);

    spy.mockRestore();

    // ...but the cache must NOT have been populated with stale data.
    // A subsequent call must hit the DB again (fresh reload).
    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");
    const fresh = await _loadVelocityContext();
    expect(fresh).not.toBeNull();
    expect(findOneSpy).toHaveBeenCalled();

    findOneSpy.mockRestore();
  });

  it("caches a tooClose result (2nd call within TTL doesn't re-query)", async () => {
    await seedTooCloseSnapshots();

    // First call populates.
    const ctx = await _loadVelocityContext();
    expect(ctx).not.toBeNull();
    expect(ctx.tooClose).toBe(true);

    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");

    // Second call should hit cache, NOT the DB.
    const cached = await _loadVelocityContext();
    expect(cached).toBe(ctx);
    expect(findOneSpy).not.toHaveBeenCalled();

    findOneSpy.mockRestore();
  });

  it("does NOT cache a stale tooClose result when clear fires mid-flight", async () => {
    await seedTooCloseSnapshots();

    // Same deferred-clear pattern: fire AFTER the promise is in-flight.
    let clearFired = false;
    const originalFindOne = SkillSnapshot.findOne.bind(SkillSnapshot);
    const spy = vi.spyOn(SkillSnapshot, "findOne").mockImplementation((...args) => {
      const query = originalFindOne(...args);
      if (!clearFired) {
        clearFired = true;
        Promise.resolve().then(() => clearTrendingCaches());
      }
      return query;
    });

    // Load completes but clear happened mid-flight → result returned but NOT cached.
    const ctx = await _loadVelocityContext();
    expect(ctx).not.toBeNull();
    expect(ctx.tooClose).toBe(true);

    spy.mockRestore();

    // Next call must re-query (cache was not populated).
    const findOneSpy = vi.spyOn(SkillSnapshot, "findOne");
    const fresh = await _loadVelocityContext();
    expect(fresh).not.toBeNull();
    expect(findOneSpy).toHaveBeenCalled();

    findOneSpy.mockRestore();
  });
});
