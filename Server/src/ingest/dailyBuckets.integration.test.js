import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { backfillDailySkillBuckets } from "./snapshot.js";
import { computeSkillForecast, clearSkillForecastCache } from "../aggregations/skillForecast.js";
import { computeSkillMomentum, clearMomentumCache } from "../aggregations/skillMomentum.js";
import { clearTrendingCaches } from "../aggregations/trendingSkills.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
  await SkillSnapshot.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Job.deleteMany({});
  await SkillSnapshot.deleteMany({});
  clearTrendingCaches();
  clearMomentumCache();
  clearSkillForecastCache();
});

let seq = 0;
function makeJob({ requiredSkills, postedAt }) {
  const companyName = `Co${++seq}`;
  const title = "Backend Developer";
  const location = "Bangalore";
  return {
    externalId: `adzuna:${++seq}`,
    source: "adzuna",
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills,
    salaryRange: null,
    salaryDisclosed: false,
    location,
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, location),
  };
}

// noon UTC on the day `daysAgo` before now.
function postedOn(daysAgo) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

describe("backfill -> forecast + momentum end to end", () => {
  it("forecast returns >= MIN_POINTS basis points with a non-empty forecast", async () => {
    // Seed react across 8 distinct days within the 12-month lookback, rising
    // volume. Each day gets (i+1) postings so getAllSkills ranks react highly
    // and the day-bucket series has 8 distinct dated points.
    const jobs = [];
    const days = [180, 150, 120, 90, 60, 40, 20, 0];
    days.forEach((d, i) => {
      for (let k = 0; k <= i; k++) jobs.push(makeJob({ requiredSkills: ["react"], postedAt: postedOn(d) }));
    });
    await Job.create(jobs);

    const back = await backfillDailySkillBuckets();
    expect(back.ok).toBe(true);
    expect(back.distinctSkills).toBe(1);

    const res = await computeSkillForecast({ horizonMonths: 6, limit: 20 });
    expect(res.insufficientHistory).toBe(false);
    const react = res.forecasts.find((f) => f.skill === "react");
    expect(react).toBeTruthy();
    expect(react.basisPoints).toBeGreaterThanOrEqual(4); // MIN_POINTS_FOR_FORECAST
    expect(Number.isFinite(react.forecast)).toBe(true);
    expect(react.forecast).toBeGreaterThan(0);
  });

  it("momentum returns a value for a skill present in two adjacent windows", async () => {
    // window = 1 month. Need react in both the current (<=30d) and prior
    // (30-60d) windows relative to the latest banked bucket (today).
    const jobs = [];
    // prior window: ~45 days ago, 2 postings
    jobs.push(makeJob({ requiredSkills: ["react"], postedAt: postedOn(45) }));
    jobs.push(makeJob({ requiredSkills: ["react"], postedAt: postedOn(45) }));
    // current window: today, 5 postings (rising)
    for (let k = 0; k < 5; k++) jobs.push(makeJob({ requiredSkills: ["react"], postedAt: postedOn(0) }));
    await Job.create(jobs);

    const back = await backfillDailySkillBuckets();
    expect(back.ok).toBe(true);

    const res = await computeSkillMomentum({ windowMonths: 1, limit: 20 });
    expect(res.insufficientHistory).toBe(false);
    const react =
      res.risers.find((r) => r.skill === "react") ||
      res.fallers.find((f) => f.skill === "react");
    expect(react).toBeTruthy();
    expect(react.current).toBe(5);
    expect(react.previous).toBe(2);
    expect(react.direction).toBe("rising");
  });
});
