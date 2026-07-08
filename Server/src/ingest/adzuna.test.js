import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// adzuna.js reads ADZUNA_APP_ID/KEY into module-level consts at import time.
// ESM imports are hoisted above top-level statements, so setting env below
// the imports runs too late. vi.hoisted() runs before imports.
vi.hoisted(() => {
  process.env.ADZUNA_APP_ID = "test-id";
  process.env.ADZUNA_APP_KEY = "test-key";
});

// Controllable mock of the daily-bucket snapshot writer. Defaults to a resolved
// no-op so the salaryDisclosed cases are unaffected; the non-fatal test sets
// mockRejectedValueOnce to prove a throw here can't abort the ingest run.
const { recordDailySkillBuckets } = vi.hoisted(() => ({
  recordDailySkillBuckets: vi.fn().mockResolvedValue({ ok: true, buckets: 0 }),
}));
vi.mock("./snapshot.js", () => ({
  recordSkillMomentumSnapshot: vi.fn().mockResolvedValue({ ok: true, skills: 0 }),
  recordDailySkillBuckets,
}));

// Spy on the skill-gap ROI cache clear — the 9th createTtlCache that ingestAdzuna
// previously missed. Mocked at module level so the imported binding in adzuna.js
// is the spy (ESM live bindings are read-only, so a runtime spy can't see it).
const { clearSkillGapRoiCache } = vi.hoisted(() => ({
  clearSkillGapRoiCache: vi.fn(),
}));
vi.mock("../aggregations/skillGapRoi.js", () => ({
  clearSkillGapRoiCache,
  computeSkillGapRoi: vi.fn(),
}));

import Job from "../models/Job.js";
import { ingestAdzuna } from "./adzuna.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────
// ingestAdzuna does a real bulkWrite, so we exercise it against a real Mongo
// via mongodb-memory-server and stub only the network (global.fetch).
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
  // Build the Job unique { source, externalId } index explicitly.
  // autoIndex is OFF so Mongoose will not create it automatically;
  // without it ingestAdzuna's bulkWrite upsert filter has no backing index.
  await Job.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Job.deleteMany({});
  clearSkillGapRoiCache.mockClear();
});

// Stub global.fetch to return a single-page Adzuna response containing exactly
// the supplied raw job rows. A narrow single-term query (what) avoids the full
// ROLE_QUERIES sweep so only ONE fetch happens.
function stubFetch(results) {
  const payload = { results };
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

function rawJob(overrides = {}) {
  return {
    id: overrides.id ?? "1",
    title: overrides.title ?? "Backend Developer",
    description: overrides.description ?? "node.js and mongodb",
    company: { display_name: overrides.company ?? "Acme" },
    location: { display_name: overrides.location ?? "Bangalore" },
    created: overrides.created ?? new Date().toISOString(),
    salary_min: overrides.salary_min,
    salary_max: overrides.salary_max,
    salary_is_predicted: overrides.salary_is_predicted,
  };
}

async function runWith(results) {
  stubFetch(results);
  // what set → single-term query → shouldPrune false, one fetch page.
  await ingestAdzuna({ what: "backend developer", country: "in", pages: 1 });
}

describe("ingestAdzuna — salaryDisclosed coercion", () => {
  it("treats a NUMERIC salary_is_predicted 1 as predicted (not disclosed)", async () => {
    await runWith([
      rawJob({ id: "num-pred", salary_min: 100000, salary_is_predicted: 1 }),
    ]);
    const doc = await Job.findOne({ externalId: "num-pred" }).lean();
    expect(doc.salaryDisclosed).toBe(false);
  });

  it("treats a numeric salary_is_predicted 0 as a real disclosure", async () => {
    await runWith([
      rawJob({ id: "num-real", salary_min: 100000, salary_is_predicted: 0 }),
    ]);
    const doc = await Job.findOne({ externalId: "num-real" }).lean();
    expect(doc.salaryDisclosed).toBe(true);
  });

  it('still excludes a string "1" predicted salary', async () => {
    await runWith([
      rawJob({ id: "str-pred", salary_min: 100000, salary_is_predicted: "1" }),
    ]);
    const doc = await Job.findOne({ externalId: "str-pred" }).lean();
    expect(doc.salaryDisclosed).toBe(false);
  });

  it("counts a MAX-only disclosed posting as disclosed", async () => {
    await runWith([
      rawJob({
        id: "max-only",
        salary_min: null,
        salary_max: 150000,
        salary_is_predicted: "0",
      }),
    ]);
    const doc = await Job.findOne({ externalId: "max-only" }).lean();
    expect(doc.salaryDisclosed).toBe(true);
    // midpoint falls back to max when min is absent.
    expect(doc.salaryRange.midpoint).toBe(150000);
  });

  it("marks a posting with no salary figures as not disclosed", async () => {
    await runWith([
      rawJob({ id: "none", salary_min: null, salary_max: null }),
    ]);
    const doc = await Job.findOne({ externalId: "none" }).lean();
    expect(doc.salaryDisclosed).toBe(false);
  });
});

describe("ingestAdzuna — daily snapshot is non-fatal", () => {
  it("stays green even when the daily-bucket write throws", async () => {
    // Belt-and-braces: even if the helper somehow throws (it normally swallows
    // its own errors), ingestAdzuna must catch it and complete the run.
    recordDailySkillBuckets.mockRejectedValueOnce(new Error("daily buckets boom"));
    stubFetch([rawJob({ id: "green-1", salary_min: 100000, salary_is_predicted: 0 })]);
    const result = await ingestAdzuna({ what: "backend developer", country: "in", pages: 1 });
    // The run completed and returned its normal summary despite the throw.
    expect(result).toMatchObject({ fetched: expect.any(Number), totalInDb: expect.any(Number) });
    expect(recordDailySkillBuckets).toHaveBeenCalled();
    // The job itself was still written — ingestion did its real work.
    const doc = await Job.findOne({ externalId: "green-1" }).lean();
    expect(doc).toBeTruthy();
  });
});

describe("ingestAdzuna — bulkWrite partial success (class 5)", () => {
  it("returns partial counts on BulkWriteError and still clears caches + prunes", async () => {
    // Seed a stale adzuna row so the chunked prune has something to delete,
    // proving the run did NOT abort after the partial bulkWrite.
    const stale = await Job.create({
      externalId: "stale-bw",
      source: "adzuna",
      title: "Old Backend",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
    });
    await Job.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetch([rawJob({ id: "bw-fresh", salary_min: 100000, salary_is_predicted: 0 })]);

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

    const result = await ingestAdzuna({
      what: "backend developer",
      country: "in",
      pages: 1,
      prune: true,
    });
    bulkSpy.mockRestore();

    // The run RETURNED (did not throw) and surfaced the partial counts.
    expect(result.bulkWriteError).toMatchObject({
      upsertedCount: 3,
      modifiedCount: 2,
      matchedCount: 5,
    });
    expect(result.upserted).toBe(3);
    expect(result.modified).toBe(2);

    // The cache-clear block STILL RAN, including the previously-missing ROI clear.
    expect(clearSkillGapRoiCache).toHaveBeenCalled();

    // The prune step STILL RAN (did not abort) and removed the stale row.
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await Job.findOne({ externalId: "stale-bw" })).toBeNull();
  }, 20_000);
});

describe("ingestAdzuna — chunked stale delete (class 12)", () => {
  it("deletes >500 stale rows in batches of 500", async () => {
    // Seed 1200 stale adzuna rows with distinct externalIds + forced-old updatedAt.
    const staleDocs = Array.from({ length: 1200 }, (_, i) => ({
      externalId: `stale-chunk-${i}`,
      source: "adzuna",
      title: "Old Role",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
    }));
    await Job.insertMany(staleDocs, { ordered: false });
    // Force updatedAt into the past (timestamps:true sets it to now on insert).
    await Job.updateMany(
      { source: "adzuna" },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetch([rawJob({ id: "chunk-fresh", salary_min: 100000, salary_is_predicted: 0 })]);

    // Call-through spy: records every bulkWrite call while still hitting Mongo.
    // First call = upsert (updateOne); the rest = 500-sized deleteOne batches.
    const bulkSpy = vi.spyOn(Job, "bulkWrite");

    const result = await ingestAdzuna({
      what: "backend developer",
      country: "in",
      pages: 1,
      prune: true,
    });
    const deleteBatchCalls = bulkSpy.mock.calls.filter(
      ([ops]) => ops?.[0]?.deleteOne,
    );
    bulkSpy.mockRestore();

    // ceil(1200 / 500) = 3 delete batches.
    expect(deleteBatchCalls.length).toBe(3);
    expect(result.removed).toBe(1200);
    // Only the freshly-upserted row survives.
    expect(await Job.countDocuments({ source: "adzuna" })).toBe(1);
  }, 30_000);
});

describe("ingestAdzuna — ROI cache clear (class 1)", () => {
  it("clears the skill-gap ROI cache on a successful run", async () => {
    stubFetch([rawJob({ id: "roi-1", salary_min: 100000, salary_is_predicted: 0 })]);
    const result = await ingestAdzuna({
      what: "backend developer",
      country: "in",
      pages: 1,
    });
    expect(result.bulkWriteError).toBeNull();
    expect(clearSkillGapRoiCache).toHaveBeenCalled();
  });
});

describe("ingestAdzuna — concurrent refresh spares refreshed row", () => {
  it("does NOT delete a row whose updatedAt was bumped after staleIds were read", async () => {
    // Seed a stale adzuna row (updatedAt far in the past).
    const stale = await Job.create({
      externalId: "concurrent-1",
      source: "adzuna",
      title: "Old Backend",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
    });
    await Job.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetch([rawJob({ id: "conc-fresh", salary_min: 100000, salary_is_predicted: 0 })]);

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

    const result = await ingestAdzuna({
      what: "backend developer",
      country: "in",
      pages: 1,
      prune: true,
    });
    bulkSpy.mockRestore();

    // The freshly-refreshed row must survive the prune.
    const survived = await Job.findOne({ externalId: "concurrent-1" }).lean();
    expect(survived).not.toBeNull();
    // removed should be 0 for the concurrent row (it no longer matched the filter).
    expect(result.removed).toBe(0);
  }, 20_000);
});

describe("ingestAdzuna — prune failure surfaced in return value", () => {
  it("reports pruneFailures > 0 when a delete batch throws with no usable partial result", async () => {
    // Seed a stale adzuna row so the prune path runs.
    const stale = await Job.create({
      externalId: "prune-fail-1",
      source: "adzuna",
      title: "Old Backend",
      normalizedRole: "backend",
      requiredSkills: ["node.js"],
      location: "Bangalore",
      postedAt: new Date("2020-01-01"),
    });
    await Job.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date("2020-01-01") } },
      { timestamps: false },
    );

    stubFetch([rawJob({ id: "pf-fresh", salary_min: 100000, salary_is_predicted: 0 })]);

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

    const result = await ingestAdzuna({
      what: "backend developer",
      country: "in",
      pages: 1,
      prune: true,
    });
    bulkSpy.mockRestore();

    // The failure is surfaced — not swallowed.
    expect(result.pruneFailures).toBeGreaterThan(0);
    // Cache-clear still ran despite the prune failure.
    expect(clearSkillGapRoiCache).toHaveBeenCalled();
  }, 20_000);
});
