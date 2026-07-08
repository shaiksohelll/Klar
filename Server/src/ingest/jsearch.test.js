import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// jsearch.js reads JSEARCH_API_KEY into a module-level const at import time.
// ESM imports are hoisted above top-level statements, so setting env below
// the imports runs too late. vi.hoisted() runs before imports.
vi.hoisted(() => {
  process.env.JSEARCH_API_KEY = "test-key";
});

// Mirror adzuna.test.js: stub the day-bucket writer so JSearch ingest tests
// exercise ONLY the fetch/upsert/prune contract and never run the real
// aggregation/bulkWrite against the shared collection.
const { recordDailySkillBuckets } = vi.hoisted(() => ({
  recordDailySkillBuckets: vi.fn().mockResolvedValue({ ok: true, buckets: 0 }),
}));
vi.mock("./snapshot.js", () => ({
  recordSkillMomentumSnapshot: vi.fn().mockResolvedValue({ ok: true, skills: 0 }),
  recordDailySkillBuckets,
}));

// Spy on the skill-gap ROI cache clear — the 9th createTtlCache that ingestJSearch
// previously missed. Mocked at module level so the imported binding in jsearch.js
// is the spy (ESM live bindings are read-only, so a runtime spy can't see it).
const { clearSkillGapRoiCache } = vi.hoisted(() => ({
  clearSkillGapRoiCache: vi.fn(),
}));
vi.mock("../aggregations/skillGapRoi.js", () => ({
  clearSkillGapRoiCache,
  computeSkillGapRoi: vi.fn(),
}));

import Job from "../models/Job.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { ingestJSearch } from "./jsearch.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
  // Build the Job unique { source, externalId } index explicitly.
  // autoIndex is OFF so Mongoose will not create it automatically;
  // without it ingestJSearch's bulkWrite upsert filter has no backing index.
  await Job.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Job.deleteMany({});
  recordDailySkillBuckets.mockClear();
  clearSkillGapRoiCache.mockClear();
});

// Seed a Job row directly, controlling source + updatedAt (timestamps:true
// normally manages updatedAt, so we force it with a raw update after insert).
async function seedJob({ source, externalId, updatedAt, title = "Old Role" }) {
  const doc = await Job.create({
    externalId,
    source,
    title,
    companyName: "StaleCo",
    normalizedRole: "backend",
    requiredSkills: ["node.js"],
    location: "Bangalore",
    postedAt: new Date("2020-01-01"),
    dedupeKey: makeDedupeKey("StaleCo", title, "Bangalore"),
  });
  await Job.updateOne({ _id: doc._id }, { $set: { updatedAt } });
}

// One JSearch API item shaped like the real payload.
function jsearchItem(id) {
  return {
    job_id: id,
    job_title: "Backend Developer",
    job_description: "node.js and mongodb",
    employer_name: "FreshCo",
    job_city: "Bengaluru",
    job_country: "in",
    job_min_salary: 1000000,
    job_max_salary: 1500000,
    job_posted_at_datetime_utc: new Date().toISOString(),
    job_apply_link: "https://example.com",
  };
}

// Stub fetch so EVERY role query returns the same one fresh item. ok:true so
// errorCount stays 0 and the prune path runs.
function stubFetchOk() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [jsearchItem("fresh-1")] }),
    text: async () => "",
  });
}

// Stub fetch to always reject → errorCount > 0 for every query → prune skipped.
function stubFetchFail() {
  global.fetch = vi.fn().mockRejectedValue(new Error("boom"));
}

describe("ingestJSearch — symmetric prune", () => {
  it("removes only STALE jsearch rows on a clean full sweep", async () => {
    // A stale jsearch row (updatedAt far in the past) + a stale adzuna row.
    await seedJob({
      source: "jsearch",
      externalId: "jsearch:stale-1",
      updatedAt: new Date("2020-01-01"),
    });
    await seedJob({
      source: "adzuna",
      externalId: "stale-adzuna",
      updatedAt: new Date("2020-01-01"),
    });

    stubFetchOk();
    const res = await ingestJSearch({ country: "in", pages: 1 });

    // Prune ran and removed the stale jsearch row.
    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(await Job.findOne({ externalId: "jsearch:stale-1" })).toBeNull();

    // The fresh jsearch row written this run survives.
    expect(await Job.findOne({ externalId: "jsearch:fresh-1" })).not.toBeNull();

    // The adzuna row is NEVER touched by a jsearch prune.
    expect(await Job.findOne({ externalId: "stale-adzuna" })).not.toBeNull();
  }, 20_000);

  it("does NOT prune when any query failed (partial snapshot)", async () => {
    await seedJob({
      source: "jsearch",
      externalId: "jsearch:stale-2",
      updatedAt: new Date("2020-01-01"),
    });

    stubFetchFail();
    const res = await ingestJSearch({ country: "in", pages: 1 });

    expect(res.errors).toBeGreaterThan(0);
    expect(res.removed).toBe(0);
    // Stale row is spared because the run was not a clean full snapshot.
    expect(await Job.findOne({ externalId: "jsearch:stale-2" })).not.toBeNull();
  }, 20_000);

  it("does NOT prune when prune:false is passed", async () => {
    await seedJob({
      source: "jsearch",
      externalId: "jsearch:stale-3",
      updatedAt: new Date("2020-01-01"),
    });

    stubFetchOk();
    const res = await ingestJSearch({ country: "in", pages: 1, prune: false });

    expect(res.removed).toBe(0);
    expect(await Job.findOne({ externalId: "jsearch:stale-3" })).not.toBeNull();
  }, 20_000);
});

describe("ingestJSearch — bulkWrite partial success (class 5)", () => {
  it("returns partial counts on BulkWriteError and still clears caches + prunes", async () => {
    // Seed a stale jsearch row so the chunked prune has something to delete,
    // proving the run did NOT abort after the partial bulkWrite.
    await seedJob({
      source: "jsearch",
      externalId: "jsearch:stale-bw",
      updatedAt: new Date("2020-01-01"),
    });

    stubFetchOk();

    // First bulkWrite (upsert, updateOne ops) throws a BulkWriteError carrying
    // partial counts; the deleteOne prune batches delegate to the real in-memory Mongo.
    const bwErr = Object.assign(new Error("E11000 duplicate key"), {
      name: "BulkWriteError",
      result: { upsertedCount: 3, modifiedCount: 2, matchedCount: 5 },
    });
    const realBulkWrite = Job.bulkWrite.bind(Job);
    const bulkSpy = vi
      .spyOn(Job, "bulkWrite")
      .mockImplementation(async (ops, opts) => {
        if (ops?.[0]?.updateOne) throw bwErr;
        return realBulkWrite(ops, opts);
      });

    const res = await ingestJSearch({ country: "in", pages: 1 });
    bulkSpy.mockRestore();

    // The run RETURNED (did not throw) and surfaced the partial counts.
    expect(res.bulkWriteError).toMatchObject({
      upsertedCount: 3,
      modifiedCount: 2,
      matchedCount: 5,
    });
    expect(res.upserted).toBe(3);
    expect(res.modified).toBe(2);

    // The cache-clear block STILL RAN, including the previously-missing ROI clear.
    expect(clearSkillGapRoiCache).toHaveBeenCalled();

    // The prune step STILL RAN (did not abort) and removed the stale row.
    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(await Job.findOne({ externalId: "jsearch:stale-bw" })).toBeNull();
  }, 20_000);
});

describe("ingestJSearch — chunked stale delete (class 12)", () => {
  it("deletes >500 stale rows in batches of 500", async () => {
    // Seed 1200 stale jsearch rows with distinct externalIds + forced-old updatedAt.
    const staleDocs = Array.from({ length: 1200 }, (_, i) => ({
      externalId: `jsearch:stale-chunk-${i}`,
      source: "jsearch",
      title: "Old Role",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
    }));
    await Job.insertMany(staleDocs, { ordered: false });
    // Force updatedAt into the past (timestamps:true sets it to now on insert).
    await Job.updateMany(
      { source: "jsearch" },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetchOk();

    // Call-through spy: records every bulkWrite call while still hitting Mongo.
    // First call = upsert (updateOne); the rest = 500-sized deleteOne batches.
    const bulkSpy = vi.spyOn(Job, "bulkWrite");

    const res = await ingestJSearch({ country: "in", pages: 1 });
    const deleteBatchCalls = bulkSpy.mock.calls.filter(
      ([ops]) => ops?.[0]?.deleteOne,
    );
    bulkSpy.mockRestore();

    // ceil(1200 / 500) = 3 delete batches.
    expect(deleteBatchCalls.length).toBe(3);
    expect(res.removed).toBe(1200);
    // Only the freshly-upserted row survives.
    expect(await Job.countDocuments({ source: "jsearch" })).toBe(1);
  }, 30_000);
});

describe("ingestJSearch — ROI cache clear (class 1)", () => {
  it("clears the skill-gap ROI cache on a successful run", async () => {
    stubFetchOk();
    const res = await ingestJSearch({ country: "in", pages: 1 });
    expect(res.bulkWriteError).toBeNull();
    expect(clearSkillGapRoiCache).toHaveBeenCalled();
  }, 20_000);
});

describe("ingestJSearch — concurrent refresh spares refreshed row", () => {
  it("does NOT delete a row whose updatedAt was bumped after staleIds were read", async () => {
    // Seed a stale jsearch row (updatedAt far in the past).
    const stale = await Job.create({
      externalId: "jsearch:concurrent-1",
      source: "jsearch",
      title: "Old Backend",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
      dedupeKey: makeDedupeKey("StaleCo", "Old Backend", "Bangalore"),
    });
    await Job.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetchOk();

    // Intercept Job.bulkWrite: the first call with deleteOne ops is the prune
    // batch. BEFORE it executes, bump the stale row's updatedAt to "now"
    // (simulating a concurrent ingest that refreshed it). The source+updatedAt
    // guard on the deleteOne filter should then cause the delete to be a no-op
    // for that row.
    const realBulkWrite = Job.bulkWrite.bind(Job);
    const bulkSpy = vi
      .spyOn(Job, "bulkWrite")
      .mockImplementation(async (ops, opts) => {
        if (ops?.[0]?.deleteOne) {
          // Simulate concurrent refresh: bump updatedAt to now.
          await Job.updateOne(
            { _id: stale._id },
            { $set: { updatedAt: new Date() } },
            { timestamps: false },
          );
        }
        return realBulkWrite(ops, opts);
      });

    const res = await ingestJSearch({ country: "in", pages: 1 });
    bulkSpy.mockRestore();

    // The freshly-refreshed row must survive the prune.
    const survived = await Job.findOne({ externalId: "jsearch:concurrent-1" }).lean();
    expect(survived).not.toBeNull();
    // removed should be 0 for the concurrent row (it no longer matched the filter).
    expect(res.removed).toBe(0);
  }, 20_000);
});

describe("ingestJSearch — prune failure surfaced in return value", () => {
  it("reports pruneFailures > 0 when a delete batch throws with no usable partial result", async () => {
    // Seed a stale jsearch row so the prune path runs.
    const stale = await Job.create({
      externalId: "jsearch:prune-fail-1",
      source: "jsearch",
      title: "Old Backend",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
      dedupeKey: makeDedupeKey("StaleCo", "Old Backend", "Bangalore"),
    });
    await Job.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetchOk();

    // Make only the deleteOne bulkWrite throw with NO partial result.
    const realBulkWrite = Job.bulkWrite.bind(Job);
    const bulkSpy = vi
      .spyOn(Job, "bulkWrite")
      .mockImplementation(async (ops, opts) => {
        if (ops?.[0]?.deleteOne) {
          throw new Error("connection reset");
        }
        return realBulkWrite(ops, opts);
      });

    const res = await ingestJSearch({ country: "in", pages: 1 });
    bulkSpy.mockRestore();

    // The failure is surfaced — not swallowed.
    expect(res.pruneFailures).toBeGreaterThan(0);
    // Cache-clear still ran despite the prune failure.
    expect(clearSkillGapRoiCache).toHaveBeenCalled();
  }, 20_000);
});
