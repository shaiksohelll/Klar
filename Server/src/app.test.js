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
