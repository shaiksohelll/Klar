import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { getSalaryInsights, clearSalaryCache } from "./salaryInsights.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────
// salaryInsights runs a real aggregation pipeline (dedupe + $facet), so we
// exercise it against an actual MongoDB via mongodb-memory-server rather than
// mocking Mongoose. Each test starts from an empty collection and a cleared
// salary cache so results are deterministic.
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
  await Job.deleteMany({});
  clearSalaryCache();
});

// ── Helpers ────────────────────────────────────────────────────────────────
// Build a Job doc with sensible defaults. postedAt defaults to "now" so the
// default 12-month window in getSalaryInsights always includes it. dedupeKey
// is computed the same way both ingesters compute it.
let seq = 0;
function makeJob(overrides = {}) {
  const {
    source = "adzuna",
    companyName = "Acme",
    title = "Backend Developer",
    location = "Bangalore",
    normalizedRole = "backend",
    salaryDisclosed = true,
    midpoint = 1000,
    currency = "USD",
    postedAt = new Date(),
  } = overrides;

  const hasSalary = midpoint != null;
  return {
    externalId: `${source}:${++seq}`,
    source,
    title,
    normalizedRole,
    companyName,
    isRemote: false,
    requiredSkills: ["node.js"],
    salaryRange: hasSalary
      ? { min: midpoint, max: midpoint, midpoint, currency }
      : null,
    salaryDisclosed,
    location,
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, location),
  };
}

describe("getSalaryInsights — currency integrity", () => {
  it("dedupes a cross-source twin to a single row in the salary stats", async () => {
    // Same normalized company + title + location, one Adzuna + one JSearch,
    // both disclosed in USD. Must be counted once.
    await Job.create([
      makeJob({ source: "adzuna", currency: "USD", midpoint: 1000 }),
      makeJob({ source: "jsearch", currency: "USD", midpoint: 1000 }),
    ]);

    const res = await getSalaryInsights({});

    expect(res.totalCount).toBe(1);
    expect(res.disclosedCount).toBe(1);
    expect(res.byCurrency).toHaveLength(1);
    expect(res.byCurrency[0]).toMatchObject({ currency: "USD", count: 1 });
  });

  it("splits two currencies into separate buckets and never mixes them", async () => {
    await Job.create([
      makeJob({ companyName: "AlphaUS", currency: "USD", midpoint: 100000 }),
      makeJob({ companyName: "BetaUS", currency: "USD", midpoint: 120000 }),
      makeJob({ companyName: "GammaIN", currency: "INR", midpoint: 2000000 }),
    ]);

    const res = await getSalaryInsights({});

    expect(res.byCurrency).toHaveLength(2);
    const byCur = Object.fromEntries(
      res.byCurrency.map((b) => [b.currency, b]),
    );
    expect(byCur.USD.count).toBe(2);
    expect(byCur.INR.count).toBe(1);
    // The INR median is its own single value, never blended with the USD docs.
    expect(byCur.INR.median).toBe(2000000);
    // Every bucket key is a real currency code, never "UNKNOWN".
    expect(res.byCurrency.map((b) => b.currency)).not.toContain("UNKNOWN");
  });

  it("excludes a disclosed job with null currency (not bucketed as UNKNOWN)", async () => {
    await Job.create([
      makeJob({ companyName: "AlphaUS", currency: "USD", midpoint: 100000 }),
      makeJob({
        source: "jsearch",
        companyName: "NoCurrencyCo",
        currency: null,
        midpoint: 999999,
      }),
    ]);

    const res = await getSalaryInsights({});

    // Only the USD doc contributes to byCurrency.
    expect(res.byCurrency).toHaveLength(1);
    expect(res.byCurrency[0].currency).toBe("USD");
    expect(res.byCurrency.map((b) => b.currency)).not.toContain("UNKNOWN");
    expect(res.byCurrency.map((b) => b.currency)).not.toContain(null);
    // The null-currency midpoint must not leak into any bucket.
    expect(res.byCurrency[0].count).toBe(1);
    expect(res.byCurrency[0].max).toBe(100000);
  });

  it("never includes an undisclosed job in the disclosed stats", async () => {
    await Job.create([
      makeJob({ companyName: "AlphaUS", currency: "USD", midpoint: 100000 }),
      makeJob({
        companyName: "UndisclosedCo",
        salaryDisclosed: false,
        currency: "USD",
        midpoint: 500000,
      }),
    ]);

    const res = await getSalaryInsights({});

    expect(res.totalCount).toBe(2); // both count toward the deduped total
    expect(res.disclosedCount).toBe(1); // only the disclosed one in stats
    expect(res.byCurrency).toHaveLength(1);
    expect(res.byCurrency[0].count).toBe(1);
    expect(res.byCurrency[0].max).toBe(100000);
  });
});
