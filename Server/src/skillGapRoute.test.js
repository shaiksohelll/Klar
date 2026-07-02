import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Env required at app module-load time ───────────────────────────────
vi.hoisted(() => {
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.INGEST_SECRET = "test-secret";
});

// ── Clerk mock: requireAuth() rejects when there is NO Authorization header ──
// This mirrors the real @clerk/express behaviour closely enough to prove the
// route is genuinely guarded (a missing/blank token → 401) without needing real
// Clerk keys. When a token IS present we populate req.auth.userId like Clerk.
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  requireAuth: () => (req, res, next) => {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    req.auth = { userId: "user_test_1" };
    next();
  },
}));

// Avoid real ingest network/DB.
vi.mock("./ingest/adzuna.js", () => ({ ingestAdzuna: vi.fn().mockResolvedValue({}) }));
vi.mock("./ingest/jsearch.js", () => ({ ingestJSearch: vi.fn().mockResolvedValue({}) }));

// Stub the ROI brain so this suite only exercises the ROUTE contract.
const computeSkillGapRoi = vi.fn().mockResolvedValue({
  recommendations: [{ skill: "react", roiScore: 0.8, demand: 100, momentumPct: 40, salaryLiftPct: 20, affinity: 50, reasons: ["📈 rising 40%"] }],
  asOf: "2026-06-15T00:00:00.000Z",
  basedOn: { knownSkillCount: 1, role: null },
  insufficientData: false,
});
vi.mock("./aggregations/skillGapRoi.js", () => ({ computeSkillGapRoi }));

// Watchlist.find(...).lean() returns the caller's tracked skills.
const watchlistLean = vi.fn().mockResolvedValue([{ skill: "node.js" }]);
vi.mock("./models/Watchlist.js", () => ({
  default: { find: vi.fn(() => ({ lean: watchlistLean })) },
}));

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
  computeSkillGapRoi.mockClear();
  watchlistLean.mockClear();
});

describe("/api/skill-gap — auth guard", () => {
  it("rejects an unauthenticated GET with 401", async () => {
    const res = await request(app).get("/api/skill-gap");
    expect(res.status).toBe(401);
    expect(computeSkillGapRoi).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated POST with 401", async () => {
    const res = await request(app).post("/api/skill-gap").send({ knownSkills: ["react"] });
    expect(res.status).toBe(401);
    expect(computeSkillGapRoi).not.toHaveBeenCalled();
  });
});

describe("/api/skill-gap — authenticated contract", () => {
  const auth = { Authorization: "Bearer faketoken" };

  it("returns the ROI shape for an authenticated GET (knownSkills default to watchlist)", async () => {
    const res = await request(app).get("/api/skill-gap").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty("recommendations");
    expect(res.body).toHaveProperty("asOf");
    expect(res.body).toHaveProperty("basedOn");
    expect(res.body).toHaveProperty("insufficientData");
    // watchlist was read to build knownSkills.
    expect(watchlistLean).toHaveBeenCalled();
    expect(computeSkillGapRoi).toHaveBeenCalledWith(
      expect.objectContaining({ knownSkills: ["node.js"] }),
    );
  });

  it("accepts an explicit knownSkills array on POST", async () => {
    const res = await request(app)
      .post("/api/skill-gap")
      .set(auth)
      .send({ knownSkills: ["react", "node.js"], limit: 5 });
    expect(res.status).toBe(200);
    expect(computeSkillGapRoi).toHaveBeenCalledWith(
      expect.objectContaining({ knownSkills: ["react", "node.js"], limit: 5 }),
    );
    // watchlist NOT read when the body supplies knownSkills.
    expect(watchlistLean).not.toHaveBeenCalled();
  });

  it("400s when POST knownSkills is not an array (structurally invalid)", async () => {
    const res = await request(app)
      .post("/api/skill-gap")
      .set(auth)
      .send({ knownSkills: "react" });
    expect(res.status).toBe(400);
    expect(computeSkillGapRoi).not.toHaveBeenCalled();
  });

  it("400s on an unknown role", async () => {
    const res = await request(app).get("/api/skill-gap?role=wizard").set(auth);
    expect(res.status).toBe(400);
    expect(computeSkillGapRoi).not.toHaveBeenCalled();
  });
});
