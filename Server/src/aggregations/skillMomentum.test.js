import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import SkillSnapshot from "../models/SkillSnapshot.js";
import { computeSkillMomentum, clearMomentumCache } from "./skillMomentum.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────────
// computeSkillMomentum reads real SkillSnapshot rows, so we exercise it against
// an actual MongoDB via mongodb-memory-server. Each test starts from an empty
// collection and a cleared momentum cache so results are deterministic.
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
  clearMomentumCache();
});

// ── Helpers ───────────────────────────────────────────────────
// A day-bucketed snapshot row. `capturedAt` is intentionally omitted so these
// rows are treated purely as momentum rows (they are the ones with a `date`).
function snap({ skill, date, postingCount, disclosedCount = 0, salaryMidpointMedian = null }) {
  return { skill, date, postingCount, disclosedCount, salaryMidpointMedian };
}

// UTC-midnight day, `daysAgo` before a fixed "today" anchor. Using a fixed
// anchor keeps the two windows deterministic regardless of when the test runs.
const ANCHOR = new Date("2026-06-15T00:00:00.000Z");
function dayAgo(daysAgo) {
  const d = new Date(ANCHOR);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

describe("computeSkillMomentum — direction + deltas", () => {
  it("computes rising, falling, and flat deltaPct + direction across two windows", async () => {
    // window = 1 month. Current window: last ~30 days. Prior window: 30–60 days.
    // Latest bucket is `today` (ANCHOR). Prior reading is ~45 days ago.
    await SkillSnapshot.create([
      // rising: 100 -> 150 (+50%)
      snap({ skill: "react", date: dayAgo(45), postingCount: 100 }),
      snap({ skill: "react", date: dayAgo(0), postingCount: 150 }),
      // falling: 200 -> 100 (-50%)
      snap({ skill: "vue", date: dayAgo(45), postingCount: 200 }),
      snap({ skill: "vue", date: dayAgo(0), postingCount: 100 }),
      // flat: 80 -> 80 (0%)
      snap({ skill: "svelte", date: dayAgo(45), postingCount: 80 }),
      snap({ skill: "svelte", date: dayAgo(0), postingCount: 80 }),
    ]);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });

    expect(res.insufficientHistory).toBe(false);
    expect(res.asOf).toBe(dayAgo(0).toISOString());

    const react = res.risers.find((r) => r.skill === "react");
    expect(react).toMatchObject({
      current: 150,
      previous: 100,
      deltaAbs: 50,
      deltaPct: 50,
      direction: "rising",
    });

    const vue = res.fallers.find((f) => f.skill === "vue");
    expect(vue).toMatchObject({
      current: 100,
      previous: 200,
      deltaAbs: -100,
      deltaPct: -50,
      direction: "falling",
    });

    // flat skill appears in neither risers nor fallers.
    expect(res.risers.find((r) => r.skill === "svelte")).toBeUndefined();
    expect(res.fallers.find((f) => f.skill === "svelte")).toBeUndefined();
  });

  it('marks a skill present only in the current window as direction "new"', async () => {
    await SkillSnapshot.create([
      // baseline skill so the prior window is non-empty (history is sufficient).
      snap({ skill: "react", date: dayAgo(45), postingCount: 100 }),
      snap({ skill: "react", date: dayAgo(0), postingCount: 110 }),
      // rust exists ONLY in the current window.
      snap({ skill: "rust", date: dayAgo(0), postingCount: 40 }),
    ]);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });

    expect(res.insufficientHistory).toBe(false);
    const rust = res.risers.find((r) => r.skill === "rust");
    expect(rust).toMatchObject({
      current: 40,
      previous: 0,
      direction: "new",
      deltaPct: null,
    });
  });

  it("returns insufficientHistory:true (no throw) when only one window has data", async () => {
    await SkillSnapshot.create([
      snap({ skill: "react", date: dayAgo(0), postingCount: 150 }),
      snap({ skill: "vue", date: dayAgo(1), postingCount: 90 }),
    ]);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });

    expect(res.insufficientHistory).toBe(true);
    expect(res.fallers).toEqual([]);
    // current demand is surfaced with direction "new".
    expect(res.risers.every((r) => r.direction === "new")).toBe(true);
    expect(res.risers.find((r) => r.skill === "react")).toMatchObject({
      current: 150,
      direction: "new",
    });
  });

  it("returns the cold-start shape when there is no history at all", async () => {
    const res = await computeSkillMomentum({ windowMonths: 3, limit: 20 });
    expect(res).toEqual({
      risers: [],
      fallers: [],
      asOf: null,
      insufficientHistory: true,
    });
  });

  it("computes salaryDeltaPct from disclosed INR midpoint medians only", async () => {
    await SkillSnapshot.create([
      snap({
        skill: "react",
        date: dayAgo(45),
        postingCount: 100,
        disclosedCount: 40,
        salaryMidpointMedian: 1_000_000,
      }),
      snap({
        skill: "react",
        date: dayAgo(0),
        postingCount: 150,
        disclosedCount: 60,
        salaryMidpointMedian: 1_200_000,
      }),
    ]);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });
    const react = res.risers.find((r) => r.skill === "react");
    expect(react.salaryDeltaPct).toBe(20); // 1.0M -> 1.2M = +20%
  });

  it("leaves salaryDeltaPct null when either side lacks a median", async () => {
    await SkillSnapshot.create([
      snap({ skill: "react", date: dayAgo(45), postingCount: 100, salaryMidpointMedian: null }),
      snap({ skill: "react", date: dayAgo(0), postingCount: 150, salaryMidpointMedian: 1_200_000 }),
    ]);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });
    const react = res.risers.find((r) => r.skill === "react");
    expect(react.salaryDeltaPct).toBeNull();
  });
});

describe("computeSkillMomentum — caching", () => {
  it("returns the same payload on a cache hit for a known role", async () => {
    await SkillSnapshot.create([
      snap({ skill: "react", date: dayAgo(45), postingCount: 100 }),
      snap({ skill: "react", date: dayAgo(0), postingCount: 150 }),
    ]);

    const first = await computeSkillMomentum({ windowMonths: 1, role: "backend", limit: 20 });
    // Mutate the DB after the first call; a cache hit must ignore the change.
    await SkillSnapshot.deleteMany({});
    const second = await computeSkillMomentum({ windowMonths: 1, role: "backend", limit: 20 });

    expect(second).toEqual(first);
    // Same object identity confirms it came from the cache, not a recompute.
    expect(second).toBe(first);
  });

  it("does NOT cache an unknown role (recomputes every call)", async () => {
    await SkillSnapshot.create([
      snap({ skill: "react", date: dayAgo(45), postingCount: 100 }),
      snap({ skill: "react", date: dayAgo(0), postingCount: 150 }),
    ]);

    const first = await computeSkillMomentum({ windowMonths: 1, role: "not-a-real-role", limit: 20 });
    expect(first.risers.find((r) => r.skill === "react")).toBeTruthy();

    // Wipe data: if the unknown role had been cached, we'd still see react.
    await SkillSnapshot.deleteMany({});
    const second = await computeSkillMomentum({ windowMonths: 1, role: "not-a-real-role", limit: 20 });

    expect(second.insufficientHistory).toBe(true);
    expect(second.risers).toEqual([]);
    expect(second).not.toBe(first);
  });
});
