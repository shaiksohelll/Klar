import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ──────────────────────────────────────────────────────────────────
// skillDetail issues several aggregate() calls + a Job.find() and calls
// getSkillPairs(). We stub all of them so the route runs without a DB; the
// point of these tests is the ?months clamp, captured off sinceDate().

let capturedMatch;

vi.mock("../models/Job.js", () => {
  const findChain = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  };
  return {
    default: {
      // Capture the $match of the FIRST aggregate call (the demand pipeline,
      // whose baseMatch.postedAt.$gte reflects the clamped months window).
      aggregate: vi.fn((pipeline) => {
        const match = pipeline?.find?.((s) => s && s.$match)?.$match;
        if (match && match.postedAt && capturedMatch === undefined) {
          capturedMatch = match;
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

import skillDetailRouter from "./skillDetail.js";

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

  it("clamps a zero/negative ?months up to 1", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=0");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(1);
  });

  it("defaults to 12 when ?months is absent or non-numeric", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=abc");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(12);
  });

  it("passes a valid in-range ?months through unchanged", async () => {
    const res = await request(makeApp()).get("/api/skill/react?months=6");
    expect(res.status).toBe(200);
    expect(monthsFromSince(capturedMatch.postedAt.$gte, now)).toBe(6);
  });
});
