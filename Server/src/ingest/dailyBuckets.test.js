import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import {
  recordDailySkillBuckets,
  backfillDailySkillBuckets,
  isValidDailyBucket,
} from "./snapshot.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
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

// ── Helpers ─────────────────────────────────────────────
let seq = 0;
function makeJob({ requiredSkills = ["node.js"], postedAt = new Date(), company } = {}) {
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

// A UTC-midnight Date `daysAgo` before `anchor`.
function utcDay(daysAgo, anchor = new Date()) {
  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate() - daysAgo,
    ),
  );
}

// A postedAt timestamp at noon UTC on the day `daysAgo` before `anchor` (so it
// unambiguously buckets to that UTC day regardless of the test's wall clock).
function postedOn(daysAgo, anchor = new Date()) {
  const d = utcDay(daysAgo, anchor);
  d.setUTCHours(12, 0, 0, 0);
  return d;
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
    // Anchor: yesterday + today are the default 2-day recompute window.
    // Put 2 node.js jobs today, 1 node.js + 1 react yesterday.
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["node.js", "react"], postedAt: postedOn(1) }),
    ]);

    const res = await recordDailySkillBuckets();
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

    await recordDailySkillBuckets();
    await recordDailySkillBuckets();

    const rows = await SkillSnapshot.find({ skill: "node.js" }).lean();
    expect(rows).toHaveLength(2); // one per day, no dupes
    for (const r of rows) expect(r.postingCount).toBe(1);
  });

  it("self-heals today's partial count when more postings arrive later", async () => {
    await Job.create([makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) })]);
    await recordDailySkillBuckets();
    let go = await SkillSnapshot.findOne({ skill: "go", date: utcDay(0) }).lean();
    expect(go.postingCount).toBe(1);

    // Two more “go” postings land today; re-running recomputes the day.
    await Job.create([
      makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) }),
      makeJob({ requiredSkills: ["go"], postedAt: postedOn(0) }),
    ]);
    await recordDailySkillBuckets();
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

    const res = await recordDailySkillBuckets({ since: new Date(0) });
    expect(res.ok).toBe(true);
    const all = await SkillSnapshot.find({ date: { $type: "date" } }).lean();
    expect(all).toHaveLength(0);
  });

  it("never throws and returns ok:false when the aggregation errors", async () => {
    const spy = vi.spyOn(Job, "aggregate").mockRejectedValueOnce(new Error("boom"));
    let result;
    await expect(
      (async () => {
        result = await recordDailySkillBuckets();
      })(),
    ).resolves.toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
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
});
