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
 */
function makeJob(overrides = {}) {
  const {
    source         = "adzuna",
    companyName    = `TestCo${++seq}`,
    title          = "Developer",
    location       = "Bangalore",
    normalizedRole = "backend",
    salaryDisclosed = true,
    midpoint       = null,
    currency       = "INR",
    requiredSkills = ["react"],
    postedAt       = new Date(),
  } = overrides;

  const hasSalary = midpoint != null;
  return {
    externalId:      `${source}:sal${seq}`,
    source,
    title,
    normalizedRole,
    companyName,
    isRemote:        false,
    requiredSkills,
    salaryRange:     hasSalary
      ? { min: midpoint, max: midpoint, midpoint, currency }
      : null,
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

  it("does not count a disclosed-INR doc with null midpoint toward disclosedCount", async () => {
    // This doc is disclosed+INR but has no midpoint → must NOT inflate disclosedCount,
    // which would cause limitedData to be understated relative to avgSalary's contributors.
    await Job.create([
      makeJob({ midpoint: 1_000_000, currency: "INR", salaryDisclosed: true }),
      // Disclosed + INR but null midpoint — must not be counted.
      makeJob({ midpoint: null, currency: "INR", salaryDisclosed: true }),
    ]);

    const res = await getTrendingSkills({ months: 12, limit: 10 });
    const skill = res.skills.find((s) => s.skill === "react");

    expect(skill).toBeDefined();
    // Only 1 doc has a valid midpoint — disclosedCount must be 1, not 2.
    expect(skill.disclosedCount).toBe(1);
    expect(skill.avgSalary).toBe(1_000_000);
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
