import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import {
  recordDailySkillBuckets,
  backfillDailySkillBuckets,
  recordSkillMomentumSnapshot,
  dayBucket,
  isValidDailyBucket,
} from "./snapshot.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
  // Build indexes so the unique { skill, date } constraint is enforced in tests.
  await SkillSnapshot.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Job.deleteMany({});
  await SkillSnapshot.deleteMany({});
});

// ── Deterministic anchor ─────────────────────────────────────────
// A FIXED wall-clock-independent anchor so the 2-day recompute window is stable
// no matter when the suite runs. Without this, a run straddling UTC midnight
// could bucket jobs under one day while the test computes today/yesterday under
// the next. Every job's postedAt and every expected bucket derives from ANCHOR,
// and recordDailySkillBuckets is always called with `now: ANCHOR`.
const ANCHOR = new Date("2026-03-15T23:59:59.000Z");

// ── Helpers ─────────────────────────────────────────────
let seq = 0;
function makeJob({ requiredSkills = ["node.js"], postedAt = ANCHOR, company } = {}) {
  const companyName = company ?? `Co${++seq}`;
  const title = "Backend Developer";
  const location = "Bangalore";
  return {
    externalId: `adzuna:${++seq}`,
    source: "adzuna",
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills,
    salaryRange: null,
    salaryDisclosed: false,
    location,
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, location),
  };
}

// A UTC-midnight Date `daysAgo` before the anchor.
function utcDay(daysAgo, anchor = ANCHOR) {
  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate() - daysAgo,
    ),
  );
}

// A postedAt timestamp at noon UTC on the day `daysAgo` before the anchor (so it
// unambiguously buckets to that UTC day regardless of the test's wall clock).
function postedOn(daysAgo, anchor = ANCHOR) {
  const d = utcDay(daysAgo, anchor);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

// Run the forward writer with the fixed anchor as "now" so the default 2-day
// window is deterministic.
function runWriter(opts = {}) {
  return recordDailySkillBuckets({ now: ANCHOR, ...opts });
}

describe("isValidDailyBucket — shape guard", () => {
  it("accepts a well-formed row", () => {
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0), postingCount: 3 })).toBe(true);
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0), postingCount: 0 })).toBe(true);
  });

  it("rejects empty / non-string skill", () => {
    expect(isValidDailyBucket({ skill: "", date: utcDay(0), postingCount: 1 })).toBe(false);
    expect(isValidDailyBucket({ skill: "   ", date: utcDay(0), postingCount: 1 })).toBe(false);
    expect(isValidDailyBucket({ skill: null, date: utcDay(0), postingCount: 1 })).toBe(false);
    expect(isValidDailyBucket({ date: utcDay(0), postingCount: 1 })).toBe(false);
  });

  it("rejects invalid / missing date", () => {
    expect(isValidDailyBucket({ skill: "react", date: null, postingCount: 1 })).toBe(false);
    expect(isValidDailyBucket({ skill: "react", date: new Date("nope"), postingCount: 1 })).toBe(false);
    expect(isValidDailyBucket({ skill: "react", date: "2026-01-01", postingCount: 1 })).toBe(false);
  });

  it("rejects non-integer / negative postingCount", () => {
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0), postingCount: -1 })).toBe(false);
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0), postingCount: 1.5 })).toBe(false);
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0), postingCount: "3" })).toBe(false);
    expect(isValidDailyBucket({ skill: "react", date: utcDay(0) })).toBe(false);
  });
});

describe("recordDailySkillBuckets — writer + idempotency", () => {
  it("writes exactly one doc per (skill, day) with correct daily-flow counts", async () => {
    // yesterday + today are the default 2-day recompute window (anchored).
    // Put 2 node.js jobs today, 1 node.js + 1 react yesterday.
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js", "react"], postedAt: postedOn(1) }),
    ]);

    const res = await runWriter();
    expect(res.ok).toBe(true);

    const today = utcDay(0);
    const yday = utcDay(1);

    const nodeToday = await SkillSnapshot.findOne({ skill: "node.js", date: today }).lean();
    expect(nodeToday.postingCount).toBe(2);
    const nodeYday = await SkillSnapshot.findOne({ skill: "node.js", date: yday }).lean();
    expect(nodeYday.postingCount).toBe(1);
    const reactYday = await SkillSnapshot.findOne({ skill: "react", date: yday }).lean();
    expect(reactYday.postingCount).toBe(1);

    // Day-bucketed rows never carry a capturedAt.
    expect(nodeToday.capturedAt).toBeUndefined();
  });

  it("is idempotent: a second run creates no duplicates and counts stay stable", async () => {
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(1) }),
    ]);

    await runWriter();
    await runWriter();

    const rows = await SkillSnapshot.find({ skill: "node.js" }).lean();
    expect(rows).toHaveLength(2); // one per day, no dupes
    for (const r of rows) expect(r.postingCount).toBe(1);
  });

  it("self-heals today's partial count when more postings arrive later", async () => {
    await Job.create([makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) })]);
    await runWriter();
    let go = await SkillSnapshot.findOne({ skill: "go", date: utcDay(0) }).lean();
    expect(go.postingCount).toBe(1);

    // Two more “go” postings land today; re-running recomputes the day.
    await Job.create([
      makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) }),
    ]);
    await runWriter();
    go = await SkillSnapshot.findOne({ skill: "go", date: utcDay(0) }).lean();
    expect(go.postingCount).toBe(3);
  });

  it("skips jobs with empty requiredSkills or null postedAt", async () => {
    await Job.collection.insertOne({
      externalId: "adzuna:x1",
      source: "adzuna",
      title: "t",
      requiredSkills: [],
      postedAt: postedOn(0),
    });
    await Job.collection.insertOne({
      externalId: "adzuna:x2",
      source: "adzuna",
      title: "t",
      requiredSkills: ["node.js"],
      postedAt: null,
    });

    const res = await recordDailySkillBuckets({ now: ANCHOR, since: new Date(0) });
    expect(res.ok).toBe(true);
    const all = await SkillSnapshot.find({ date: { $type: "date" } }).lean();
    expect(all).toHaveLength(0);
  });

  it("never throws and returns ok:false when the aggregation errors", async () => {
    const spy = vi.spyOn(Job, "aggregate").mockRejectedValueOnce(new Error("boom"));
    let result;
    await expect(
      (async () => {
        result = await runWriter();
      })(),
    ).resolves.toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    spy.mockRestore();
  });

  it("tolerates malformed docs via the $type match guards (never flips ok:false)", async () => {
    // A well-formed job plus two malformed ones that would break $dateTrunc /
    // $unwind if they were not filtered out by the strict $type guards:
    //   - postedAt stored as a STRING (not a Date)
    //   - requiredSkills stored as a STRING (not an array)
    await Job.create([makeJob({ requiredSkills: ["rust"], postedAt: postedOn(0) })]);
    await Job.collection.insertOne({
      externalId: "adzuna:bad-date",
      source: "adzuna",
      title: "t",
      requiredSkills: ["rust"],
      postedAt: "2026-03-15", // string, not a Date
    });
    await Job.collection.insertOne({
      externalId: "adzuna:bad-skills",
      source: "adzuna",
      title: "t",
      requiredSkills: "rust", // string, not an array
      postedAt: postedOn(0),
    });

    const res = await recordDailySkillBuckets({ now: ANCHOR, since: new Date(0) });
    expect(res.ok).toBe(true);
    // Only the one well-formed job is counted.
    const rust = await SkillSnapshot.findOne({ skill: "rust", date: utcDay(0) }).lean();
    expect(rust.postingCount).toBe(1);
  });
});

describe("recordDailySkillBuckets — zero-flow pruning", () => {
  it("deletes a day-keyed row whose skill drops to zero within the window", async () => {
    // Day 0: one 'php' posting → a row is written.
    await Job.create([makeJob({ requiredSkills: ["php"], postedAt: postedOn(0) })]);
    await runWriter();
    expect(await SkillSnapshot.findOne({ skill: "php", date: utcDay(0) })).not.toBeNull();

    // The posting disappears (e.g. pruned upstream). Re-running recomputes the
    // window and finds zero 'php' today → the stale positive row must be gone.
    await Job.deleteMany({});
    await Job.create([makeJob({ requiredSkills: ["java"], postedAt: postedOn(0) })]);
    const res = await runWriter();
    expect(res.ok).toBe(true);
    expect(res.deleted).toBeGreaterThanOrEqual(1);

    // php's stale row is deleted; java's fresh row exists. A zero-flow day has
    // NO row rather than a stale positive one.
    expect(await SkillSnapshot.findOne({ skill: "php", date: utcDay(0) })).toBeNull();
    expect(await SkillSnapshot.findOne({ skill: "java", date: utcDay(0) })).not.toBeNull();
  });

  it("never touches rows OUTSIDE the recompute window", async () => {
    // An old day-keyed row (well before the 2-day window) must survive even
    // though it is not in the current fresh set.
    await SkillSnapshot.create({ skill: "cobol", date: utcDay(200), postingCount: 4 });
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);

    const res = await runWriter();
    expect(res.ok).toBe(true);

    // Out-of-window row is untouched (the prune is scoped to date >= lowerBound).
    const cobol = await SkillSnapshot.findOne({ skill: "cobol", date: utcDay(200) }).lean();
    expect(cobol).toBeTruthy();
    expect(cobol.postingCount).toBe(4);
  });

  it("never touches legacy capturedAt-only rows (no date) inside the window's time range", async () => {
    const capturedAt = new Date();
    await SkillSnapshot.create({ skill: "node.js", count: 50, count30: 5, capturedAt });
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);

    await runWriter();

    const legacy = await SkillSnapshot.findOne({ skill: "node.js", count: 50 }).lean();
    expect(legacy).toBeTruthy();
    expect(legacy.date).toBeUndefined();
    expect(legacy.capturedAt).toBeInstanceOf(Date);
  });
});

describe("recordDailySkillBuckets — daily rows are pure (no stale momentum fields)", () => {
  it("unsets momentum/legacy fields when overwriting a momentum-era (skill, date) row", async () => {
    // Simulate a row previously written by the momentum writer for today: it
    // carries disclosedCount + salaryMidpointMedian (and imagine legacy fields).
    await SkillSnapshot.create({
      skill: "node.js",
      date: utcDay(0),
      postingCount: 99,
      disclosedCount: 12,
      salaryMidpointMedian: 1500000,
      count: 99,
      count30: 9,
    });

    // A single node.js posting today. The daily writer overwrites the row.
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);
    await runWriter();

    const row = await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(0) }).lean();
    expect(row.postingCount).toBe(1); // daily flow, overwritten
    // Momentum/legacy fields are gone — a pure daily-flow row.
    expect(row.disclosedCount).toBeUndefined();
    expect(row.salaryMidpointMedian).toBeUndefined();
    expect(row.count).toBeUndefined();
    expect(row.count30).toBeUndefined();
    expect(row.capturedAt).toBeUndefined();
  });
});

describe("recordDailySkillBuckets — partial bulkWrite success surfaced", () => {
  it("reports the applied count (ok:true) when bulkWrite throws a BulkWriteError", async () => {
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["react"], postedAt: postedOn(0) }),
    ]);

    // Simulate a duplicate-key BulkWriteError that still applied 1 of 2 ops
    // (ordered:false semantics). The writer must surface the PARTIAL count with
    // ok:true, not report a total failure.
    const bulkErr = new Error("E11000 duplicate key error");
    bulkErr.result = { upsertedCount: 1, modifiedCount: 0, nUpserted: 1, nModified: 0 };
    const spy = vi
      .spyOn(SkillSnapshot, "bulkWrite")
      .mockRejectedValueOnce(bulkErr);

    const res = await runWriter();
    expect(res.ok).toBe(true);
    expect(res.buckets).toBe(1); // the op that landed, not 0
    spy.mockRestore();
  });
});

describe("backfillDailySkillBuckets — full-range, idempotent", () => {
  it("buckets jobs across several months, leaves legacy rows untouched, reports range", async () => {
    // Legacy velocity row (has capturedAt, no date) — must survive untouched.
    const capturedAt = new Date();
    await SkillSnapshot.create({ skill: "node.js", count: 99, count30: 9, capturedAt });

    // Jobs spread across ~5 months.
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(150) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(150) }),
      makeJob({ requiredSkills: ["react"], postedAt: postedOn(90) }),
      makeJob({ requiredSkills: ["node.js", "react"], postedAt: postedOn(30) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
    ]);

    const res = await backfillDailySkillBuckets();
    expect(res.ok).toBe(true);
    expect(res.buckets).toBeGreaterThanOrEqual(5);
    expect(res.distinctSkills).toBe(2);
    expect(res.minDate).toBe(utcDay(150).toISOString());
    expect(res.maxDate).toBe(utcDay(0).toISOString());

    // node.js on the 150-days-ago day = 2 postings that day.
    const nodeOld = await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(150) }).lean();
    expect(nodeOld.postingCount).toBe(2);

    // Legacy row untouched: still present, still has capturedAt, no date.
    const legacy = await SkillSnapshot.findOne({ skill: "node.js", count: 99 }).lean();
    expect(legacy).toBeTruthy();
    expect(legacy.capturedAt).toBeInstanceOf(Date);
    expect(legacy.date).toBeUndefined();
  });

  it("is fully idempotent: a second backfill produces no duplicates", async () => {
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(60) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
    ]);

    await backfillDailySkillBuckets();
    const first = await SkillSnapshot.countDocuments({ date: { $type: "date" } });
    await backfillDailySkillBuckets();
    const second = await SkillSnapshot.countDocuments({ date: { $type: "date" } });
    expect(second).toBe(first);
    expect(first).toBe(2);
  });

  it("prunes a stale full-history day-keyed row that no longer has any postings", async () => {
    // A day-keyed row with no backing job at all (e.g. its jobs were deleted).
    await SkillSnapshot.create({ skill: "perl", date: utcDay(45), postingCount: 3 });
    // Real jobs on other days.
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(45) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
    ]);

    const res = await backfillDailySkillBuckets();
    expect(res.ok).toBe(true);
    expect(res.deleted).toBeGreaterThanOrEqual(1);

    // The stale perl row (no backing postings) is gone; node.js rows remain.
    expect(await SkillSnapshot.findOne({ skill: "perl", date: utcDay(45) })).toBeNull();
    expect(await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(45) })).not.toBeNull();
    expect(await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(0) })).not.toBeNull();
  });
});

describe("daily-flow ownership of { skill, date } rows", () => {
  // Regression guard for the fix that stopped recordSkillMomentumSnapshot()
  // (cumulative trailing-window postingCount) from running in ingest. Both
  // writers key on { skill, date }; if both run over the same rows the last
  // writer wins and the series is corrupted. Today's row MUST end up holding
  // the DAILY-FLOW count (new postings today), not the cumulative total.
  it("today's day-bucket holds daily flow, not the cumulative trailing count, after BOTH writers run", async () => {
    // Spread node.js across several UTC days so cumulative (trailing) != daily.
    //   today: 2 postings  -> daily flow for today = 2
    //   older days: 5 more postings within the trailing window
    // recordSkillMomentumSnapshot() would bank cumulative = 7 into today's row.
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(10) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(10) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(20) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(20) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(30) }),
    ]);

    // Simulate a single ingest that (wrongly) runs both writers. Daily-flow
    // writer runs LAST so it owns the row — mirrors the corrected ingest order
    // where only the daily-flow writer touches these rows at all. The momentum
    // writer banks its cumulative value into TODAY's { skill, dayBucket() } row;
    // the daily writer (anchored to the same UTC day) then overwrites it.
    await recordSkillMomentumSnapshot({ date: ANCHOR });
    await recordDailySkillBuckets({ now: ANCHOR, since: new Date(0) });

    // Exactly one row for today (no duplicate from the two writers colliding).
    const todayRows = await SkillSnapshot.find({ skill: "node.js", date: dayBucket(ANCHOR) }).lean();
    expect(todayRows).toHaveLength(1);
    // The whole point: today's postingCount is the DAILY FLOW (2), not the
    // cumulative trailing total (7) the momentum writer would have banked.
    expect(todayRows[0].postingCount).toBe(2);
    // And it is a PURE daily row — momentum fields unset on overwrite.
    expect(todayRows[0].disclosedCount).toBeUndefined();
    expect(todayRows[0].salaryMidpointMedian).toBeUndefined();

    // Older days carry their own daily flow too (2 on the day 10 ago), proving
    // the series is genuinely day-bucketed and not a single cumulative point.
    const tenAgo = await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(10) }).lean();
    expect(tenAgo.postingCount).toBe(2);
  });
});

describe("recordDailySkillBuckets — $lte upper-bound on postedAt", () => {
  it("drops a future-dated posting from the aggregation", async () => {
    // A normal job today + one with a postedAt 1 day INTO THE FUTURE (bad feed).
    const futureDate = new Date(
      Date.UTC(
        ANCHOR.getUTCFullYear(),
        ANCHOR.getUTCMonth(),
        ANCHOR.getUTCDate() + 1,
        12, 0, 0,
      ),
    );
    await Job.create([
      makeJob({ requiredSkills: ["rust"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["rust"], postedAt: futureDate }),
    ]);

    const res = await runWriter({ since: new Date(0) });
    expect(res.ok).toBe(true);

    // Only today's job is bucketed; the future-dated one is excluded.
    const todayRow = await SkillSnapshot.findOne({ skill: "rust", date: utcDay(0) }).lean();
    expect(todayRow).toBeTruthy();
    expect(todayRow.postingCount).toBe(1);

    // No bucket for the future day exists at all.
    const futureDay = new Date(
      Date.UTC(ANCHOR.getUTCFullYear(), ANCHOR.getUTCMonth(), ANCHOR.getUTCDate() + 1),
    );
    expect(await SkillSnapshot.findOne({ skill: "rust", date: futureDay })).toBeNull();
  });
});

describe("recordDailySkillBuckets — prune never touches future rows", () => {
  it("leaves a future-dated day-keyed row intact during prune", async () => {
    // Insert a day-keyed row in the FUTURE. The prune must never delete it
    // because the prune window is bounded by $lte: now.
    const futureDay = new Date(
      Date.UTC(ANCHOR.getUTCFullYear(), ANCHOR.getUTCMonth(), ANCHOR.getUTCDate() + 30),
    );
    await SkillSnapshot.create({ skill: "future-skill", date: futureDay, postingCount: 7 });

    // A real job today so the writer has something to do.
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);
    const res = await runWriter({ since: new Date(0) });
    expect(res.ok).toBe(true);

    // The future row survives: it was outside the prune window.
    const row = await SkillSnapshot.findOne({ skill: "future-skill", date: futureDay }).lean();
    expect(row).toBeTruthy();
    expect(row.postingCount).toBe(7);
  });
});

describe("recordDailySkillBuckets — chunked deleteMany", () => {
  it("deletes all stale keys even when the set exceeds one 500-key batch", async () => {
    // Seed 600 stale (skill, date) rows that have no backing jobs.
    // Each gets a unique skill name so they are all distinct keys.
    const staleRows = [];
    const staleDate = utcDay(5);
    for (let i = 0; i < 600; i++) {
      staleRows.push({ skill: `stale-${i}`, date: staleDate, postingCount: 1 });
    }
    await SkillSnapshot.insertMany(staleRows);
    expect(await SkillSnapshot.countDocuments({ date: staleDate })).toBe(600);

    // One real job today so the writer runs and its fresh set does NOT contain
    // any of the 600 stale skills.
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);
    const res = await recordDailySkillBuckets({ now: ANCHOR, since: new Date(0) });
    expect(res.ok).toBe(true);
    // All 600 stale rows should be deleted (across at least 2 batches of 500).
    expect(res.deleted).toBe(600);

    // None of the stale rows survive.
    expect(await SkillSnapshot.countDocuments({ date: staleDate })).toBe(0);
    // The real row for today is still there.
    expect(await SkillSnapshot.findOne({ skill: "node.js", date: utcDay(0) })).not.toBeNull();
  });

  it("returns partial success when one batch's deleteMany throws mid-loop", async () => {
    // Seed 600 stale rows (2 batches of 500+100) plus one real job.
    const staleDate = utcDay(5);
    const staleRows = [];
    for (let i = 0; i < 600; i++) {
      staleRows.push({ skill: `stale-${i}`, date: staleDate, postingCount: 1 });
    }
    await SkillSnapshot.insertMany(staleRows);
    await Job.create([makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) })]);

    // Spy on deleteMany: let the FIRST batch succeed, then THROW on the second.
    const original = SkillSnapshot.deleteMany.bind(SkillSnapshot);
    let callCount = 0;
    const spy = vi.spyOn(SkillSnapshot, "deleteMany").mockImplementation((...args) => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("batch 2 boom"));
      return original(...args);
    });

    const res = await recordDailySkillBuckets({ now: ANCHOR, since: new Date(0) });

    // The function must NOT return ok:false / buckets:0.
    // It should surface the buckets written + deletes from the successful batch.
    expect(res.ok).toBe(true);
    expect(res.buckets).toBeGreaterThanOrEqual(1); // node.js was written
    expect(res.deleted).toBe(500); // first batch succeeded (500 keys)

    spy.mockRestore();
  });
});
