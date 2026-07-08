// ── trendingSkills salary-integrity tests ─────────────────────────────────────
//
// Verifies that getTrendingSkills:
//   1. avgSalary is the mean of DISCLOSED INR midpoints only (hand-computed).
//   2. Predicted (salaryDisclosed: false) jobs are excluded from avgSalary.
//   3. Non-INR jobs (e.g. currency: "USD") are excluded from avgSalary.
//   4. limitedData: true when disclosedCount < 5; false when disclosedCount >= 5.
//   5. avgSalary: null when no disclosed-INR postings exist for the skill.
//   6. fmtINR — Indian lakh/K formatting contract (pure function; no DB).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { getTrendingSkills, clearTrendingCaches } from "./trendingSkills.js";

// ── In-memory Mongo lifecycle ──────────────────────────────────────────────────
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
  clearTrendingCaches();
});

// ── Helpers ────────────────────────────────────────────────────────────────────
let seq = 0;

/**
 * Builds a Job document with sensible defaults.
 * postedAt defaults to now so the default 12-month window always includes it.
 * Each call gets a unique externalId via the `seq` counter.
 *
 * Two ways to set the salary:
 *   - Pass `midpoint` + `currency` → shorthand; builds { min, max, midpoint, currency }.
 *   - Pass `salaryRange` explicitly → used as-is (allows null/zero midpoint tests
 *     that must reach the $isNumber / $gt:0 guards in the aggregation).
 */
function makeJob(overrides = {}) {
  const {
    source          = "adzuna",
    companyName     = `TestCo${++seq}`,
    title           = "Developer",
    location        = "Bangalore",
    normalizedRole  = "backend",
    salaryDisclosed = true,
    midpoint        = null,
    currency        = "INR",
    salaryRange     = undefined,   // explicit override — takes precedence over midpoint
    requiredSkills  = ["react"],
    postedAt        = new Date(),
  } = overrides;

  // If caller supplied an explicit salaryRange (even {midpoint:null,...}), use it.
  // Otherwise fall back to the shorthand: non-null midpoint → build object, null → null.
  const resolvedSalaryRange =
    salaryRange !== undefined
      ? salaryRange
      : midpoint != null
        ? { min: midpoint, max: midpoint, midpoint, currency }
        : null;

  return {
    externalId:      `${source}:sal${seq}`,
    source,
    title,
    normalizedRole,
    companyName,
    isRemote:        false,
    requiredSkills,
    salaryRange:     resolvedSalaryRange,
    salaryDisclosed,
    location,
    redirectUrl:     "",
    postedAt,
    dedupeKey:       makeDedupeKey(companyName, title, location),
  };
}

// ── 1. Disclosed INR average — hand-computed fixture ──────────────────────────

describe("getTrendingSkills — avgSalary integrity", () => {
  it("computes the mean of disclosed INR midpoints only (hand-computed)", async () => {
    // Three distinct jobs (distinct company → no dedupe merge), each requiring
    // "react", all disclosed INR.
    // Hand-computed mean: (1_000_000 + 2_000_000 + 3_000_000) / 3 = 2_000_000
    await Job.create([
      makeJob({ midpoint: 1_000_000, currency: "INR" }),
      makeJob({ midpoint: 2_000_000, currency: "INR" }),
      makeJob({ midpoint: 3_000_000, currency: "INR" }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.avgSalary).toBe(2_000_000);
  });

  // ── 2. Predicted jobs excluded ───────────────────────────────────────────────

  it("excludes predicted (salaryDisclosed: false) jobs from avgSalary", async () => {
    await Job.create([
      // Only this one should contribute.
      makeJob({ midpoint: 2_000_000, currency: "INR", salaryDisclosed: true }),
      // Predicted — must be excluded.
      makeJob({ midpoint: 9_000_000, currency: "INR", salaryDisclosed: false }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.avgSalary).toBe(2_000_000);
  });

  // ── 3. Non-INR jobs excluded ─────────────────────────────────────────────────

  it("excludes non-INR disclosed jobs from avgSalary", async () => {
    await Job.create([
      // Only this one should contribute.
      makeJob({ midpoint: 2_000_000, currency: "INR",  salaryDisclosed: true }),
      // Disclosed USD — must be excluded from INR avg.
      makeJob({ midpoint:   200_000, currency: "USD",  salaryDisclosed: true }),
      // Disclosed GBP — must be excluded from INR avg.
      makeJob({ midpoint:   150_000, currency: "GBP",  salaryDisclosed: true }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.avgSalary).toBe(2_000_000);
  });

  // ── 4. limitedData threshold ─────────────────────────────────────────────────

  it("sets limitedData: true when disclosedCount < 5", async () => {
    // 3 disclosed INR jobs — below the threshold of 5.
    await Job.create([
      makeJob({ midpoint: 1_000_000 }),
      makeJob({ midpoint: 2_000_000 }),
      makeJob({ midpoint: 3_000_000 }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.disclosedCount).toBe(3);
    expect(skill.limitedData).toBe(true);
  });

  it("sets limitedData: false when disclosedCount >= 5", async () => {
    // Exactly 5 disclosed INR jobs — at the threshold, limitedData must be false.
    await Job.create([
      makeJob({ midpoint: 1_000_000 }),
      makeJob({ midpoint: 2_000_000 }),
      makeJob({ midpoint: 3_000_000 }),
      makeJob({ midpoint: 4_000_000 }),
      makeJob({ midpoint: 5_000_000 }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.disclosedCount).toBe(5);
    expect(skill.limitedData).toBe(false);
  });

  // ── 5. Null avgSalary when no qualifying postings exist ──────────────────────

  it("sets avgSalary: null when no disclosed-INR postings exist for the skill", async () => {
    await Job.create([
      // Disclosed but USD.
      makeJob({ midpoint: 100_000, currency: "USD", salaryDisclosed: true }),
      // INR but undisclosed.
      makeJob({ midpoint: 2_000_000, currency: "INR", salaryDisclosed: false }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    expect(skill.avgSalary).toBeNull();
    expect(skill.disclosedCount).toBe(0);
    expect(skill.limitedData).toBe(true); // 0 < 5
  });

  it("excludes disclosed-INR doc with null midpoint from both avgSalary and disclosedCount", async () => {
    // Uses explicit salaryRange override so the doc reaches the $isNumber guard
    // (makeJob({midpoint:null}) would set salaryRange:null, excluding the doc
    // before the guard via the currency check — not what we want to test here).
    await Job.create([
      makeJob({ midpoint: 1_000_000, currency: "INR", salaryDisclosed: true }),
      // Disclosed + INR + salaryRange present, but midpoint is null — excluded by $isNumber.
      makeJob({
        salaryDisclosed: true,
        salaryRange: { min: null, max: null, midpoint: null, currency: "INR" },
      }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    // Null-midpoint doc must not inflate disclosedCount or skew avgSalary.
    expect(skill.disclosedCount).toBe(1);
    expect(skill.avgSalary).toBe(1_000_000);
    expect(skill.limitedData).toBe(true); // 1 < 5
  });

  it("excludes disclosed-INR doc with zero midpoint from both avgSalary and disclosedCount", async () => {
    // A midpoint of 0 passes $isNumber but fails $gt:0 — must be excluded.
    await Job.create([
      makeJob({ midpoint: 2_000_000, currency: "INR", salaryDisclosed: true }),
      // Disclosed + INR + numeric midpoint, but zero — excluded by $gt:0.
      makeJob({
        salaryDisclosed: true,
        salaryRange: { min: 0, max: 0, midpoint: 0, currency: "INR" },
      }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    // Zero-midpoint doc must not inflate disclosedCount or pull avgSalary toward 0.
    expect(skill.disclosedCount).toBe(1);
    expect(skill.avgSalary).toBe(2_000_000);
    expect(skill.limitedData).toBe(true); // 1 < 5
  });
});

// ── 6. ₹ formatting — Indian lakh/K contract (pure function; no DB) ───────────
//
// fmtINR mirrors the logic in Client/src/components/RankingList.jsx.
// Tested here as a pure function to keep the contract verifiable in the
// server test suite without a browser runtime.

describe("fmtINR — Indian lakh/K formatting contract", () => {
  // Inline copy of the pure formatting function (no imports from client code).
  function fmtINR(n) {
    if (n == null || !isFinite(n)) return null;
    const l = n / 100_000;
    return l >= 1
      ? `${l % 1 === 0 ? l : l.toFixed(1)}L`
      : `${Math.round(n / 1000)}K`;
  }

  it("formats exactly 10L (₹10,00,000)", () => {
    expect(fmtINR(1_000_000)).toBe("10L");
  });

  it("formats exactly 15L (₹15,00,000)", () => {
    expect(fmtINR(1_500_000)).toBe("15L");
  });

  it("formats a fractional lakh to one decimal (₹15,50,000 → 15.5L)", () => {
    expect(fmtINR(1_550_000)).toBe("15.5L");
  });

  it("formats sub-1L values in K (₹75,000 → 75K)", () => {
    expect(fmtINR(75_000)).toBe("75K");
  });

  it("returns null for null input", () => {
    expect(fmtINR(null)).toBeNull();
  });

  it("returns null for non-finite input", () => {
    expect(fmtINR(Infinity)).toBeNull();
    expect(fmtINR(NaN)).toBeNull();
  });
});
