import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { clearTrendingCaches } from "./trendingSkills.js";
import {
  computeSkillForecast,
  clearSkillForecastCache,
  linearFit,
} from "./skillForecast.js";

// ── In-memory Mongo lifecycle ─────────────────────────────────────
// computeSkillForecast reads real getAllSkills (Job) + SkillSnapshot rows, so we
// exercise it end-to-end against a real MongoDB. Caches are cleared per test.
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
  clearSkillForecastCache();
});

// ── Helpers ──────────────────────────────────────────────
let seq = 0;
// A Job row so getAllSkills() surfaces the skill in the candidate universe with
// a real `demand` (current level).
function makeJob({ skills, company, title = "Engineer", postedAt = new Date() } = {}) {
  const companyName = company ?? `Co-${++seq}`;
  return {
    externalId: `adzuna:${++seq}`,
    source: "adzuna",
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills: skills,
    salaryRange: null,
    salaryDisclosed: false,
    location: "Bangalore",
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, "Bangalore"),
  };
}

// Seed `count` distinct-day Job rows for a skill so getAllSkills().demand === count.
async function seedDemand(skill, count) {
  const jobs = [];
  for (let i = 0; i < count; i++) jobs.push(makeJob({ company: `${skill}-${i}`, skills: [skill] }));
  await Job.create(jobs);
}

// A day-bucketed snapshot row (no capturedAt => pure momentum/forecast row).
function snap({ skill, date, postingCount }) {
  return { skill, date, postingCount };
}

// UTC-midnight day, `daysAgo` before now. Anchored to new Date() per the brief
// so the lookback window always contains the seeded series.
const ANCHOR = new Date();
function dayAgo(daysAgo) {
  const d = new Date(ANCHOR);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Build an evenly-spaced series of `n` daily points from `startY`, stepping by
// `stepY` each successive (more recent) day. Oldest point first.
function series(skill, n, startY, stepY, oldestDaysAgo = 180) {
  const rows = [];
  const stepDays = Math.floor(oldestDaysAgo / (n - 1));
  for (let i = 0; i < n; i++) {
    const daysAgo = oldestDaysAgo - i * stepDays;
    rows.push(snap({ skill, date: dayAgo(daysAgo), postingCount: Math.max(0, Math.round(startY + i * stepY)) }));
  }
  return rows;
}

describe("linearFit (pure math)", () => {
  it("recovers slope + intercept and reports R2 = 1 for a perfect line", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [10, 12, 14, 16, 18]; // y = 10 + 2x
    const { slope, intercept, r2 } = linearFit(xs, ys);
    expect(slope).toBeCloseTo(2, 6);
    expect(intercept).toBeCloseTo(10, 6);
    expect(r2).toBeCloseTo(1, 6);
  });

  it("reports R2 = 1 and slope 0 for a flat series", () => {
    const { slope, r2 } = linearFit([0, 1, 2, 3], [50, 50, 50, 50]);
    expect(slope).toBeCloseTo(0, 6);
    expect(r2).toBe(1);
  });
});

describe("computeSkillForecast — rising series", () => {
  it("projects forecast > current with changePct > 0 and a rising/accelerating trajectory", async () => {
    await seedDemand("react", 40);
    // Steadily rising: 20 -> ~200 across 10 points over ~180 days.
    await SkillSnapshot.create(series("react", 10, 20, 20));

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(res.insufficientHistory).toBe(false);
    const react = res.forecasts.find((f) => f.skill === "react");
    expect(react).toBeTruthy();
    expect(react.forecast).toBeGreaterThan(react.current);
    expect(react.changePct).toBeGreaterThan(0);
    expect(["rising", "accelerating"]).toContain(react.trajectory);
    expect(react.basisPoints).toBe(10);
    expect(react.horizonMonths).toBe(6);
  });
});

describe("computeSkillForecast — falling series", () => {
  it("declines and clamps forecast >= 0 even for a steep negative slope", async () => {
    await seedDemand("jquery", 30);
    // Steep fall: 200 -> ~20 across 10 points; projected 6mo out would go
    // negative if unclamped.
    await SkillSnapshot.create(series("jquery", 10, 200, -20));

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    const jq = res.forecasts.find((f) => f.skill === "jquery");
    expect(jq).toBeTruthy();
    expect(jq.trajectory).toBe("declining");
    expect(jq.forecast).toBeGreaterThanOrEqual(0); // never negative
    expect(jq.low).toBeGreaterThanOrEqual(0);
  });
});

describe("computeSkillForecast — flat series", () => {
  it("is plateauing with changePct approximately 0", async () => {
    await seedDemand("php", 25);
    await SkillSnapshot.create(series("php", 10, 100, 0)); // dead flat at 100

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    const php = res.forecasts.find((f) => f.skill === "php");
    expect(php).toBeTruthy();
    expect(php.trajectory).toBe("plateauing");
    expect(Math.abs(php.changePct)).toBeLessThanOrEqual(2);
  });
});

describe("computeSkillForecast — guards", () => {
  it("returns insufficientHistory when every candidate is below MIN_POINTS_FOR_FORECAST (no throw, no fabrication)", async () => {
    await seedDemand("rust", 10);
    // Only 2 points — below the minimum; must be skipped, not fabricated.
    await SkillSnapshot.create([
      snap({ skill: "rust", date: dayAgo(120), postingCount: 30 }),
      snap({ skill: "rust", date: dayAgo(10), postingCount: 40 }),
    ]);

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(res.insufficientHistory).toBe(true);
    expect(res.forecasts).toEqual([]);
  });

  it("returns insufficientHistory on an empty database (never throws)", async () => {
    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(res.insufficientHistory).toBe(true);
    expect(res.forecasts).toEqual([]);
  });
});

describe("computeSkillForecast — confidence band ordering", () => {
  it("always holds low <= forecast <= high", async () => {
    await seedDemand("react", 40);
    await seedDemand("vue", 30);
    await seedDemand("php", 25);
    // Noisy-but-rising react, falling vue, flat php — all with real residuals.
    await SkillSnapshot.create([
      ...series("react", 10, 20, 18),
      ...series("vue", 10, 180, -12),
      ...series("php", 10, 100, 0),
    ]);

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(res.forecasts.length).toBeGreaterThan(0);
    for (const f of res.forecasts) {
      expect(f.low).toBeLessThanOrEqual(f.forecast);
      expect(f.forecast).toBeLessThanOrEqual(f.high);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("computeSkillForecast — caching discipline", () => {
  it("serves identical known input from cache; does NOT cache an unknown role", async () => {
    await seedDemand("react", 40);
    await SkillSnapshot.create(series("react", 10, 20, 20));

    // Known input (role null) is cached: same object reference after DB wipe.
    const first = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    await Job.deleteMany({});
    await SkillSnapshot.deleteMany({});
    const second = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(second).toBe(first);

    // Unknown role is NEVER cached: it recomputes against the (now empty) DB.
    clearSkillForecastCache();
    const j1 = await computeSkillForecast({ role: "not-a-role", horizonMonths: 6, limit: 20 });
    await seedDemand("react", 40);
    await SkillSnapshot.create(series("react", 10, 20, 20));
    const j2 = await computeSkillForecast({ role: "not-a-role", horizonMonths: 6, limit: 20 });
    expect(j2).not.toBe(j1);
  });
});
