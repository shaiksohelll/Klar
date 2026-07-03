import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Env required at app module-load time (ESM hoists imports) ─────────
vi.hoisted(() => {
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.INGEST_SECRET = "test-secret";
});

// Clerk passthrough (this route is secret-gated, not Clerk-gated).
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  requireAuth: () => (req, res, next) => next(),
}));

// Avoid real ingest network/DB.
vi.mock("./ingest/adzuna.js", () => ({ ingestAdzuna: vi.fn().mockResolvedValue({}) }));
vi.mock("./ingest/jsearch.js", () => ({ ingestJSearch: vi.fn().mockResolvedValue({}) }));

// Stub the backfill engine so this suite exercises only the route contract.
const backfillDailySkillBuckets = vi.fn();
vi.mock("./ingest/snapshot.js", () => ({ backfillDailySkillBuckets }));

// Cache-clear hooks called by the route on success — stub them so we can assert
// the route invokes them (only on ok:true).
const clearMomentumCache = vi.fn();
const clearSkillForecastCache = vi.fn();
vi.mock("./aggregations/skillMomentum.js", () => ({ clearMomentumCache }));
vi.mock("./aggregations/skillForecast.js", () => ({ clearSkillForecastCache }));

// Job model is touched by other routes at import time; stub minimally.
vi.mock("./models/Job.js", () => ({
  default: {
    findOne: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(null) })),
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

describe("POST /api/admin/backfill-skill-buckets — auth", () => {
  it("401s without a secret and never runs the backfill", async () => {
    const res = await request(app).post("/api/admin/backfill-skill-buckets");
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

describe("POST /api/admin/backfill-skill-buckets — authorized", () => {
  it("200s and returns the backfill summary on success", async () => {
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
    expect(res.body).toMatchObject({ ok: true, buckets: 42, distinctSkills: 12 });
    expect(backfillDailySkillBuckets).toHaveBeenCalledTimes(1);
    // Side effect: both read caches are cleared on success so the next
    // momentum/forecast read reflects the freshly-banked history.
    expect(clearMomentumCache).toHaveBeenCalledTimes(1);
    expect(clearSkillForecastCache).toHaveBeenCalledTimes(1);
  });

  it("500s when the backfill reports a caught failure (ok:false) and does NOT clear caches", async () => {
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
    // On a caught failure the passthrough result is returned verbatim and the
    // caches are left intact (nothing new was written).
    expect(clearMomentumCache).not.toHaveBeenCalled();
    expect(clearSkillForecastCache).not.toHaveBeenCalled();
  });

  it("500s via the central error handler when the backfill THROWS (outer catch)", async () => {
    // The engine normally swallows its own errors, but if it ever rejects the
    // route's try/catch must forward to next(err) → central 500 handler.
    backfillDailySkillBuckets.mockRejectedValue(new Error("unexpected throw"));
    const res = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(clearMomentumCache).not.toHaveBeenCalled();
  });

  it("skips (200) a second backfill while one is already in progress", async () => {
    // Hold the first backfill open until we release it, so the second request
    // arrives while the in-flight guard is set.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    backfillDailySkillBuckets.mockImplementation(
      () => gate.then(() => ({ ok: true, buckets: 1, minDate: null, maxDate: null, distinctSkills: 1 })),
    );

    const first = request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");

    // Give the first request a tick to enter the handler and set the flag.
    await new Promise((r) => setTimeout(r, 20));

    const second = await request(app)
      .post("/api/admin/backfill-skill-buckets")
      .set("x-ingest-secret", "test-secret");
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, message: expect.stringMatching(/in progress/i) });

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    // Only the first run actually invoked the engine.
    expect(backfillDailySkillBuckets).toHaveBeenCalledTimes(1);
  });
});
