import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.INGEST_SECRET = "test-secret";
});

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  requireAuth: () => (req, res, next) => next(),
}));

vi.mock("./ingest/adzuna.js", () => ({
  ingestAdzuna: vi.fn().mockResolvedValue({}),
}));
vi.mock("./ingest/jsearch.js", () => ({
  ingestJSearch: vi.fn().mockResolvedValue({}),
}));

const backfillDailySkillBuckets = vi.fn();
vi.mock("./ingest/snapshot.js", () => ({ backfillDailySkillBuckets }));

const clearMomentumCache = vi.fn();
const clearSkillForecastCache = vi.fn();
vi.mock("./aggregations/skillMomentum.js", () => ({ clearMomentumCache }));
vi.mock("./aggregations/skillForecast.js", () => ({
  clearSkillForecastCache,
}));

vi.mock("./models/Job.js", () => ({
  default: {
    findOne: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    })),
    aggregate: vi.fn().mockResolvedValue([]),
    countDocuments: vi.fn().mockResolvedValue(0),
  },
}));

const { default: app } = await import("./app.js");
const { default: request } = await import("supertest");

beforeEach(() => {
  backfillDailySkillBuckets.mockReset();
  clearMomentumCache.mockReset();
  clearSkillForecastCache.mockReset();
});

describe("POST /api/admin/backfill-skill-buckets - auth", () => {
  it("401s without a secret and never runs backfill", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets");
    expect(res.status).toBe(401);
    expect(backfillDailySkillBuckets).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "nope");
    expect(res.status).toBe(401);
    expect(backfillDailySkillBuckets).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/backfill-skill-buckets - authorized", () => {
  it("200s and returns the backfill summary", async () => {
    backfillDailySkillBuckets.mockResolvedValue({
      ok: true,
      buckets: 42,
      minDate: "2025-06-01T00:00:00.000Z",
      maxDate: "2026-07-01T00:00:00.000Z",
      distinctSkills: 12,
    });
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      buckets: 42,
      distinctSkills: 12,
    });
    expect(backfillDailySkillBuckets).toHaveBeenCalledTimes(1);
    expect(clearMomentumCache).toHaveBeenCalledTimes(1);
    expect(clearSkillForecastCache).toHaveBeenCalledTimes(1);
  });

  it("500s on caught failure and keeps caches", async () => {
    backfillDailySkillBuckets.mockResolvedValue({
      ok: false,
      buckets: 0,
      minDate: null,
      maxDate: null,
      distinctSkills: 0,
      error: "boom",
    });
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(clearMomentumCache).not.toHaveBeenCalled();
    expect(clearSkillForecastCache).not.toHaveBeenCalled();
  });

  it("500s via central handler when backfill throws", async () => {
    backfillDailySkillBuckets.mockRejectedValue(
      new Error("unexpected throw"),
    );
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(clearMomentumCache).not.toHaveBeenCalled();
  });

  it("skips (200) a second backfill in progress", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    let signalStarted;
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });

    backfillDailySkillBuckets.mockImplementation(() => {
      signalStarted();
      return gate.then(() => ({
        ok: true,
        buckets: 1,
        minDate: null,
        maxDate: null,
        distinctSkills: 1,
      }));
    });

    const first = request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret")
      .then((r) => r);

    await started;

    const second = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      message: expect.stringMatching(/in progress/i),
    });

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(backfillDailySkillBuckets).toHaveBeenCalledTimes(1);
  });
});