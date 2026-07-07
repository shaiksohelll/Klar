import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// ── Mocks ──────────────────────────────────────────────────────────────────
// skillDetail issues several aggregate() calls + a Job.find() and calls
// getSkillPairs(). We stub Job so the months-clamp tests can run without a DB
// (capturing the $match off sinceDate()), and stub getSkillPairs/dedupe so the
// route never touches SkillSnapshot. For the type-guard exclusion tests we
// flip LIVE_DB on: the aggregate spy then delegates to the REAL model against
// an in-memory Mongo, exercising the actual $dateToString / $unwind stages.

let capturedMatch;
let LIVE_DB = false;

vi.mock("../models/Job.js", async (importOriginal) => {
  const actual = await importOriginal();
  const findChain = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  };
  return {
    default: {
      // Capture the $match of the FIRST aggregate call (the demand pipeline,
      // whose baseMatch.postedAt.$gte reflects the clamped months window and
      // whose requiredSkills now carries the $type guards). In LIVE_DB mode the
      // spy delegates to the real model so the pipelines run against the
      // in-memory Mongo; otherwise a canned result keeps the clamp tests DB-free
      // (and safe under fake timers).
      aggregate: vi.fn((pipeline) => {
        const match = pipeline?.find?.((s) => s && s.$match)?.$match;
        if (match && match.postedAt && capturedMatch === undefined) {
          capturedMatch = match;
        }
        if (LIVE_DB) {
          return actual.default.aggregate(pipeline);
        }
        return Promise.resolve([{ n: 0 }]);
      }),
      find: vi.fn(() => findChain),
    },
  };
});

vi.mock("../aggregations/skillPairs.js", () => ({
  getSkillPairs: vi.fn().mockResolvedValue({ skill: "react", baseCount: 0, pairs: [] }),
}));

vi.mock("../lib/dedupe.js", () => ({
  dedupeGroupStages: () => [],
}));

import skillDetailRouter, { clearDetailCache } from "./skillDetail.js";

// ── In-memory Mongo lifecycle ─────────────────────────────────────────────
// Only the type-guard exclusion tests touch a real DB (LIVE_DB = true). The
// months-clamp tests keep using the canned mock, so connecting up-front is
// harmless for them and lets the exclusion tests run real aggregation pipelines
// against actual BSON (so a string postedAt / string requiredSkills survive
// untouched, exactly as a bulkWrite that skipped Mongoose validation would).
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

// Build a tiny app that mounts only the skill-detail router.
function makeApp() {
  const app = express();
  app.use("/api/skill", skillDetailRouter);
  return app;
}

// Recover the integer months the route used from the captured since-date.
// sinceDate() = now - months months; round to the nearest whole month.
function monthsFromSince(since, now) {
  const s = new Date(since);
  return (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
}

describe("GET /api/skill/:name — months clamp", () => {
  beforeEach(() => {
    capturedMatch = undefined;
    // DETAIL_CACHE is module-level and persists across cases; clear it so a
    // repeated cache key can't return a hit and skip the aggregate we inspect.
    clearDetailCache();
    // Freeze time on a mid-month day so month subtraction can't roll over a
    // shorter month (e.g. the 31st) and skew the recovered month count.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = new Date("2026-06-15T00:00:00Z");

  it("clamps an over-large ?months to 24", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=99999");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(24);
  });

  it("clamps a negative ?months up to 1", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=-5");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(1);
  });

  it("defaults to 12 for zero or non-numeric ?months", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=0");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(12);
  });

  it("passes a valid in-range ?months through unchanged", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=6");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(6);
  });
});

// ── baseMatch type guards (P0/P1 audit) ─────────────────────────────────────
// A direct Mongo import / bulkWrite that skips Mongoose validation can persist
// a non-Date postedAt (crashes $dateToString) or a non-array requiredSkills
// (silently miscounts $unwind). baseMatch now carries $type guards so such
// malformed docs are excluded at $match before reaching either stage. We
// insert the malformed docs through the RAW collection (bypassing Mongoose
// validation, exactly like a bulkWrite), then assert no-throw + exclusion.
const jobsCol = () => mongoose.connection.collection("jobs");

function rawJob(overrides = {}) {
  return {
    externalId: `adzuna:${Math.random().toString(36).slice(2)}`,
    source: "adzuna",
    title: "Backend Developer",
    companyName: "Acme",
    isRemote: false,
    requiredSkills: ["react", "node.js"],
    salaryRange: null,
    salaryDisclosed: false,
    location: "Bangalore",
    redirectUrl: "",
    postedAt: new Date(),
    dedupeKey: null,
    ...overrides,
  };
}

describe("GET /api/skill/:name — baseMatch type guards exclude malformed docs", () => {
  beforeEach(async () => {
    capturedMatch = undefined;
    LIVE_DB = true;
    clearDetailCache();
    await jobsCol().deleteMany({});
  });

  afterEach(() => {
    LIVE_DB = false;
  });

  it("excludes a doc whose postedAt is a STRING so $dateToString never throws", async () => {
    // One well-formed posting (valid Date) + one whose postedAt is a plain
    // string — the exact shape a direct Mongo import that skipped Mongoose
    // validation would leave behind.
    await jobsCol().insertOne(rawJob({ requiredSkills: ["react", "node.js"] }));
    await jobsCol().insertOne(
      rawJob({
        externalId: "adzuna:bad-date",
        requiredSkills: ["react"],
        postedAt: "2024-01-15", // string, not a Date
      }),
    );

    const res = await request(makeApp()).get("/api/skill/react");

    // No throw: the $dateToString trend stage never receives the string.
    expect(res.status).toBe(200);
    // The malformed doc is excluded from the deduped demand count.
    expect(res.body.demand).toBe(1);
    // Trend buckets populated without crashing.
    expect(Array.isArray(res.body.trend)).toBe(true);
    // baseMatch carried the postedAt type guard alongside the preserved $gte.
    expect(capturedMatch.postedAt.$type).toBe("date");
    expect(capturedMatch.postedAt.$gte).toBeInstanceOf(Date);
  });

  it("excludes a doc whose requiredSkills is a NON-ARRAY so $unwind never miscounts", async () => {
    // One well-formed posting + one whose requiredSkills is a string.
    await jobsCol().insertOne(rawJob({ requiredSkills: ["react", "node.js"] }));
    await jobsCol().insertOne(
      rawJob({
        externalId: "adzuna:bad-skills",
        requiredSkills: "react", // string, not an array
      }),
    );

    const res = await request(makeApp()).get("/api/skill/react");

    expect(res.status).toBe(200);
    // The malformed doc is excluded from the deduped demand count (without the
    // guard it would match `requiredSkills: "react"` and inflate demand to 2).
    expect(res.body.demand).toBe(1);
    // Co-occurrence: "node.js" appears only in the well-formed doc.
    const node = res.body.relatedSkills.find((s) => s.skill === "node.js");
    expect(node).toBeTruthy();
    expect(node.count).toBe(1);
    // baseMatch carried the array type guard alongside the preserved name match.
    expect(capturedMatch.requiredSkills.$type).toBe("array");
    expect(capturedMatch.requiredSkills.$eq).toBe("react");
  });
});
