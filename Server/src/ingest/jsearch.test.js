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

import Job from "../models/Job.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { ingestJSearch } from "./jsearch.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Job.deleteMany({});
  recordDailySkillBuckets.mockClear();
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
