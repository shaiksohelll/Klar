import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { recordSkillMomentumSnapshot, dayBucket } from "./snapshot.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────────
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
  await SkillSnapshot.deleteMany({});
});

let seq = 0;
function makeJob(overrides = {}) {
  const {
    source = "adzuna",
    companyName = `Co${++seq}`,
    title = "Backend Developer",
    location = "Bangalore",
    requiredSkills = ["node.js"],
    salaryDisclosed = false,
    midpoint = null,
    currency = "INR",
    postedAt = new Date(),
  } = overrides;

  return {
    externalId: `${source}:${seq}`,
    source,
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills,
    salaryRange: midpoint == null ? null : { min: midpoint, max: midpoint, midpoint, currency },
    salaryDisclosed,
    location,
    redirectUrl: "",
    postedAt,
    dedupeKey: makeDedupeKey(companyName, title, location),
  };
}

describe("recordSkillMomentumSnapshot — writing + idempotency", () => {
  it("banks one dated row per skill with correct posting + disclosed counts", async () => {
    await Job.create([
      makeJob({ requiredSkills: ["node.js"], salaryDisclosed: true, midpoint: 1_000_000, currency: "INR" }),
      makeJob({ requiredSkills: ["node.js"], salaryDisclosed: false }),
      makeJob({ requiredSkills: ["react"], salaryDisclosed: true, midpoint: 2_000_000, currency: "INR" }),
    ]);

    const res = await recordSkillMomentumSnapshot();
    expect(res.ok).toBe(true);
    expect(res.skills).toBe(2);

    const node = await SkillSnapshot.findOne({ skill: "node.js", date: dayBucket() }).lean();
    expect(node.postingCount).toBe(2);
    expect(node.disclosedCount).toBe(1);
    expect(node.salaryMidpointMedian).toBe(1_000_000);

    const react = await SkillSnapshot.findOne({ skill: "react", date: dayBucket() }).lean();
    expect(react.postingCount).toBe(1);
    expect(react.salaryMidpointMedian).toBe(2_000_000);
  });

  it("is idempotent per (skill, date): a second run updates, never duplicates", async () => {
    await Job.create([makeJob({ requiredSkills: ["node.js"] })]);
    await recordSkillMomentumSnapshot();
    await recordSkillMomentumSnapshot();

    const rows = await SkillSnapshot.find({ skill: "node.js", date: dayBucket() }).lean();
    expect(rows).toHaveLength(1);
  });

  it("computes the median from disclosed INR midpoints ONLY (ignores other currencies + undisclosed)", async () => {
    await Job.create([
      makeJob({ requiredSkills: ["go"], salaryDisclosed: true, midpoint: 1_000_000, currency: "INR" }),
      makeJob({ requiredSkills: ["go"], salaryDisclosed: true, midpoint: 3_000_000, currency: "INR" }),
      // USD disclosed — must be excluded from the INR median.
      makeJob({ requiredSkills: ["go"], salaryDisclosed: true, midpoint: 999_999_999, currency: "USD" }),
      // INR but undisclosed — must be excluded.
      makeJob({ requiredSkills: ["go"], salaryDisclosed: false, midpoint: 500_000, currency: "INR" }),
    ]);

    await recordSkillMomentumSnapshot();
    const go = await SkillSnapshot.findOne({ skill: "go", date: dayBucket() }).lean();
    // Median of [1_000_000, 3_000_000] = 2_000_000.
    expect(go.salaryMidpointMedian).toBe(2_000_000);
    expect(go.disclosedCount).toBe(3); // all three disclosed rows (any currency)
  });

  it("records null median for a skill with no disclosed INR rows", async () => {
    await Job.create([makeJob({ requiredSkills: ["php"], salaryDisclosed: false })]);
    await recordSkillMomentumSnapshot();
    const php = await SkillSnapshot.findOne({ skill: "php", date: dayBucket() }).lean();
    expect(php.salaryMidpointMedian).toBeNull();
  });
});

describe("recordSkillMomentumSnapshot — non-fatal contract", () => {
  it("returns ok:false and NEVER throws when the aggregation layer errors", async () => {
    // Force the DB read to throw; the helper must catch it and resolve.
    const spy = vi.spyOn(Job, "aggregate").mockRejectedValueOnce(new Error("boom"));

    let result;
    await expect(
      (async () => {
        result = await recordSkillMomentumSnapshot();
      })(),
    ).resolves.toBeUndefined();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    spy.mockRestore();
  });

  it("returns ok:true skipped:true when there are no jobs", async () => {
    const res = await recordSkillMomentumSnapshot();
    expect(res).toMatchObject({ ok: true, skills: 0, skipped: true });
  });
});
