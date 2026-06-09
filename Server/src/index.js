import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { ingestAdzuna } from "./ingest/adzuna.js";
import cron from "node-cron";
import { getTrendingSkills } from "./aggregations/trendingSkills.js";
import watchlistRouter from "./routes/watchlist.js";
import skillDetailRouter from "./routes/skillDetail.js";
import Job from "./models/Job.js";

// ── Startup validation ─────────────────────────────────────────────────────
const IS_PROD = process.env.NODE_ENV === "production";

// MONGODB_URI is required in every environment — the server has no purpose
// without a database.
if (!process.env.MONGODB_URI) {
  console.error("❌ Missing required environment variable: MONGODB_URI");
  process.exit(1);
}

// These vars are only hard-required in production. In development they emit
// a warning so you can boot with a partial .env (e.g. to test DB queries
// without real Adzuna or Clerk credentials set up yet).
const PROD_ONLY_VARS = ["ADZUNA_APP_ID", "ADZUNA_APP_KEY", "CLERK_SECRET_KEY"];
for (const v of PROD_ONLY_VARS) {
  if (!process.env[v]) {
    if (IS_PROD) {
      console.error(`❌ Missing required environment variable: ${v}`);
      process.exit(1);
    } else {
      console.warn(`⚠️  ${v} is not set — some features will not work`);
    }
  }
}

const INGEST_SECRET = process.env.INGEST_SECRET;
if (!INGEST_SECRET) {
  if (IS_PROD) {
    // Fail-closed: refuse to start without the secret in production so the
    // ingest endpoint can never be publicly triggered and burn Adzuna quota.
    console.error("❌ INGEST_SECRET must be set in production");
    process.exit(1);
  } else {
    // The route guard returns 401 when INGEST_SECRET is unset, so the
    // endpoint is locked — not merely unprotected. The message says so.
    console.warn(
      "⚠️  INGEST_SECRET is not set — /api/ingest/adzuna is DISABLED until it is configured",
    );
  }
}

const app = express();
// Trust Render's proxy in production so express-rate-limit sees the real
// client IP via X-Forwarded-For. Disabled in development to avoid trusting
// spoofed X-Forwarded-For headers from a local network.
app.set("trust proxy", IS_PROD ? 1 : false);
app.use(helmet());

// ── CORS ───────────────────────────────────────────────────────────────────
// Only allow our own frontend (prod) + any localhost port (dev).
const allowedOrigins = [process.env.CLIENT_ORIGIN].filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // No origin = server-to-server / curl / health checks → allow.
      if (
        !origin ||
        /^http:\/\/localhost:\d+$/.test(origin) ||
        allowedOrigins.includes(origin)
      ) {
        return cb(null, true);
      }
      return cb(new Error(`Blocked by CORS: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json());

// ── Clerk middleware ───────────────────────────────────────────────────────
// Makes req.auth available on every request so routes can call requireAuth().
app.use(clerkMiddleware());

// ── Rate limiting ──────────────────────────────────────────────────────────
// Prevents hammering public read endpoints or the watchlist.
const readLimiter = rateLimit({
  windowMs: 60_000, // 1 minute window
  max: 60, // 60 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests — please slow down." },
});

const watchlistLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests — please slow down." },
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Ingest (protected) ─────────────────────────────────────────────────────
// Calling this endpoint costs real Adzuna API quota. We protect it with a
// shared secret passed in the X-Ingest-Secret header.
// The in-process cron (below) calls ingestAdzuna() directly, so it is
// never blocked by this check.
app.get("/api/ingest/adzuna", async (req, res) => {
  // Fail-closed: reject if the secret is unset OR the header doesn't match.
  // This ensures the route never falls through to run ingestion without a key.
  if (!INGEST_SECRET || req.headers["x-ingest-secret"] !== INGEST_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const what = req.query.what || undefined;
    const country = req.query.country || "in";
    // parseInt with radix avoids octal/float surprises; lower-bound 1 so
    // NaN || 2 still works; upper-bound 5 caps quota usage per manual trigger.
    const pages = Math.min(
      Math.max(Number.parseInt(req.query.pages, 10) || 2, 1),
      5,
    );
    const result = await ingestAdzuna({ what, country, pages });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Ingestion error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Trending skills ────────────────────────────────────────────────────────
app.get("/api/skills/trending", readLimiter, async (req, res) => {
  try {
    const { role } = req.query;
    // Clamp months to [1, 24] and limit to [1, 100] to prevent expensive queries
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const result = await getTrendingSkills({ role, months, limit });
    // Most recently touched job = how fresh the dataset is.
    const newest = await Job.findOne()
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean();
    res.json({ ok: true, ...result, lastUpdated: newest?.updatedAt || null });
  } catch (err) {
    console.error("Trending error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Skill detail ───────────────────────────────────────────────────────────
app.use("/api/skill", readLimiter, skillDetailRouter);

// ── Watchlist (auth-gated) ─────────────────────────────────────────────────
app.use("/api/watchlist", watchlistLimiter, watchlistRouter);

// ── DB connect + cron + listen ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Mongo connected");
    // Keep data fresh automatically: re-ingest every 6 hours.
    cron.schedule("0 */6 * * *", async () => {
      try {
        const r = await ingestAdzuna({ country: "in", pages: 2 });
        console.log("🔄 Auto-ingest:", r);
      } catch (e) {
        console.error("Auto-ingest failed:", e.message);
      }
    });
    app.listen(PORT, () => {
      console.log(`✅ API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Mongo connection failed:", err.message);
    process.exit(1);
  });
