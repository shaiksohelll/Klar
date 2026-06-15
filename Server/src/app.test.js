import { describe, it, expect, vi, beforeAll } from "vitest";

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

// ── Import AFTER env + mocks are set ───────────────────────────────────────
const { default: app } = await import("./app.js");
const { default: request } = await import("supertest");
const { ingestAdzuna } = await import("./ingest/adzuna.js");
const { ingestJSearch } = await import("./ingest/jsearch.js");
const { searchCities } = await import("./lib/geocode.js");

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
