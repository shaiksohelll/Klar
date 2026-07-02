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

// Controllable mock of the momentum snapshot writer. Defaults to a resolved
// no-op so the salaryDisclosed cases are unaffected; the non-fatal test sets
// mockRejectedValueOnce to prove a throw here can't abort the ingest run.
const { recordSkillMomentumSnapshot } = vi.hoisted(() => ({
  recordSkillMomentumSnapshot: vi.fn().mockResolvedValue({ ok: true, skills: 0 }),
}));
vi.mock("./snapshot.js", () => ({ recordSkillMomentumSnapshot }));

import Job from "../models/Job.js";
import { ingestAdzuna } from "./adzuna.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────
// ingestAdzuna does a real bulkWrite, so we exercise it against a real Mongo
// via mongodb-memory-server and stub only the network (global.fetch).
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await Job.deleteMany({});
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

describe("ingestAdzuna — momentum snapshot is non-fatal", () => {
  it("stays green even when the momentum snapshot write throws", async () => {
    // Belt-and-braces: even if the helper somehow throws (it normally swallows
    // its own errors), ingestAdzuna must catch it and complete the run.
    recordSkillMomentumSnapshot.mockRejectedValueOnce(new Error("snapshot boom"));

    stubFetch([rawJob({ id: "green-1", salary_min: 100000, salary_is_predicted: 0 })]);
    const result = await ingestAdzuna({ what: "backend developer", country: "in", pages: 1 });

    // The run completed and returned its normal summary despite the throw.
    expect(result).toMatchObject({ fetched: expect.any(Number), totalInDb: expect.any(Number) });
    expect(recordSkillMomentumSnapshot).toHaveBeenCalled();
    // The job itself was still written — ingestion did its real work.
    const doc = await Job.findOne({ externalId: "green-1" }).lean();
    expect(doc).toBeTruthy();
  });
});
