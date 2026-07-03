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

// Cache-clear hooks called by the route on success — stub them out.
vi.mock("./aggregations/skillMomentum.js", () => ({ clearMomentumCache: vi.fn() }));
vi.mock("./aggregations/skillForecast.js", () => ({ clearSkillForecastCache: vi.fn() }));

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
  });

  it("500s when the backfill reports a caught failure (ok:false)", async () => {
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
  });
});
