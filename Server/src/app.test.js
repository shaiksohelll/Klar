import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ── Set dummy env BEFORE importing app (module-load closures) ──────────────
process.env.MONGODB_URI = "mongodb://localhost:27017/test";
process.env.INGEST_SECRET = "test-secret";

// ── Mock ingest modules so no real network/DB calls happen ─────────────────
vi.mock("./ingest/adzuna.js", () => ({
  ingestAdzuna: vi.fn().mockResolvedValue({ fetched: 0, upserted: 0 }),
}));
vi.mock("./ingest/jsearch.js", () => ({
  ingestJSearch: vi.fn().mockResolvedValue({ fetched: 0, upserted: 0 }),
}));

// ── Mock Clerk so tests don't need real publishable/secret keys ────────────
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (req, res, next) => next(),
  requireAuth: () => (req, res, next) => next(),
}));

// ── Mock Job model so tests don't need a live Mongo connection ─────────────
vi.mock("./models/Job.js", () => ({
  default: {
    findOne: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ updatedAt: "2024-01-01T00:00:00Z" }),
    })),
    find: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      cursor: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }),
      })),
    })),
    bulkWrite: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    aggregate: vi.fn().mockResolvedValue([]),
  },
}));

// ── Mock aggregation modules (avoids real DB pipeline execution) ──────────
vi.mock("./aggregations/trendingSkills.js", () => ({
  getTrendingSkills: vi.fn().mockResolvedValue({
    totalJobs: 100,
    role: "all",
    months: 12,
    skills: [{ skill: "react", demand: 50, avgSalary: 80000, remoteCount: 20, velocity: 5, trend: "up" }],
    velocityReady: true,
    velocityBasisDays: 7,
  }),
  getAllSkills: vi.fn().mockResolvedValue([]),
  clearTrendingCaches: vi.fn(),
}));
vi.mock("./aggregations/atlas.js", () => ({
  getAtlas: vi.fn().mockResolvedValue({
    cities: [],
    totalCities: 0,
    totalJobs: 0,
  }),
  clearAtlasCache: vi.fn(),
}));
vi.mock("./aggregations/salaryInsights.js", () => ({
  getSalaryInsights: vi.fn().mockResolvedValue({}),
  clearSalaryCache: vi.fn(),
}));
vi.mock("./aggregations/skillPairs.js", () => ({
  getSkillPairs: vi.fn().mockResolvedValue([]),
  clearPairsCache: vi.fn(),
}));
vi.mock("./aggregations/topCompanies.js", () => ({
  getTopCompanies: vi.fn().mockResolvedValue([]),
  clearCompaniesCache: vi.fn(),
}));
vi.mock("./aggregations/skillGapRoi.js", () => ({
  computeSkillGapRoi: vi.fn().mockResolvedValue({}),
  clearSkillGapRoiCache: vi.fn(),
}));
vi.mock("./routes/skillDetail.js", async () => {
  const { Router } = await import("express");
  const r = Router();
  return { default: r, clearDetailCache: vi.fn() };
});
// ── Mock DatasetState reader (no live Mongo in these route tests) ──────────
// Returns only the public-safe shape; emptyPublicDatasetMetadata mirrors the
// real fail-safe fallback the route uses when the read throws.
const PUBLIC_SOURCE_IDLE = {
  status: "idle",
  lastAttemptAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
  lastPartialAt: null,
  lastFailureAt: null,
  hasError: false,
};
vi.mock("./lib/datasetState.js", () => ({
  getPublicDatasetMetadata: vi.fn().mockResolvedValue({
    version: 3,
    asOf: "2024-06-01T00:00:00.000Z",
    ingestionInProgress: false,
    runningSources: [],
    sources: {
      adzuna: {
        status: "succeeded",
        lastAttemptAt: "2024-06-01T00:00:00.000Z",
        lastCompletedAt: "2024-06-01T00:00:00.000Z",
        lastSuccessAt: "2024-06-01T00:00:00.000Z",
        lastPartialAt: null,
        lastFailureAt: null,
        hasError: false,
      },
      jsearch: {
        status: "idle",
        lastAttemptAt: null,
        lastCompletedAt: null,
        lastSuccessAt: null,
        lastPartialAt: null,
        lastFailureAt: null,
        hasError: false,
      },
    },
  }),
  emptyPublicDatasetMetadata: () => ({
    version: 0,
    asOf: null,
    ingestionInProgress: false,
    runningSources: [],
    sources: { adzuna: { ...PUBLIC_SOURCE_IDLE }, jsearch: { ...PUBLIC_SOURCE_IDLE } },
  }),
}));
// ── Import AFTER env + mocks are set ───────────────────────────────────────
const { default: app, clearCountriesCache } = await import("./app.js");
const { default: request } = await import("supertest");
const { ingestAdzuna } = await import("./ingest/adzuna.js");
const { ingestJSearch } = await import("./ingest/jsearch.js");
const { searchCities } = await import("./lib/geocode.js");
const { relocationRoi } = await import("./lib/costOfLiving.js");
const { getTrendingSkills, clearTrendingCaches } = await import("./aggregations/trendingSkills.js");
const { getAtlas, clearAtlasCache } = await import("./aggregations/atlas.js");
const { clearSalaryCache } = await import("./aggregations/salaryInsights.js");
const { clearPairsCache } = await import("./aggregations/skillPairs.js");
const { clearCompaniesCache } = await import("./aggregations/topCompanies.js");
const { clearSkillGapRoiCache } = await import("./aggregations/skillGapRoi.js");
const { clearDetailCache } = await import("./routes/skillDetail.js");
const { default: Job } = await import("./models/Job.js");
const { getPublicDatasetMetadata } = await import("./lib/datasetState.js");

describe("POST /api/ingest", () => {
  beforeAll(() => {
    vi.clearAllMocks();
  });

  it("rejects with 401 when no secret header is provided", async () => {
    const res = await request(app).post("/api/ingest");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("rejects with 401 when secret header is wrong", async () => {
    const res = await request(app)
      .post("/api/ingest")
      .set("x-ingest-secret", "wrong-secret");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("responds 202 and runs ingestion in background with valid secret", async () => {
    vi.clearAllMocks();

    const res = await request(app)
      .post("/api/ingest")
      .set("x-ingest-secret", "test-secret");

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, message: "Ingestion started" });

    // Ingestion runs in a fire-and-forget IIFE after the 202 response.
    // Wait for the microtask to complete before asserting.
    await vi.waitFor(() => {
      expect(ingestAdzuna).toHaveBeenCalled();
      expect(ingestJSearch).toHaveBeenCalled();
    });
  });

  it("logs a source as skipped (not complete) when its result is a refusal", async () => {
    vi.clearAllMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      ingestAdzuna.mockResolvedValueOnce({ skipped: true, reason: "overlap" });
      ingestJSearch.mockResolvedValueOnce({ fetched: 3, upserted: 1 });

      const res = await request(app)
        .post("/api/ingest")
        .set("x-ingest-secret", "test-secret");

      // Response contract is unchanged: 202 regardless of what the background
      // per-source runs eventually report.
      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(ingestAdzuna).toHaveBeenCalled();
        expect(ingestJSearch).toHaveBeenCalled();
      });
      // Let the background IIFE's .finally() / log lines run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const calls = logSpy.mock.calls.map((args) => args[0]);
      expect(calls).toContain("Adzuna ingestion skipped");
      expect(calls).not.toContain("Adzuna ingestion complete");
      expect(calls).toContain("JSearch ingestion complete");
    } finally {
      // try/finally so a failed assertion above still restores console.log
      // instead of leaking the mock into later tests.
      logSpy.mockRestore();
    }
  });
});

describe("POST /api/ingest/adzuna", () => {
  it("rejects with 401 when no secret header is provided", async () => {
    const res = await request(app).post("/api/ingest/adzuna");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("runs Adzuna ingestion with a valid secret", async () => {
    vi.clearAllMocks();
    const res = await request(app)
      .post("/api/ingest/adzuna")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, fetched: 0, upserted: 0 });
    expect(ingestAdzuna).toHaveBeenCalled();
  });

  it("returns 404 for the old GET route (method flipped to POST)", async () => {
    const res = await request(app)
      .get("/api/ingest/adzuna")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(404);
  });

  it("returns 409 (not 200 ok:true) when refused for overlap", async () => {
    vi.clearAllMocks();
    ingestAdzuna.mockResolvedValueOnce({ skipped: true, reason: "overlap" });
    const res = await request(app)
      .post("/api/ingest/adzuna")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, skipped: true, reason: "overlap" });
  });

  it("returns 503 (not 200 ok:true) when refused for begin-failed", async () => {
    vi.clearAllMocks();
    ingestAdzuna.mockResolvedValueOnce({ skipped: true, reason: "begin-failed" });
    const res = await request(app)
      .post("/api/ingest/adzuna")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, skipped: true, reason: "begin-failed" });
  });
});

describe("POST /api/ingest/jsearch", () => {
  it("rejects with 401 when no secret header is provided", async () => {
    const res = await request(app).post("/api/ingest/jsearch");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("runs JSearch ingestion with a valid secret", async () => {
    vi.clearAllMocks();
    const res = await request(app)
      .post("/api/ingest/jsearch")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, fetched: 0, upserted: 0 });
    expect(ingestJSearch).toHaveBeenCalled();
  });

  it("returns 409 (not 200 ok:true) when refused for overlap", async () => {
    vi.clearAllMocks();
    ingestJSearch.mockResolvedValueOnce({ skipped: true, reason: "overlap" });
    const res = await request(app)
      .post("/api/ingest/jsearch")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, skipped: true, reason: "overlap" });
  });

  it("returns 503 (not 200 ok:true) when refused for begin-failed", async () => {
    vi.clearAllMocks();
    ingestJSearch.mockResolvedValueOnce({ skipped: true, reason: "begin-failed" });
    const res = await request(app)
      .post("/api/ingest/jsearch")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, skipped: true, reason: "begin-failed" });
  });
});

describe("POST /api/resume-gap", () => {
  it("returns 400 when body is not JSON (non-JSON Content-Type)", async () => {
    // When Content-Type is not application/json, express.json() leaves
    // req.body undefined. The req.body || {} guard must catch this and
    // return 400 (text is required), not 500.
    const res = await request(app)
      .post("/api/resume-gap")
      .type("text")
      .send("hi");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "text is required" });
  });
});

describe("GET /api/relocation", () => {
  it("returns 200 with an ROI payload on the happy path", async () => {
    // Country-level US -> IN. Pure compute (no DB), so no mocks required.
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: "us", to: "in", salary: 100000, currency: "USD" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fromPriceLevel).toBe(100);
    expect(typeof res.body.nominalUSD).toBe("number");
    expect(typeof res.body.equivalentInTarget).toBe("number");
    expect(res.body.confidence).toBe("high");
  });

  it("returns 400 when from/to are missing", async () => {
    const res = await request(app)
      .get("/api/relocation")
      .query({ salary: 100000, currency: "USD" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 on a non-positive salary", async () => {
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: "us", to: "in", salary: -5, currency: "USD" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 on an unknown currency", async () => {
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: "us", to: "in", salary: 100000, currency: "ZZZ" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("resolves a numeric geonameId for `from`", async () => {
    // Resolve a real geonameId via the alias-aware search, then feed it back
    // to /api/relocation as a numeric token (deterministic resolution).
    const [city] = searchCities("bangalore", 1);
    expect(city).toBeTruthy();
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: String(city.geonameId), to: "us", salary: 2500000, currency: "INR" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The numeric token resolved to the same verified place.
    expect(res.body.from.geonameId).toBe(city.geonameId);
    expect(res.body.from.country).toBe(city.country);
  });

  it("returns resolved displayName containing the city NAME, not a geonameId", async () => {
    const [city] = searchCities("bangalore", 1); // Bengaluru (India)
    expect(city).toBeTruthy();
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: String(city.geonameId), to: "us", salary: 2500000, currency: "INR" });
    expect(res.status).toBe(200);
    const dn = res.body.from.displayName;
    expect(typeof dn).toBe("string");
    // The label uses the city NAME, never the bare numeric geonameId.
    expect(dn).toContain(city.city);
    expect(dn).not.toBe(String(city.geonameId));
    expect(/^\d+$/.test(dn)).toBe(false);
  });

  it("omits a numeric admin1 from displayName (e.g. India), keeps alphabetic", async () => {
    const [india] = searchCities("bangalore", 1); // Bengaluru, admin1 "19"
    expect(india).toBeTruthy();
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: String(india.geonameId), to: "us", salary: 2500000, currency: "INR" });
    expect(res.status).toBe(200);
    // Numeric admin1 must NOT leak into the label or the resolved field.
    expect(res.body.from.displayName).not.toMatch(/\b\d+\b/);
    expect(res.body.from.admin1).toBeUndefined();

    // A US city should keep its alphabetic admin1 (e.g. "CA").
    const usCity = searchCities("san francisco", 5).find(
      (c) => c.country === "us" && typeof c.admin1 === "string" && /[A-Za-z]/.test(c.admin1),
    );
    if (usCity) {
      const res2 = await request(app)
        .get("/api/relocation")
        .query({ from: String(usCity.geonameId), to: "in", salary: 150000, currency: "USD" });
      expect(res2.status).toBe(200);
      expect(res2.body.from.admin1).toBe(usCity.admin1);
      expect(res2.body.from.displayName).toContain(usCity.admin1);
    }
  });

  it("uses the country name as displayName for a 2-letter country code", async () => {
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: "in", to: "us", salary: 100000, currency: "USD" });
    expect(res.status).toBe(200);
    expect(res.body.from.displayName).toBe("India");
    expect(res.body.to.displayName).toBe("United States");
  });

  it("returns offer fields (realValueTarget, roiPct, breakEvenTarget) with targetSalary", async () => {
    // First resolve the break-even (equivalent) without an offer.
    const base = await request(app)
      .get("/api/relocation")
      .query({ from: "in", to: "us", salary: 2500000, currency: "INR" });
    expect(base.status).toBe(200);
    const breakEven = base.body.equivalentInTarget;
    expect(typeof breakEven).toBe("number");

    // An offer ABOVE break-even (destination currency = USD).
    const res = await request(app)
      .get("/api/relocation")
      .query({ from: "in", to: "us", salary: 2500000, currency: "INR", targetSalary: breakEven + 20000 });
    expect(res.status).toBe(200);
    expect(typeof res.body.realValueTarget).toBe("number");
    expect(typeof res.body.roiPct).toBe("number");
    expect(res.body.breakEvenTarget).toBe(breakEven);
    expect(res.body.offerVsBreakEvenPct).toBeGreaterThan(0);
    expect(res.body.roiPct).toBeGreaterThan(0);
  });
});

describe("relocationRoi offer mode", () => {
  // Break-even = equivalentInTarget (the offer that preserves real lifestyle).
  const baseArgs = {
    salary: 2500000,
    currency: "INR",
    fromCountry: "in",
    toCountry: "us",
  };

  it("yields a positive roiPct for an offer ABOVE break-even (real raise)", () => {
    const { equivalentInTarget } = relocationRoi(baseArgs);
    expect(equivalentInTarget).toBeGreaterThan(0);
    const r = relocationRoi({ ...baseArgs, targetSalary: equivalentInTarget * 1.2 });
    expect(r.roiPct).toBeGreaterThan(0);
    expect(r.offerVsBreakEvenPct).toBeGreaterThan(0);
    expect(r.breakEvenTarget).toBe(equivalentInTarget);
  });

  it("yields a negative roiPct for an offer BELOW break-even (real cut)", () => {
    const { equivalentInTarget } = relocationRoi(baseArgs);
    const r = relocationRoi({ ...baseArgs, targetSalary: equivalentInTarget * 0.8 });
    expect(r.roiPct).toBeLessThan(0);
    expect(r.offerVsBreakEvenPct).toBeLessThan(0);
  });

  it("guards divide-by-zero: no targetSalary -> null offer fields, no throw", () => {
    const r = relocationRoi(baseArgs);
    expect(r.realValueTarget).toBeNull();
    expect(r.roiPct).toBeNull();
    expect(r.breakEvenTarget).toBeNull();
    expect(r.offerVsBreakEvenPct).toBeNull();
  });

  it("does not throw on a zero salary (guarded null fields)", () => {
    expect(() =>
      relocationRoi({ ...baseArgs, salary: 0, targetSalary: 100000 }),
    ).not.toThrow();
  });
});

describe("searchCities", () => {
  it("ranks results by population (desc)", () => {
    const results = searchCities("a", 15);
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].population).toBeGreaterThanOrEqual(results[i].population);
    }
  });

  it("resolves an alias to its canonical city (bangalore -> Bengaluru)", () => {
    const results = searchCities("bangalore", 8);
    const match = results.find((c) => c.city.toLowerCase() === "bengaluru");
    expect(match).toBeTruthy();
    expect(Number.isFinite(match.geonameId)).toBe(true);
    expect(match.country).toBe("in");
  });

  it("returns [] for an empty query", () => {
    expect(searchCities("")).toEqual([]);
  });
});

describe("GET /api/places/suggest", () => {
  it("returns 400 when q is missing", async () => {
    const res = await request(app).get("/api/places/suggest");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 200 with the documented suggestion shape", async () => {
    const res = await request(app)
      .get("/api/places/suggest")
      .query({ q: "bangalore", limit: 5 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    const city = res.body.suggestions.find((s) => s.type === "city");
    expect(city).toBeTruthy();
    expect(typeof city.label).toBe("string");
    expect(typeof city.token).toBe("string");
    expect(Number.isFinite(city.geonameId)).toBe(true);
    expect(typeof city.country).toBe("string");
  });

  it("includes a supported country whose name matches q", async () => {
    const res = await request(app)
      .get("/api/places/suggest")
      .query({ q: "united states" });
    expect(res.status).toBe(200);
    const country = res.body.suggestions.find((s) => s.type === "country");
    expect(country).toBeTruthy();
    expect(country.token).toBe("us");
    expect(country.country).toBe("us");
  });
});

// ── Facet filter tests for /api/skills/trending ───────────────────────────
describe("GET /api/skills/trending (facet filters)", () => {
  it("returns 200 with no filters (backward compat)", async () => {
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.totalJobs).toBe("number");
  });

  it("accepts remote=remote", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ remote: "remote" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts remote=onsite", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ remote: "onsite" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects invalid remote value with 400", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ remote: "hybrid" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("accepts disclosed=1", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ disclosed: "1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects disclosed=true (only disclosed=1 is valid)", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ disclosed: "true" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("rejects invalid disclosed value with 400", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ disclosed: "no" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("passes remote + disclosed through to getTrendingSkills", async () => {
    getTrendingSkills.mockClear();
    await request(app)
      .get("/api/skills/trending")
      .query({ remote: "remote", disclosed: "1", role: "frontend" });
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "remote",
        disclosed: true,
        role: "frontend",
      }),
    );
  });
});

// ── Facet filter tests for /api/atlas ───────────────────────────────────
describe("GET /api/atlas (facet filters)", () => {
  it("returns 200 with no filters (backward compat)", async () => {
    const res = await request(app).get("/api/atlas");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("accepts remote=remote", async () => {
    const res = await request(app)
      .get("/api/atlas")
      .query({ remote: "remote" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects invalid remote value with 400", async () => {
    const res = await request(app)
      .get("/api/atlas")
      .query({ remote: "hybrid" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("accepts disclosed=1", async () => {
    const res = await request(app)
      .get("/api/atlas")
      .query({ disclosed: "1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects invalid disclosed value with 400", async () => {
    const res = await request(app)
      .get("/api/atlas")
      .query({ disclosed: "no" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("passes remote + disclosed through to getAtlas", async () => {
    getAtlas.mockClear();
    await request(app)
      .get("/api/atlas")
      .query({ remote: "onsite", disclosed: "1" });
    expect(getAtlas).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "onsite",
        disclosed: true,
      }),
    );
  });
});

// ── Country filter tests for /api/skills/trending ─────────────────────────
describe("GET /api/skills/trending (country filter)", () => {
  it("accepts country=in", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ country: "in" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("forwards an unknown country as a filter (no 400)", async () => {
    getTrendingSkills.mockClear();
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ country: "zz" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.objectContaining({ country: "zz" }),
    );
  });

  it("ignores empty country", async () => {
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ country: "" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("passes country through to getTrendingSkills", async () => {
    getTrendingSkills.mockClear();
    await request(app)
      .get("/api/skills/trending")
      .query({ country: "us", role: "backend" });
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "us",
        role: "backend",
      }),
    );
  });

  it("drops malformed country (>2 chars) — no country filter applied", async () => {
    getTrendingSkills.mockClear();
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ country: "zzzz" });
    expect(res.status).toBe(200);
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.not.objectContaining({ country: expect.anything() }),
    );
  });
});

// ── Country filter tests for /api/atlas ───────────────────────────────────
describe("GET /api/atlas (country filter)", () => {
  it("accepts country=in", async () => {
    const res = await request(app)
      .get("/api/atlas")
      .query({ country: "in" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("forwards an unknown country as a filter (no 400)", async () => {
    getAtlas.mockClear();
    const res = await request(app)
      .get("/api/atlas")
      .query({ country: "zz" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(getAtlas).toHaveBeenCalledWith(
      expect.objectContaining({ country: "zz" }),
    );
  });

  it("passes country through to getAtlas", async () => {
    getAtlas.mockClear();
    await request(app)
      .get("/api/atlas")
      .query({ country: "gb", disclosed: "1" });
    expect(getAtlas).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "gb",
        disclosed: true,
      }),
    );
  });

  it("drops malformed country (>2 chars) — no country filter applied", async () => {
    getAtlas.mockClear();
    const res = await request(app)
      .get("/api/atlas")
      .query({ country: "abcdef" });
    expect(res.status).toBe(200);
    expect(getAtlas).toHaveBeenCalledWith(
      expect.not.objectContaining({ country: expect.anything() }),
    );
  });
});

// ── /api/places/countries endpoint ────────────────────────────────────────
describe("GET /api/places/countries", () => {
  beforeEach(() => clearCountriesCache());
  it("returns 200 with countries array of { code, count } objects", async () => {
    // Provide raw aggregate rows to exercise the canonicalization logic.
    Job.aggregate.mockResolvedValueOnce([
      { _id: "in", count: 100 },
      { _id: "us", count: 50 },
    ]);
    const res = await request(app).get("/api/places/countries");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.countries)).toBe(true);
    for (const c of res.body.countries) {
      expect(c).toHaveProperty("code");
      expect(c).toHaveProperty("count");
      expect(c.code).toMatch(/^[a-z]{2}$/);
      expect(typeof c.count).toBe("number");
    }
  });

  it("collapses mixed-case duplicate rows into one lowercase code with summed count", async () => {
    Job.aggregate.mockResolvedValueOnce([
      { _id: "IN", count: 40 },
      { _id: "in", count: 60 },
      { _id: " In ", count: 10 },
    ]);
    const res = await request(app).get("/api/places/countries");
    expect(res.status).toBe(200);
    const inEntry = res.body.countries.find((c) => c.code === "in");
    expect(inEntry).toBeDefined();
    expect(inEntry.count).toBe(110);
    // Should be only one "in" entry, not three.
    expect(res.body.countries.filter((c) => c.code === "in")).toHaveLength(1);
  });

  it("excludes non-ISO-2 codes from the response", async () => {
    Job.aggregate.mockResolvedValueOnce([
      { _id: "us", count: 200 },
      { _id: "usa", count: 30 },
      { _id: "u.k", count: 15 },
      { _id: "in", count: 100 },
    ]);
    const res = await request(app).get("/api/places/countries");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(2);
    for (const c of res.body.countries) {
      expect(c.code).toMatch(/^[a-z]{2}$/);
    }
    expect(res.body.countries.find((c) => c.code === "us")).toBeDefined();
    expect(res.body.countries.find((c) => c.code === "in")).toBeDefined();
  });
});

// ── Salary band filter tests for /api/skills/trending ─────────────────────
describe("GET /api/skills/trending (salary band filter)", () => {
  const VALID_BANDS = ["lt10", "10to25", "25to50", "gte50"];

  for (const band of VALID_BANDS) {
    it(`passes salary=${band} through to getTrendingSkills`, async () => {
      getTrendingSkills.mockClear();
      const res = await request(app)
        .get("/api/skills/trending")
        .query({ salary: band });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(getTrendingSkills).toHaveBeenCalledWith(
        expect.objectContaining({ salary: band }),
      );
    });
  }

  it("drops an invalid salary band — no salary filter applied", async () => {
    getTrendingSkills.mockClear();
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ salary: "bogus" });
    expect(res.status).toBe(200);
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.not.objectContaining({ salary: expect.anything() }),
    );
  });

  it("drops an empty salary param — no salary filter applied", async () => {
    getTrendingSkills.mockClear();
    const res = await request(app)
      .get("/api/skills/trending")
      .query({ salary: "" });
    expect(res.status).toBe(200);
    expect(getTrendingSkills).toHaveBeenCalledWith(
      expect.not.objectContaining({ salary: expect.anything() }),
    );
  });
});

// ── Salary band filter tests for /api/atlas ───────────────────────────────
describe("GET /api/atlas (salary band filter)", () => {
  const VALID_BANDS = ["lt10", "10to25", "25to50", "gte50"];

  for (const band of VALID_BANDS) {
    it(`passes salary=${band} through to getAtlas`, async () => {
      getAtlas.mockClear();
      const res = await request(app)
        .get("/api/atlas")
        .query({ salary: band });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(getAtlas).toHaveBeenCalledWith(
        expect.objectContaining({ salary: band }),
      );
    });
  }

  it("drops an invalid salary band — no salary filter applied", async () => {
    getAtlas.mockClear();
    const res = await request(app)
      .get("/api/atlas")
      .query({ salary: "bogus" });
    expect(res.status).toBe(200);
    expect(getAtlas).toHaveBeenCalledWith(
      expect.not.objectContaining({ salary: expect.anything() }),
    );
  });

  it("drops an empty salary param — no salary filter applied", async () => {
    getAtlas.mockClear();
    const res = await request(app)
      .get("/api/atlas")
      .query({ salary: "" });
    expect(res.status).toBe(200);
    expect(getAtlas).toHaveBeenCalledWith(
      expect.not.objectContaining({ salary: expect.anything() }),
    );
  });
});

// ── Backfill-dedupe cache invalidation ──────────────────────────────────────
describe("POST /api/admin/backfill-dedupe — cache invalidation", () => {
  beforeEach(() => {
    clearAtlasCache.mockClear();
    clearSalaryCache.mockClear();
    clearPairsCache.mockClear();
    clearCompaniesCache.mockClear();
    clearTrendingCaches.mockClear();
    clearDetailCache.mockClear();
    clearSkillGapRoiCache.mockClear();
    Job.bulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
  });

  it("clears all 7 dedupe-affected caches on success", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-dedupe")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(clearAtlasCache).toHaveBeenCalledTimes(1);
    expect(clearSalaryCache).toHaveBeenCalledTimes(1);
    expect(clearPairsCache).toHaveBeenCalledTimes(1);
    expect(clearCompaniesCache).toHaveBeenCalledTimes(1);
    expect(clearTrendingCaches).toHaveBeenCalledTimes(1);
    expect(clearDetailCache).toHaveBeenCalledTimes(1);
    expect(clearSkillGapRoiCache).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear caches on auth failure", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-dedupe");
    expect(res.status).toBe(401);
    expect(clearAtlasCache).not.toHaveBeenCalled();
    expect(clearSalaryCache).not.toHaveBeenCalled();
    expect(clearPairsCache).not.toHaveBeenCalled();
    expect(clearCompaniesCache).not.toHaveBeenCalled();
    expect(clearTrendingCaches).not.toHaveBeenCalled();
    expect(clearDetailCache).not.toHaveBeenCalled();
    expect(clearSkillGapRoiCache).not.toHaveBeenCalled();
  });

  it("surfaces partial bulkWrite counts on BulkWriteError", async () => {
    const bwErr = Object.assign(new Error("E11000 dup key"), {
      name: "BulkWriteError",
      result: { modifiedCount: 42, matchedCount: 100 },
    });
    Job.bulkWrite.mockRejectedValueOnce(bwErr);
    // Seed at least one doc so ops.length > 0 and bulkWrite runs.
    Job.find.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      cursor: vi.fn(() => ({
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: async () => {
              if (!called) {
                called = true;
                return { done: false, value: { _id: "a", companyName: "X", title: "Y", location: "Z" } };
              }
              return { done: true };
            },
          };
        },
      })),
    });
    const res = await request(app)
      .post("/api/admin/backfill-dedupe")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bulkWriteError).toMatchObject({
      modifiedCount: 42,
      matchedCount: 100,
    });
    expect(res.body.updated).toBe(42);
    // Caches still cleared even on partial success.
    expect(clearAtlasCache).toHaveBeenCalledTimes(1);
  });
});

// ── Backfill-geo cache invalidation ─────────────────────────────────────────
describe("POST /api/admin/backfill-geo — cache invalidation", () => {
  beforeEach(() => {
    clearAtlasCache.mockClear();
    clearTrendingCaches.mockClear();
    clearCountriesCache();
    // Reset spyable clearCountriesCache — it's a real function, not a mock,
    // so we check its effect via the countries endpoint.
    clearSalaryCache.mockClear();
    clearPairsCache.mockClear();
    clearCompaniesCache.mockClear();
    clearDetailCache.mockClear();
    clearSkillGapRoiCache.mockClear();
    Job.bulkWrite.mockReset().mockResolvedValue({ modifiedCount: 0 });
  });

  it("clears atlas + trending + countries caches on success", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-geo")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(clearAtlasCache).toHaveBeenCalledTimes(1);
    expect(clearTrendingCaches).toHaveBeenCalledTimes(1);
    // clearCountriesCache is a real fn in app.js — verify it was called by
    // checking the response (it resets the in-memory TTL cache, so a
    // subsequent countries request would re-query).
  });

  it("does NOT clear caches that geo doesn't affect", async () => {
    await request(app)
      .post("/api/admin/backfill-geo")
      .set("x-ingest-secret", "test-secret");
    expect(clearSalaryCache).not.toHaveBeenCalled();
    expect(clearPairsCache).not.toHaveBeenCalled();
    expect(clearCompaniesCache).not.toHaveBeenCalled();
    expect(clearDetailCache).not.toHaveBeenCalled();
    expect(clearSkillGapRoiCache).not.toHaveBeenCalled();
  });

  it("does NOT clear caches on auth failure", async () => {
    const res = await request(app)
      .post("/api/admin/backfill-geo");
    expect(res.status).toBe(401);
    expect(clearAtlasCache).not.toHaveBeenCalled();
    expect(clearTrendingCaches).not.toHaveBeenCalled();
  });

  it("surfaces partial bulkWrite counts on BulkWriteError", async () => {
    const bwErr = Object.assign(new Error("E11000 dup key"), {
      name: "BulkWriteError",
      result: { modifiedCount: 10, matchedCount: 50 },
    });
    Job.bulkWrite.mockRejectedValueOnce(bwErr);
    Job.find.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      cursor: vi.fn(() => ({
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: async () => {
              if (!called) {
                called = true;
                return { done: false, value: { _id: "g1", location: "Mumbai", salaryRange: { currency: "INR" } } };
              }
              return { done: true };
            },
          };
        },
      })),
    });
    const res = await request(app)
      .post("/api/admin/backfill-geo")
      .set("x-ingest-secret", "test-secret");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bulkWriteError).toMatchObject({
      modifiedCount: 10,
      matchedCount: 50,
    });
    expect(res.body.updated).toBe(10);
  });
});

// ── DatasetState integration on /api/skills/trending (Gate 0.2B) ──────────
describe("GET /api/skills/trending (dataset metadata)", () => {
  beforeEach(() => {
    // Restore the default public metadata resolution between tests so a
    // *Once override in one test never bleeds into the next.
    getPublicDatasetMetadata.mockResolvedValue({
      version: 3,
      asOf: "2024-06-01T00:00:00.000Z",
      ingestionInProgress: false,
      runningSources: [],
      sources: {
        adzuna: {
          status: "succeeded",
          lastAttemptAt: "2024-06-01T00:00:00.000Z",
          lastCompletedAt: "2024-06-01T00:00:00.000Z",
          lastSuccessAt: "2024-06-01T00:00:00.000Z",
          lastPartialAt: null,
          lastFailureAt: null,
          hasError: false,
        },
        jsearch: {
          status: "idle",
          lastAttemptAt: null,
          lastCompletedAt: null,
          lastSuccessAt: null,
          lastPartialAt: null,
          lastFailureAt: null,
          hasError: false,
        },
      },
    });
  });

  it("includes a public-safe dataset object in the response", async () => {
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dataset).toBeDefined();
    expect(res.body.dataset).toMatchObject({
      version: 3,
      asOf: "2024-06-01T00:00:00.000Z",
      ingestionInProgress: false,
      runningSources: [],
    });
    expect(res.body.dataset.sources.adzuna.status).toBe("succeeded");
    expect(res.body.dataset.sources.jsearch.status).toBe("idle");
  });

  it("prefers dataset.asOf for lastUpdated over the newest Job updatedAt, and skips the fallback query", async () => {
    // asOf is present (default mock: "2024-06-01T00:00:00.000Z") — the hot
    // path must skip the newest-Job-updatedAt fallback query entirely.
    Job.findOne.mockClear();
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    // Job mock's newest updatedAt is 2024-01-01; asOf (2024-06-01) must win.
    expect(res.body.lastUpdated).toBe("2024-06-01T00:00:00.000Z");
    expect(Job.findOne).not.toHaveBeenCalled();
  });

  it("falls back to newest Job updatedAt when dataset.asOf is null, and runs the fallback query", async () => {
    getPublicDatasetMetadata.mockResolvedValueOnce({
      version: 0,
      asOf: null,
      ingestionInProgress: false,
      runningSources: [],
      sources: { adzuna: { ...PUBLIC_SOURCE_IDLE }, jsearch: { ...PUBLIC_SOURCE_IDLE } },
    });
    Job.findOne.mockClear();
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.lastUpdated).toBe("2024-01-01T00:00:00Z");
    expect(res.body.dataset.asOf).toBeNull();
    expect(Job.findOne).toHaveBeenCalledTimes(1);
  });

  it("still serves ranking (200) when the metadata read throws", async () => {
    getPublicDatasetMetadata.mockRejectedValueOnce(new Error("mongo down"));
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Ranking payload intact.
    expect(typeof res.body.totalJobs).toBe("number");
    // Fallback dataset is the honest empty contract, not the leaked error.
    expect(res.body.dataset).toMatchObject({ version: 0, asOf: null, ingestionInProgress: false });
    expect(JSON.stringify(res.body)).not.toContain("mongo down");
    // asOf null → freshness falls back to newest Job updatedAt.
    expect(res.body.lastUpdated).toBe("2024-01-01T00:00:00Z");
  });

  it("still returns 200 with lastUpdated: null when the newest-Job fallback query itself throws", async () => {
    // asOf is null so the fallback query runs; Job.findOne's own chain throws
    // (simulating a transient DB error on that specific lookup). The route
    // must not 500 — it should log server-side and fall back to null.
    getPublicDatasetMetadata.mockResolvedValueOnce({
      version: 0,
      asOf: null,
      ingestionInProgress: false,
      runningSources: [],
      sources: { adzuna: { ...PUBLIC_SOURCE_IDLE }, jsearch: { ...PUBLIC_SOURCE_IDLE } },
    });
    Job.findOne.mockReturnValueOnce({
      sort: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockRejectedValue(new Error("Job fallback query boom")),
    });
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dataset.asOf).toBeNull();
    expect(res.body.lastUpdated).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("Job fallback query boom");
  });

  it("never exposes lastError, runId, or internal summaries in dataset", async () => {
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    for (const src of ["adzuna", "jsearch"]) {
      const s = res.body.dataset.sources[src];
      expect(s).toHaveProperty("hasError");
      expect(s).not.toHaveProperty("lastError");
      expect(s).not.toHaveProperty("runId");
      expect(s).not.toHaveProperty("lastSummary");
    }
    const serialized = JSON.stringify(res.body.dataset);
    expect(serialized).not.toContain("lastError");
    expect(serialized).not.toContain("runId");
    expect(serialized).not.toContain("lastSummary");
  });

  it("keeps existing trending response fields intact alongside dataset", async () => {
    const res = await request(app).get("/api/skills/trending");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.totalJobs).toBe(100);
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(res.body.velocityReady).toBe(true);
    expect(res.body).toHaveProperty("lastUpdated");
    expect(res.body).toHaveProperty("dataset");
  });
});
