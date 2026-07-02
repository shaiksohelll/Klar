import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Env required at app module-load time (ESM hoists imports) ─────────────
vi.hoisted(() => {
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.INGEST_SECRET = "test-secret";
});

// Clerk mock (the forecast route is public, but app.js wires clerkMiddleware
// globally, so we stub it to a passthrough like the skill-gap route suite).
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  requireAuth: () => (req, res, next) => next(),
}));

// Avoid real ingest network/DB.
vi.mock("./ingest/adzuna.js", () => ({ ingestAdzuna: vi.fn().mockResolvedValue({}) }));
vi.mock("./ingest/jsearch.js", () => ({ ingestJSearch: vi.fn().mockResolvedValue({}) }));

// Stub the forecast engine so this suite only exercises the ROUTE contract.
const computeSkillForecast = vi.fn().mockResolvedValue({
  forecasts: [
    {
      skill: "react",
      current: 100,
      forecast: 140,
      changePct: 40,
      trajectory: "rising",
      confidence: 0.8,
      low: 120,
      high: 160,
      basisPoints: 10,
      horizonMonths: 6,
    },
  ],
  asOf: "2026-06-15T00:00:00.000Z",
  horizonMonths: 6,
  insufficientHistory: false,
});
vi.mock("./aggregations/skillForecast.js", () => ({ computeSkillForecast }));

// Job model is touched by other routes at import time only; stub minimally.
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
  computeSkillForecast.mockClear();
});

describe("/api/skills/forecast — valid requests", () => {
  it("returns 200 + the forecast shape for a default GET", async () => {
    const res = await request(app).get("/api/skills/forecast");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty("forecasts");
    expect(res.body).toHaveProperty("asOf");
    expect(res.body).toHaveProperty("horizonMonths");
    expect(res.body).toHaveProperty("insufficientHistory");
    expect(Array.isArray(res.body.forecasts)).toBe(true);
    // default horizon 6, default limit 20 forwarded to the engine.
    expect(computeSkillForecast).toHaveBeenCalledWith(
      expect.objectContaining({ horizonMonths: 6, limit: 20, role: null }),
    );
  });

  it("forwards a valid horizon + limit to the engine", async () => {
    const res = await request(app).get("/api/skills/forecast?horizon=12&limit=10");
    expect(res.status).toBe(200);
    expect(computeSkillForecast).toHaveBeenCalledWith(
      expect.objectContaining({ horizonMonths: 12, limit: 10 }),
    );
  });
});

describe("/api/skills/forecast — invalid requests (400, engine not called)", () => {
  it("400s on horizon above the [1,24] range", async () => {
    const res = await request(app).get("/api/skills/forecast?horizon=25");
    expect(res.status).toBe(400);
    expect(computeSkillForecast).not.toHaveBeenCalled();
  });

  it("400s on horizon below the range", async () => {
    const res = await request(app).get("/api/skills/forecast?horizon=0");
    expect(res.status).toBe(400);
    expect(computeSkillForecast).not.toHaveBeenCalled();
  });

  it("400s on a non-integer horizon", async () => {
    const res = await request(app).get("/api/skills/forecast?horizon=abc");
    expect(res.status).toBe(400);
    expect(computeSkillForecast).not.toHaveBeenCalled();
  });

  it("400s on limit above [1,50]", async () => {
    const res = await request(app).get("/api/skills/forecast?limit=51");
    expect(res.status).toBe(400);
    expect(computeSkillForecast).not.toHaveBeenCalled();
  });

  // Role does NOT affect forecast results (snapshots have no role dimension),
  // but the route still VALIDATES it for a stable, momentum-consistent API
  // contract, so an unknown role is a 400 rather than a silent no-op.
  it("400s on an unknown role (validation only; role does not change results)", async () => {
    const res = await request(app).get("/api/skills/forecast?role=wizard");
    expect(res.status).toBe(400);
    expect(computeSkillForecast).not.toHaveBeenCalled();
  });
});
