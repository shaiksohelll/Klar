import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { clearTrendingCaches } from "./trendingSkills.js";
import { clearPairsCache } from "./skillPairs.js";
import { clearSalaryCache } from "./salaryInsights.js";
import { clearMomentumCache } from "./skillMomentum.js";
import { computeSkillGapRoi, clearSkillGapRoiCache } from "./skillGapRoi.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────────
// computeSkillGapRoi fuses four real aggregations (getAllSkills, getSkillPairs,
// getSalaryInsights, computeSkillMomentum), so we exercise it end-to-end against
// a real MongoDB. Every cache is cleared between tests for determinism.
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Job.deleteMany({});
  await SkillSnapshot.deleteMany({});
  clearTrendingCaches();
  clearPairsCache();
  clearSalaryCache();
  clearMomentumCache();
  clearSkillGapRoiCache();
});

// ── Helpers ───────────────────────────────────────────────────
let seq = 0;
function makeJob({
  skills,
  company,
  salaryDisclosed = false,
  midpoint = null,
  currency = "INR",
  title = "Engineer",
  postedAt = new Date(),
} = {}) {
  const companyName = company ?? `Co-${++seq}`;
  return {
    externalId: `adzuna:${++seq}`,
    source: "adzuna",
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills: skills,
    salaryRange: midpoint == null ? null : { min: midpoint, max: midpoint, midpoint, currency },
    salaryDisclosed,
    location: "Bangalore",
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, "Bangalore"),
  };
}

// Day-bucketed momentum snapshot row (no capturedAt — pure momentum row).
function snap({ skill, date, postingCount, salaryMidpointMedian = null }) {
  return { skill, date, postingCount, salaryMidpointMedian };
}
const ANCHOR = new Date();
function dayAgo(n) {
  const d = new Date(ANCHOR);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe("computeSkillGapRoi — candidate exclusion", () => {
  it("excludes known skills AND their aliases from candidates", async () => {
    // The user knows node.js. Seed jobs so react + node.js + express are in demand.
    await Job.create([
      makeJob({ skills: ["node.js", "react"] }),
      makeJob({ skills: ["node.js", "express"] }),
      makeJob({ skills: ["react", "express"] }),
    ]);

    // Pass the ALIAS "nodejs" as known — it must exclude canonical "node.js".
    const res = await computeSkillGapRoi({ knownSkills: ["nodejs"], limit: 20 });
    const skills = res.recommendations.map((r) => r.skill);

    expect(skills).not.toContain("node.js"); // canonical of the alias
    expect(skills).toContain("react");
    expect(skills).toContain("express");
    expect(res.basedOn.knownSkillCount).toBe(1);
  });
});

describe("computeSkillGapRoi — ranking", () => {
  it("ranks a rising + high-salary + strongly co-occurring candidate above a flat/low one", async () => {
    // Known skill: node.js. Two candidates:
    //   react   — co-occurs with node.js a LOT, disclosed INR high, rising.
    //   php     — never co-occurs with node.js, low disclosed INR, flat.
    const jobs = [];
    // node.js + react appear together many times (strong affinity), high salary.
    for (let i = 0; i < 12; i++) {
      jobs.push(makeJob({ company: `NR-${i}`, skills: ["node.js", "react"], salaryDisclosed: true, midpoint: 2_000_000, currency: "INR" }));
    }
    // node.js baseline salary (lower than react) so react shows a positive lift.
    for (let i = 0; i < 8; i++) {
      jobs.push(makeJob({ company: `N-${i}`, skills: ["node.js"], salaryDisclosed: true, midpoint: 1_000_000, currency: "INR" }));
    }
    // php: standalone, low salary, does not co-occur with node.js.
    for (let i = 0; i < 6; i++) {
      jobs.push(makeJob({ company: `P-${i}`, skills: ["php"], salaryDisclosed: true, midpoint: 600_000, currency: "INR" }));
    }
    await Job.create(jobs);

    // Momentum: react rising strongly, php flat.
    await SkillSnapshot.create([
      snap({ skill: "react", date: dayAgo(135), postingCount: 8 }),  // prior 3-mo window
      snap({ skill: "react", date: dayAgo(10), postingCount: 16 }),  // recent window → +100%
      snap({ skill: "php", date: dayAgo(135), postingCount: 6 }),
      snap({ skill: "php", date: dayAgo(10), postingCount: 6 }),     // flat
    ]);

    const res = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    const rankOf = (skill) => res.recommendations.findIndex((r) => r.skill === skill);

    expect(rankOf("react")).toBeGreaterThanOrEqual(0);
    expect(rankOf("php")).toBeGreaterThanOrEqual(0);
    expect(rankOf("react")).toBeLessThan(rankOf("php")); // react outranks php

    const react = res.recommendations[rankOf("react")];
    // react carries all three WHY badges.
    expect(react.reasons.some((r) => r.includes("rising"))).toBe(true);
    expect(react.reasons.some((r) => r.includes("median"))).toBe(true);
    expect(react.reasons.some((r) => r.includes("pairs with your node.js"))).toBe(true);
  });
});

describe("computeSkillGapRoi — salary lift (disclosed INR only)", () => {
  it("computes salaryLiftPct from disclosed-INR midpoints only, ignoring other currencies + undisclosed", async () => {
    const jobs = [];
    // Known: node.js baseline = 1,000,000 INR disclosed.
    for (let i = 0; i < 6; i++) {
      jobs.push(makeJob({ company: `N-${i}`, skills: ["node.js"], salaryDisclosed: true, midpoint: 1_000_000, currency: "INR" }));
    }
    // Candidate react: disclosed INR median 1,500,000 (+50% vs baseline).
    for (let i = 0; i < 6; i++) {
      jobs.push(makeJob({ company: `R-${i}`, skills: ["react"], salaryDisclosed: true, midpoint: 1_500_000, currency: "INR" }));
    }
    // Noise that must be IGNORED for react's INR median:
    //  - a huge USD disclosed salary, and an undisclosed INR salary.
    jobs.push(makeJob({ company: "R-usd", skills: ["react"], salaryDisclosed: true, midpoint: 999_999_999, currency: "USD" }));
    jobs.push(makeJob({ company: "R-undisc", skills: ["react"], salaryDisclosed: false, midpoint: 50_000, currency: "INR" }));
    await Job.create(jobs);

    const res = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    const react = res.recommendations.find((r) => r.skill === "react");
    expect(react).toBeTruthy();
    // (1.5M - 1.0M) / 1.0M = +50%. USD + undisclosed rows never leak in.
    expect(react.salaryLiftPct).toBe(50);
  });
});

describe("computeSkillGapRoi — affinity", () => {
  it("reflects skillPairs co-occurrence with the user's known skills", async () => {
    // node.js co-occurs with react in EVERY node.js posting (100%), with graphql
    // in only some. react should carry higher affinity than graphql.
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(makeJob({ company: `NR-${i}`, skills: ["node.js", "react"] }));
    }
    for (let i = 0; i < 3; i++) {
      jobs.push(makeJob({ company: `NG-${i}`, skills: ["node.js", "graphql"] }));
    }
    await Job.create(jobs);

    const res = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    const react = res.recommendations.find((r) => r.skill === "react");
    const graphql = res.recommendations.find((r) => r.skill === "graphql");
    expect(react).toBeTruthy();
    expect(graphql).toBeTruthy();
    expect(react.affinity).toBeGreaterThan(graphql.affinity);
    expect(react.reasons.some((r) => r.includes("pairs with your node.js"))).toBe(true);
  });
});

describe("computeSkillGapRoi — input validation + caching", () => {
  it("drops unknown roles/skills from input and does NOT cache junk; identical known input hits cache", async () => {
    await Job.create([
      makeJob({ skills: ["node.js", "react"] }),
      makeJob({ skills: ["node.js", "express"] }),
    ]);

    // Unknown skill "quantum-basket-weaving" is dropped; knownSkillCount counts
    // only the resolved "node.js".
    const res = await computeSkillGapRoi({
      knownSkills: ["node.js", "quantum-basket-weaving"],
      limit: 20,
    });
    expect(res.basedOn.knownSkillCount).toBe(1);

    // Cache hit: identical known input returns the SAME object reference even
    // after the DB is wiped (proves it came from cache, not a recompute).
    const first = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    await Job.deleteMany({});
    const second = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    expect(second).toBe(first);

    // An UNKNOWN role is not cached: it recomputes against the (now empty) DB.
    clearSkillGapRoiCache();
    const j1 = await computeSkillGapRoi({ knownSkills: ["node.js"], role: "not-a-role", limit: 20 });
    await Job.create([makeJob({ skills: ["node.js", "vue"] })]);
    const j2 = await computeSkillGapRoi({ knownSkills: ["node.js"], role: "not-a-role", limit: 20 });
    expect(j2).not.toBe(j1); // never served from cache
  });
});

describe("computeSkillGapRoi — guards (never throw)", () => {
  it("thin momentum history still returns ranked recommendations (no throw)", async () => {
    // Jobs exist (so candidates + demand + affinity exist) but there is NO
    // day-bucketed momentum history at all.
    await Job.create([
      makeJob({ skills: ["node.js", "react"] }),
      makeJob({ skills: ["node.js", "express"] }),
    ]);

    const res = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    expect(res.insufficientData).toBe(false);
    expect(res.recommendations.length).toBeGreaterThan(0);
    // With no momentum data, momentumPct is null and no rising badge appears.
    for (const rec of res.recommendations) {
      expect(rec.momentumPct).toBeNull();
      expect(rec.reasons.every((r) => !r.includes("rising"))).toBe(true);
    }
  });

  it("sets insufficientData:true when there is genuinely nothing to recommend", async () => {
    // Empty DB — no candidates at all.
    const res = await computeSkillGapRoi({ knownSkills: ["node.js"], limit: 20 });
    expect(res.insufficientData).toBe(true);
    expect(res.recommendations).toEqual([]);
  });
});
