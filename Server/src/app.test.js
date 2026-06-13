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
