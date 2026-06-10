import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { ingestAdzuna } from "./ingest/adzuna.js";
import { ingestJSearch } from "./ingest/jsearch.js";
import cron from "node-cron";
import { getTrendingSkills, getAllSkills } from "./aggregations/trendingSkills.js";
import { getSkillGap } from "./aggregations/skillGap.js";
import { getTopCompanies } from "./aggregations/topCompanies.js";
import { getSalaryInsights } from "./aggregations/salaryInsights.js";
import { makeDedupeKey } from "./lib/dedupe.js";
import watchlistRouter from "./routes/watchlist.js";
import skillDetailRouter from "./routes/skillDetail.js";
import Job from "./models/Job.js";
import Watchlist from "./models/Watchlist.js";
import { requireAuth } from "@clerk/express";

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

// ── JSearch ingest (protected) ──────────────────────────────────────────────
// Same X-Ingest-Secret guard as /api/ingest/adzuna. POST so it can't be
// accidentally triggered by a browser navigation or uptime-monitor GET.
app.post("/api/ingest/jsearch", async (req, res) => {
  if (!INGEST_SECRET || req.headers["x-ingest-secret"] !== INGEST_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const country = req.query.country || "in";
    const pages = Math.min(Math.max(Number.parseInt(req.query.pages, 10) || 1, 1), 3);
    const datePosted = req.query.date_posted || "month";
    const result = await ingestJSearch({ country, pages, datePosted });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("JSearch ingest error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Backfill dedupeKey (admin) ─────────────────────────────────────────────
// Stamps dedupeKey onto every existing Job doc that is missing it.
// Safe to call multiple times (idempotent: bulkWrite with upsert:false).
// Protected by the same X-Ingest-Secret header as the ingest endpoints.
app.post("/api/admin/backfill-dedupe", async (req, res) => {
  if (!INGEST_SECRET || req.headers["x-ingest-secret"] !== INGEST_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    // Stream all jobs, compute key, build bulk ops.
    const cursor = Job.find({}).select("companyName title location").lean().cursor();
    const ops = [];
    for await (const job of cursor) {
      const key = makeDedupeKey(job.companyName || "", job.title || "", job.location || "");
      ops.push({
        updateOne: {
          filter: { _id: job._id },
          update: { $set: { dedupeKey: key } },
        },
      });
    }
    let updated = 0;
    if (ops.length > 0) {
      const result = await Job.bulkWrite(ops, { ordered: false });
      updated = result.modifiedCount || 0;
    }
    res.json({ ok: true, processed: ops.length, updated });
  } catch (err) {
    console.error("Backfill-dedupe error:", err);
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

// ── All skills (for client-side search/filter) ─────────────────────────────
// Returns the full ranked skill list in one response. All searching/filtering
// is done client-side on this payload; this endpoint is fetched once on load.
app.get("/api/skills/all", readLimiter, async (req, res) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const skills = await getAllSkills({ months });
    res.json({ ok: true, skills });
  } catch (err) {
    console.error("All skills error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cache pre-warm ───────────────────────────────────────────────────────
// Lightweight unauthenticated endpoint that pre-warms all time-window caches
// used by the UI (3M / 6M / 12M). Idempotent: a cache hit is a sub-ms no-op.
// Intended for uptime-monitor pings on Render's free tier to prevent cold
// starts from hitting users, and for any keep-alive cron outside the app.
app.get("/api/warm", readLimiter, async (req, res) => {
  // The three windows the Demand-page segmented control exposes.
  const UI_WINDOWS = [3, 6, 12];
  // limit:25 matches the exact params the frontend sends for trending.
  try {
    await Promise.all([
      ...UI_WINDOWS.flatMap((months) => [
        getTrendingSkills({ months, limit: 25 }),
        getAllSkills({ months }),
      ]),
      // Companies default window only (the page has its own role/skill filters
      // that the user drives, so we just warm the unfiltered baseline).
      getTopCompanies({ months: 12 }),
    ]);
    res.json({ ok: true, warmed: ["trending", "allSkills", "companies"], windows: UI_WINDOWS });
  } catch (err) {
    // Non-fatal: respond 200 so uptime monitors don't alert on a warm failure.
    console.warn("Warm error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── Skill detail ───────────────────────────────────────────────────────
app.use("/api/skill", readLimiter, skillDetailRouter);

// ── Top companies (Who's Hiring) ───────────────────────────────────────
// Public, read-only. Optional ?role=, ?skill=, ?months= filters.
app.get("/api/companies", readLimiter, async (req, res) => {
  try {
    const role = req.query.role || undefined;
    const skill = req.query.skill || undefined;
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const companies = await getTopCompanies({ role, skill, months, limit });
    res.json({ ok: true, companies });
  } catch (err) {
    console.error("Companies error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Salary Insights ───────────────────────────────────────────────
// Public, read-only. Descriptive stats derived ONLY from disclosed salaries.
// Optional ?skill= ?role= ?months= (clamped 1-24, default 12).
// NOT added to /api/warm — query space is too large to pre-warm meaningfully.
app.get("/api/salary", readLimiter, async (req, res) => {
  try {
    const skill = req.query.skill || undefined;
    const role = req.query.role || undefined;
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const data = await getSalaryInsights({ skill, role, months });
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("Salary insights error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Watchlist (auth-gated) ─────────────────────────────────────────────────
app.use("/api/watchlist", watchlistLimiter, watchlistRouter);

// ── Skill-Gap Advisor (auth-gated) ─────────────────────────────────────────
// Returns skills that co-occur most often with the user's watchlist but that
// they don't already track. Auth-gated: userId comes from the Clerk JWT only.
app.get("/api/skill-gap", readLimiter, requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);

    const items = await Watchlist.find({ userId }).lean();
    const watchedSkills = items.map((i) => i.skill);

    if (watchedSkills.length === 0) {
      return res.json({ ok: true, empty: true, gaps: [] });
    }

    const gaps = await getSkillGap(watchedSkills, { limit, months });
    res.json({ ok: true, empty: false, gaps });
  } catch (err) {
    console.error("Skill-gap error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DB connect + cron + listen ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Mongo connected");
    // Keep data fresh automatically: re-ingest every 8 hours.
    // 7 roles × 3 pages = 21 req/run · 3 runs/day = 63/day · ~1890/month
    // — safely under Adzuna limits (25/min, 250/day, 2 500/month).
    cron.schedule("0 */8 * * *", async () => {
      try {
        const r = await ingestAdzuna({ country: "in", pages: 3 });
        console.log("🔄 Auto-ingest:", r);
      } catch (e) {
        console.error("Auto-ingest failed:", e.message);
      }
    });
    // JSearch daily top-up: runs once a day at 05:00 server time.
    // Separate schedule so JSearch failures can never interfere with Adzuna.
    // ingestJSearch() is a no-op when JSEARCH_API_KEY is unset.
    cron.schedule("0 5 * * *", async () => {
      try {
        const r = await ingestJSearch({ country: "in", pages: 1 });
        console.log("🔄 JSearch auto-ingest:", r);
      } catch (e) {
        console.error("JSearch auto-ingest failed:", e.message);
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
