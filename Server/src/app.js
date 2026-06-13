import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import { ingestAdzuna } from "./ingest/adzuna.js";
import { ingestJSearch } from "./ingest/jsearch.js";
import { getTrendingSkills, getAllSkills } from "./aggregations/trendingSkills.js";
import { getSkillGap } from "./aggregations/skillGap.js";
import { getTopCompanies } from "./aggregations/topCompanies.js";
import { getSalaryInsights } from "./aggregations/salaryInsights.js";
import { makeDedupeKey } from "./lib/dedupe.js";
import { computeResumeGap } from "./lib/resumeGap.js";
import watchlistRouter from "./routes/watchlist.js";
import skillDetailRouter from "./routes/skillDetail.js";
import Job from "./models/Job.js";
import Watchlist from "./models/Watchlist.js";

// ── Ingest secret (read at module load) ────────────────────────────────────
const INGEST_SECRET = process.env.INGEST_SECRET;

/**
 * Constant-time ingest-secret check (fail-closed).
 *
 * Returns true only when INGEST_SECRET is configured (non-empty) AND the
 * X-Ingest-Secret header matches. Both sides are hashed with SHA-256 first so
 * crypto.timingSafeEqual always receives equal-length buffers — a plain `!==`
 * string compare short-circuits on the first differing byte and leaks timing
 * information an attacker could use to recover the secret byte by byte.
 */
function isValidIngestSecret(req) {
  if (!INGEST_SECRET) return false; // fail-closed: unset/empty secret → locked
  const provided = req.headers["x-ingest-secret"];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(INGEST_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

const IS_PROD = process.env.NODE_ENV === "production";

const app = express();
// Trust Render's proxy in production so express-rate-limit sees the real
// client IP via X-Forwarded-For. Disabled in development to avoid trusting
// spoofed X-Forwarded-For headers from a local network.
app.set("trust proxy", IS_PROD ? 1 : false);
app.use(helmet());

// ── CORS ───────────────────────────────────────────────────────────────────
// Only allow our own frontend (prod) + any localhost port (dev).
const isDev = process.env.NODE_ENV !== "production";
const allowedOrigins = [process.env.CLIENT_ORIGIN].filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // No origin = server-to-server / curl / health checks → allow.
      if (
        !origin ||
        (isDev && /^http:\/\/localhost:\d+$/.test(origin)) ||
        allowedOrigins.includes(origin)
      ) {
        return cb(null, true);
      }
      const corsErr = new Error(`Blocked by CORS: ${origin}`);
      corsErr.status = 403;
      return cb(corsErr);
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
// shared secret passed in the X-Ingest-Secret header. POST (not GET) so it
// can't be accidentally triggered by a browser navigation or uptime-monitor
// GET, and to match its JSearch twin and HTTP semantics for a mutating call.
app.post("/api/ingest/adzuna", async (req, res, next) => {
  // Fail-closed: reject if the secret is unset OR the header doesn't match.
  // This ensures the route never falls through to run ingestion without a key.
  if (!isValidIngestSecret(req)) {
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
    next(err);
  }
});

// ── JSearch ingest (protected) ──────────────────────────────────────────────
// Same X-Ingest-Secret guard as /api/ingest/adzuna. POST so it can't be
// accidentally triggered by a browser navigation or uptime-monitor GET.
app.post("/api/ingest/jsearch", async (req, res, next) => {
  if (!isValidIngestSecret(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const country = req.query.country || "in";
    const pages = Math.min(Math.max(Number.parseInt(req.query.pages, 10) || 1, 1), 3);
    const datePosted = req.query.date_posted || "month";
    const result = await ingestJSearch({ country, pages, datePosted });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── Combined ingest (fire-and-forget, for external schedulers) ─────────────
// POST /api/ingest — responds 202 immediately, then runs both Adzuna and
// JSearch ingestion in a background IIFE. Designed for GitHub Actions cron or
// any external scheduler that only needs to know the request was accepted.
// In-memory flag prevents overlapping runs on the single Render instance.
let ingestionInProgress = false;
app.post("/api/ingest", (req, res) => {
  if (!isValidIngestSecret(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (ingestionInProgress) {
    return res.status(200).json({ ok: true, message: "Ingestion already in progress" });
  }
  ingestionInProgress = true;
  res.status(202).json({ ok: true, message: "Ingestion started" });
  (async () => {
    const results = await Promise.allSettled([
      ingestAdzuna({ country: "in", pages: 3 }),
      ingestJSearch({ country: "in", pages: 1 }),
    ]);
    const [adzuna, jsearch] = results;
    if (adzuna.status === "rejected") console.error("Adzuna ingestion failed", adzuna.reason);
    else console.log("Adzuna ingestion complete", adzuna.value);
    if (jsearch.status === "rejected") console.error("JSearch ingestion failed", jsearch.reason);
    else console.log("JSearch ingestion complete", jsearch.value);
  })().finally(() => { ingestionInProgress = false; });
});

// ── Backfill dedupeKey (admin) ─────────────────────────────────────────────
// Stamps dedupeKey onto every existing Job doc that is missing it.
// Safe to call multiple times (idempotent: bulkWrite with upsert:false).
// Protected by the same X-Ingest-Secret header as the ingest endpoints.
app.post("/api/admin/backfill-dedupe", async (req, res, next) => {
  if (!isValidIngestSecret(req)) {
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
    next(err);
  }
});

// ── Trending skills ────────────────────────────────────────────────────────
app.get("/api/skills/trending", readLimiter, async (req, res, next) => {
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
    next(err);
  }
});

// ── All skills (for client-side search/filter) ─────────────────────────────
// Returns the full ranked skill list in one response. All searching/filtering
// is done client-side on this payload; this endpoint is fetched once on load.
app.get("/api/skills/all", readLimiter, async (req, res, next) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const skills = await getAllSkills({ months });
    res.json({ ok: true, skills });
  } catch (err) {
    next(err);
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
    console.warn(`Warm error: ${err.message}`);
    res.json({ ok: false, error: "warm failed" });
  }
});

// ── Skill detail ─────────────────────────────────────────────────────────
app.use("/api/skill", readLimiter, skillDetailRouter);

// ── Top companies (Who's Hiring) ──────────────────────────────────────────
// Public, read-only. Optional ?role=, ?skill=, ?months= filters.
app.get("/api/companies", readLimiter, async (req, res, next) => {
  try {
    const role = req.query.role || undefined;
    const skill = req.query.skill || undefined;
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const companies = await getTopCompanies({ role, skill, months, limit });
    res.json({ ok: true, companies });
  } catch (err) {
    next(err);
  }
});

// ── Salary Insights ──────────────────────────────────────────────────
// Public, read-only. Descriptive stats derived ONLY from disclosed salaries.
// Optional ?skill= ?role= ?months= (clamped 1-24, default 12).
// NOT added to /api/warm — query space is too large to pre-warm meaningfully.
app.get("/api/salary", readLimiter, async (req, res, next) => {
  try {
    const skill = req.query.skill || undefined;
    const role = req.query.role || undefined;
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const data = await getSalaryInsights({ skill, role, months });
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
});

// ── Watchlist (auth-gated) ─────────────────────────────────────────────────
app.use("/api/watchlist", watchlistLimiter, watchlistRouter);

// ── Skill-Gap Advisor (auth-gated) ─────────────────────────────────────────
// Returns skills that co-occur most often with the user's watchlist but that
// they don't already track. Auth-gated: userId comes from the Clerk JWT only.
app.get("/api/skill-gap", readLimiter, requireAuth(), async (req, res, next) => {
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
    next(err);
  }
});

// ── Résumé Gap Analyser (public) ───────────────────────────────────────────
// POST /api/resume-gap — accepts { text } (the raw résumé text), returns the
// gap between skills found in the résumé and the current top-40 demand list.
// Public (no Clerk) so unauthenticated users can try the feature before sign-up.
// Protected only by the same readLimiter as all other data endpoints.
app.post("/api/resume-gap", readLimiter, async (req, res, next) => {
  try {
    const { text: raw } = req.body || {};
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const text = raw.trim();
    if (text.length > 50_000) {
      return res.status(400).json({ ok: false, error: "Résumé text too long" });
    }

    // Reuse the cached all-skills aggregation (same source as trending/skill-gap).
    // Slice to top 40 by demand (getAllSkills already returns demand-desc order).
    const allSkills = await getAllSkills({ months: 12 });
    const demand = allSkills.slice(0, 40).map(({ skill, demand: count }) => ({ skill, count }));

    const result = computeResumeGap({ resumeText: text, demand });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── Central error handler ──────────────────────────────────────────────────
// Must be registered AFTER all routes. Routes signal errors via next(err).
// headersSent guard prevents double-response if a previous handler already
// flushed headers. Contextual log includes method + URL for easy grepping.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`${req.method} ${req.originalUrl}`, err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ ok: false, error: status >= 500 ? "Internal server error" : err.message });
});

export default app;
