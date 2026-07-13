import crypto from "node:crypto";
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { clerkMiddleware, requireAuth } from "@clerk/express";
import { ingestAdzuna } from "./ingest/adzuna.js";
import { ingestJSearch } from "./ingest/jsearch.js";
import { backfillDailySkillBuckets } from "./ingest/snapshot.js";
import { clearMomentumCache } from "./aggregations/skillMomentum.js";
import { clearSkillForecastCache } from "./aggregations/skillForecast.js";
import { getTrendingSkills, getAllSkills, clearTrendingCaches } from "./aggregations/trendingSkills.js";
import { computeSkillMomentum } from "./aggregations/skillMomentum.js";
import { computeSkillForecast } from "./aggregations/skillForecast.js";
import { computeSkillGapRoi, clearSkillGapRoiCache } from "./aggregations/skillGapRoi.js";
import { getTopCompanies, clearCompaniesCache } from "./aggregations/topCompanies.js";
import { getSalaryInsights, clearSalaryCache } from "./aggregations/salaryInsights.js";
import { getAtlas, clearAtlasCache } from "./aggregations/atlas.js";
import { relocationRoi, currencyForCountry } from "./lib/costOfLiving.js";
import { resolveSkill, resolveRole, KNOWN_ROLES } from "./lib/validate.js";
import { makeDedupeKey, normalizeLocation } from "./lib/dedupe.js";
import { geocodeCity, geocodeById, searchCities } from "./lib/geocode.js";
import { computeResumeGap } from "./lib/resumeGap.js";
import watchlistRouter from "./routes/watchlist.js";
import skillDetailRouter, { clearDetailCache } from "./routes/skillDetail.js";
import { clearPairsCache } from "./aggregations/skillPairs.js";
import Job from "./models/Job.js";
import { SALARY_BAND_IDS } from "./lib/salaryBands.js";
import Watchlist from "./models/Watchlist.js";
import { getPublicDatasetMetadata, emptyPublicDatasetMetadata } from "./lib/datasetState.js";

// ── Shared query-param parsers ─────────────────────────────────────────────

/** Parse and validate the `remote` query param. Returns { remote, error }. */
function parseRemoteFilter(query) {
  if (query.remote == null || String(query.remote).trim() === "") return {};
  const r = String(query.remote).trim().toLowerCase();
  if (r !== "remote" && r !== "onsite") {
    return { error: "Invalid remote filter. Valid: remote, onsite" };
  }
  return { remote: r };
}

/** Parse and validate the `disclosed` query param. Returns { disclosed, error }. */
function parseDisclosedFilter(query) {
  if (query.disclosed == null || String(query.disclosed).trim() === "") return {};
  const d = String(query.disclosed).trim();
  if (d !== "1") {
    return { error: "Invalid disclosed filter. Pass disclosed=1 to filter." };
  }
  return { disclosed: true };
}

/**
 * Parse the optional `country` query param (ISO-2 code).
 * A non-blank value is trimmed + lowercased and forwarded as an exact
 * geo.country match; codes with no matching data simply yield empty results.
 * Values that are not exactly two ASCII letters are treated as unset (no
 * filter) to bound the cache-key space and ignore malformed input.
 * The frontend dropdown only ever emits codes returned by /api/places/countries,
 * so in practice every value maps to real data.
 */
function parseCountryFilter(query) {
  if (query.country == null || String(query.country).trim() === "") return {};
  const c = String(query.country).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(c)) return {};
  return { country: c };
}

/**
 * Parse the optional `salary` query param (INR band id).
 * Valid ids: lt10, 10to25, 25to50, gte50.
 * Returns { salary: bandId } for a valid band, or {} for unknown/blank values
 * (no filter applied — same shape-guard discipline as country).
 */
function parseSalaryBandFilter(query) {
  if (query.salary == null || String(query.salary).trim() === "") return {};
  const id = String(query.salary).trim().toLowerCase();
  if (!SALARY_BAND_IDS.has(id)) return {};
  return { salary: id };
}


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
app.disable("x-powered-by");
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
    // A refused run (overlap / begin-failed) must NOT report success — the
    // caller needs to distinguish "nothing ran" from a real ingest result.
    if (result?.skipped) {
      const status = result.reason === "overlap" ? 409 : 503;
      return res.status(status).json({ ok: false, skipped: true, reason: result.reason });
    }
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
    // A refused run (overlap / begin-failed) must NOT report success — the
    // caller needs to distinguish "nothing ran" from a real ingest result.
    if (result?.skipped) {
      const status = result.reason === "overlap" ? 409 : 503;
      return res.status(status).json({ ok: false, skipped: true, reason: result.reason });
    }
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
    else if (adzuna.value?.skipped) console.log("Adzuna ingestion skipped", adzuna.value);
    else console.log("Adzuna ingestion complete", adzuna.value);
    if (jsearch.status === "rejected") console.error("JSearch ingestion failed", jsearch.reason);
    else if (jsearch.value?.skipped) console.log("JSearch ingestion skipped", jsearch.value);
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
    let bulkWriteError = null;
    if (ops.length > 0) {
      try {
        const result = await Job.bulkWrite(ops, { ordered: false });
        updated = result.modifiedCount || 0;
      } catch (bwErr) {
        // Surface partial counts from BulkWriteError instead of losing them.
        const partial = bwErr?.result;
        if (partial) {
          updated = partial.modifiedCount ?? partial.nModified ?? 0;
          bulkWriteError = {
            modifiedCount: updated,
            matchedCount: partial.matchedCount ?? partial.nMatched ?? 0,
          };
        } else {
          throw bwErr; // non-BulkWrite error — rethrow to central handler
        }
      }
    }
    // ── Invalidate affected caches ───────────────────────────────────────
    clearAtlasCache();
    clearSalaryCache();
    clearPairsCache();
    clearCompaniesCache();
    clearTrendingCaches();
    clearDetailCache();
    clearSkillGapRoiCache();
    res.json({ ok: true, processed: ops.length, updated, bulkWriteError });
  } catch (err) {
    next(err);
  }
});

// ── Backfill geo (admin) ─────────────────────────────────────────
// Resolves geo + geoConfidence onto every existing Job doc using geocodeCity().
// Mirrors /api/admin/backfill-dedupe: streamed cursor + bulkWrite(ordered:false).
// countryHint is inferred from the stored salary currency (best available
// signal for an existing row). Safe to call repeatedly (idempotent $set).
app.post("/api/admin/backfill-geo", async (req, res, next) => {
  if (!isValidIngestSecret(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    // Map stored salary currency -> ISO-2 country hint for geocodeCity().
    const CURRENCY_HINT = { INR: "in", USD: "us", GBP: "gb", CAD: "ca", AUD: "au" };
    const cursor = Job.find({}).select("location salaryRange.currency").lean().cursor();
    const ops = [];
    for await (const job of cursor) {
      const hint = CURRENCY_HINT[job.salaryRange?.currency] || undefined;
      const g = geocodeCity(normalizeLocation(job.location || ""), hint);
      ops.push({
        updateOne: {
          filter: { _id: job._id },
          update: { $set: { geo: g.value, geoConfidence: g.confidence } },
        },
      });
    }
    let updated = 0;
    let bulkWriteError = null;
    if (ops.length > 0) {
      try {
        const result = await Job.bulkWrite(ops, { ordered: false });
        updated = result.modifiedCount || 0;
      } catch (bwErr) {
        const partial = bwErr?.result;
        if (partial) {
          updated = partial.modifiedCount ?? partial.nModified ?? 0;
          bulkWriteError = {
            modifiedCount: updated,
            matchedCount: partial.matchedCount ?? partial.nMatched ?? 0,
          };
        } else {
          throw bwErr;
        }
      }
    }
    // ── Invalidate affected caches ───────────────────────────────────────
    clearAtlasCache();
    clearTrendingCaches();
    clearCountriesCache();
    res.json({ ok: true, processed: ops.length, updated, bulkWriteError });
  } catch (err) {
    next(err);
  }
});

// ── Backfill day-bucketed skill history (admin) ────────────────────────
// Aggregates ALL jobs into day-bucketed daily-flow SkillSnapshot rows
// (one doc per skill/UTC day; postingCount = new postings that day). This
// gives Trends/Momentum + Foresight/Forecast real history to read. Mirrors
// /api/admin/backfill-geo: protected by the same X-Ingest-Secret header and
// fully idempotent (upsert keyed on the unique { skill, date } index). Legacy
// capturedAt rows are left untouched. Clears the momentum + forecast caches on
// success so the next read reflects the freshly-banked history.
let skillBucketsBackfillInProgress = false;
app.post("/api/admin/backfill-skill-buckets", async (req, res, next) => {
  if (!isValidIngestSecret(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  // In-flight guard: the backfill recomputes the full history + prunes stale
  // rows, so two overlapping runs would fight over the same { skill, date } keys.
  // Skip (200) if one is already running rather than starting a second.
  if (skillBucketsBackfillInProgress) {
    return res.status(200).json({ ok: true, message: "Backfill already in progress" });
  }
skillBucketsBackfillInProgress = true;
try {
  const result = await backfillDailySkillBuckets();
  // Invalidate downstream caches whenever the backfill RAN — not only on
  // result.ok. The backfill can upsert/prune SkillSnapshot rows before a
  // later step reports failure; gating on ok would leave computeSkillGapRoi
  // (+ momentum/forecast) serving stale rankings off the old buckets.
  // Clearing is cheap and safe; a stale cache isn't. Auth failures return
  // above, so they still clear nothing.
  clearMomentumCache();
  clearSkillForecastCache();
  clearSkillGapRoiCache();
  const status = result.ok ? 200 : 500;
  res.status(status).json(result);
} catch (err) {
  next(err);
} finally {
  skillBucketsBackfillInProgress = false;
}
});

// ── Trending skills ────────────────────────────────────────────────
app.get("/api/skills/trending", readLimiter, async (req, res, next) => {
  try {
    let role;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }
    // remote / disclosed
    const rp = parseRemoteFilter(req.query);
    if (rp.error) return res.status(400).json({ ok: false, error: rp.error });
    const dp = parseDisclosedFilter(req.query);
    if (dp.error) return res.status(400).json({ ok: false, error: dp.error });
    const cp = parseCountryFilter(req.query);
    const sp = parseSalaryBandFilter(req.query);
    // Clamp months to [1, 24] and limit to [1, 100] to prevent expensive queries
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const result = await getTrendingSkills({ role, months, limit, remote: rp.remote, disclosed: dp.disclosed, country: cp.country, ...(sp.salary ? { salary: sp.salary } : {}) });

    // ── Dataset-state metadata (canonical freshness truth) ─────────────────
    // Public-safe view only: no runId / lastError / provider bodies / Mongo
    // detail ever reach the client. A read failure must NOT break ranking, so
    // fall back to the honest empty contract and log server-side only.
    let dataset;
    try {
      dataset = await getPublicDatasetMetadata();
    } catch (err) {
      console.warn(`dataset metadata read failed: ${err?.message}`);
      dataset = emptyPublicDatasetMetadata();
    }

    // Freshness precedence: canonical DatasetState.asOf first; before the first
    // tracked ingest (asOf === null) fall back to the newest Job updatedAt.
    // Never the browser fetch time — the fallback stays distinct from
    // DatasetState truth. Only run the fallback query when it can actually
    // matter (asOf is null) — this is a hot path, so skip the extra Job
    // lookup entirely once DatasetState has a real asOf. A failure here must
    // NOT break ranking either — same fail-safe posture as the dataset-state
    // read above: fall back to null and log server-side only.
    let newestJobUpdatedAt = null;
    if (dataset.asOf == null) {
      try {
        const newest = await Job.findOne()
          .sort({ updatedAt: -1 })
          .select("updatedAt")
          .lean();
        newestJobUpdatedAt = newest?.updatedAt || null;
      } catch (err) {
        console.warn(`newest Job fallback query failed: ${err?.message}`);
        newestJobUpdatedAt = null;
      }
    }

    // COMPARABILITY INVARIANT: a dataset version is eligible for client
    // rank-change comparison ONLY when dataset.ingestionInProgress === false.
    // The version may advance once per completed source run, so during a
    // combined ingest an intermediate version can exist while the other source
    // is still running. A future client must not fire final rank-change
    // announcements or resolve animations while ingestionInProgress is true.
    res.json({
      ok: true,
      ...result,
      lastUpdated: dataset.asOf ?? newestJobUpdatedAt ?? null,
      dataset,
    });
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

// ── Skill momentum (Trends: rising vs falling) ────────────────────────────
// Public, read-only. Compares the latest snapshot window against the prior
// window of equal length. Validates window [1,24], limit [1,50], role via
// resolveRole (null allowed). Cold-start returns insufficientHistory:true
// rather than an error. Does NOT alter /api/skills/trending.
app.get("/api/skills/momentum", readLimiter, async (req, res, next) => {
  try {
    // role — blank means "all"; an unknown non-blank role is a 400.
    let role = null;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }

    // window — integer months in [1, 24]. Reject non-numeric / out-of-range
    // explicitly (400) rather than silently clamping, per the route contract.
    const rawWindow = req.query.window == null || String(req.query.window).trim() === "" ? "3" : String(req.query.window).trim();
    const windowMonths = Number(rawWindow);
    if (!Number.isInteger(windowMonths) || windowMonths < 1 || windowMonths > 24) {
      return res.status(400).json({ ok: false, error: "Invalid window. Use an integer number of months in [1, 24]." });
    }

    // limit — integer in [1, 50].
    const rawLimit = req.query.limit == null || String(req.query.limit).trim() === "" ? "20" : String(req.query.limit).trim();
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ ok: false, error: "Invalid limit. Use an integer in [1, 50]." });
    }

    const data = await computeSkillMomentum({ windowMonths, role, limit });
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
});

// ── Skill forecast (Foresight: projected demand) ──────────────────────────
// Public, read-only — same posture as /api/skills/momentum. Fits a deterministic
// least-squares linear trend over each skill's banked postingCount history and
// projects demand `horizon` months out. Validates horizon [1,24], limit [1,50],
// role via resolveRole (null allowed); 400 on invalid rather than a silent
// clamp. Cold-start returns insufficientHistory:true (never an error). Does NOT
// alter /api/skills/momentum or /api/skills/trending.
app.get("/api/skills/forecast", readLimiter, async (req, res, next) => {
  try {
    // role — blank means "all"; an unknown non-blank role is a 400. NOTE: like
    // /api/skills/momentum, snapshots have no role dimension and getAllSkills
    // takes no role, so role only affects the cache key — it does NOT filter
    // results. Kept for a stable, momentum-consistent contract; the client
    // exposes no role control for Foresight.
    let role = null;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }

    // horizon — integer months in [1, 24].
    const rawHorizon = req.query.horizon == null || String(req.query.horizon).trim() === "" ? "6" : String(req.query.horizon).trim();
    const horizonMonths = Number(rawHorizon);
    if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 24) {
      return res.status(400).json({ ok: false, error: "Invalid horizon. Use an integer number of months in [1, 24]." });
    }

    // limit — integer in [1, 50].
    const rawLimit = req.query.limit == null || String(req.query.limit).trim() === "" ? "20" : String(req.query.limit).trim();
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ ok: false, error: "Invalid limit. Use an integer in [1, 50]." });
    }

    const data = await computeSkillForecast({ role, horizonMonths, limit });
    res.json({ ok: true, ...data });
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
    let role, skill;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }
    if (req.query.skill != null && String(req.query.skill).trim() !== "") {
      skill = resolveSkill(req.query.skill);
      if (!skill) {
        return res.status(400).json({ ok: false, error: "Unknown skill — see /api/skills/all for valid values." });
      }
    }
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
    let role, skill;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }
    if (req.query.skill != null && String(req.query.skill).trim() !== "") {
      skill = resolveSkill(req.query.skill);
      if (!skill) {
        return res.status(400).json({ ok: false, error: "Unknown skill — see /api/skills/all for valid values." });
      }
    }
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const data = await getSalaryInsights({ skill, role, months });
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
});

// ── Distinct countries endpoint (lightweight, cached) ────────────────────
// Returns unique geo.country values with job counts for the country dropdown.
// Codes are trim + lowercased and duplicates that collapse to the same key
// are merged (summed). Response: { ok, countries: [{ code, count }] }.
let _countriesCache = null;
let _countriesCacheExpiry = 0;
const COUNTRIES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Clear the countries cache. Exported for test isolation. */
export function clearCountriesCache() {
  _countriesCache = null;
  _countriesCacheExpiry = 0;
}

app.get("/api/places/countries", readLimiter, async (_req, res, next) => {
  try {
    if (_countriesCache && Date.now() < _countriesCacheExpiry) {
      return res.json({ ok: true, countries: _countriesCache });
    }
    const raw = await Job.aggregate([
      { $match: { "geo.country": { $ne: null } } },
      { $group: { _id: "$geo.country", count: { $sum: 1 } } },
    ]);
    // Canonicalize: trim+lowercase, merge duplicates, drop blanks.
    const merged = new Map();
    for (const row of raw) {
      const code = String(row._id).trim().toLowerCase();
      if (!/^[a-z]{2}$/.test(code)) continue;
      merged.set(code, (merged.get(code) || 0) + row.count);
    }
    const countries = [...merged.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
    _countriesCache = countries;
    _countriesCacheExpiry = Date.now() + COUNTRIES_TTL_MS;
    res.json({ ok: true, countries });
  } catch (err) {
    next(err);
  }
});

// ── Atlas — public Opportunity Map ───────────────────────────────────
// Public, read-only. Per-VERIFIED-city demand, disclosed avg salary, and
// 30-day momentum. Optional ?role= ?skill= ?months= (clamped 1-24, default 12).
app.get("/api/atlas", readLimiter, async (req, res, next) => {
  try {
    let role, skill;
    if (req.query.role != null && String(req.query.role).trim() !== "") {
      role = resolveRole(req.query.role);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }
    if (req.query.skill != null && String(req.query.skill).trim() !== "") {
      skill = resolveSkill(req.query.skill);
      if (!skill) {
        return res.status(400).json({ ok: false, error: "Unknown skill — see /api/skills/all for valid values." });
      }
    }
    // remote / disclosed
    const rp = parseRemoteFilter(req.query);
    if (rp.error) return res.status(400).json({ ok: false, error: rp.error });
    const dp = parseDisclosedFilter(req.query);
    if (dp.error) return res.status(400).json({ ok: false, error: dp.error });
    const cp = parseCountryFilter(req.query);
    const sp = parseSalaryBandFilter(req.query);
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const data = await getAtlas({ role, skill, months, remote: rp.remote, disclosed: dp.disclosed, country: cp.country, ...(sp.salary ? { salary: sp.salary } : {}) });
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
});

// ── Relocation ROI (public) ──────────────────────────────────────────
// Converts a nominal salary's purchasing power between two places.
// Query: from, to (city token OR 2-letter country code), salary (number),
// currency (INR/USD/GBP/CAD/AUD), optional targetSalary. Pure compute (no DB).
const RELO_CURRENCIES = new Set(["INR", "USD", "GBP", "CAD", "AUD"]);
const MAX_SALARY = 1_000_000_000; // sane upper bound (covers any currency)

// Supported countries for the relocation feature + the suggest endpoint.
// Each entry exposes the ISO-2 code and a human-readable name.
const SUPPORTED_COUNTRIES = [
  { code: "in", name: "India" },
  { code: "us", name: "United States" },
  { code: "gb", name: "United Kingdom" },
  { code: "ca", name: "Canada" },
  { code: "au", name: "Australia" },
];

// Human-readable name for a supported ISO-2 country code, or the uppercased
// code as a fallback for any country not in the supported list.
function countryName(code) {
  const key = String(code || "").toLowerCase();
  const found = SUPPORTED_COUNTRIES.find((c) => c.code === key);
  return found ? found.name : key.toUpperCase();
}

// admin1 is only meaningful to show when it is an alphabetic code/name
// (e.g. US "CA"); some gazetteer rows store numeric admin1 codes (e.g. India
// "19") which are noise in a label, so we omit those.
function isAlphaAdmin1(admin1) {
  return typeof admin1 === "string" && admin1.trim() !== "" && /[A-Za-z]/.test(admin1) && !/^\d+$/.test(admin1);
}

// Build a city label from a gazetteer record, using the city NAME (never the
// geonameId). Includes admin1 only when alphabetic: "San Francisco, CA, US"
// vs "Bengaluru, IN".
function cityDisplayName(rec) {
  const parts = [rec.city];
  if (isAlphaAdmin1(rec.admin1)) parts.push(rec.admin1);
  parts.push((rec.country || "").toUpperCase());
  return parts.join(", ");
}

// Resolve a `from`/`to` param to a rich descriptor including display info.
// A numeric token is treated as a geonameId and resolved deterministically
// against the gazetteer (no fuzzy matching). A bare 2-letter token is treated
// as a country code (no city multiplier); anything else is geocoded to a
// verified city by name. Returns null on no match.
//
// Shape: { country, geonameId?, city?, admin1?, displayName }.
function resolvePlace(raw) {
  const token = String(raw || "").trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const rec = geocodeById(token);
    if (!rec) return null;
    return {
      country: rec.country,
      geonameId: rec.geonameId,
      city: rec.city,
      admin1: isAlphaAdmin1(rec.admin1) ? rec.admin1 : undefined,
      displayName: cityDisplayName(rec),
    };
  }
  if (/^[A-Za-z]{2}$/.test(token)) {
    const country = token.toLowerCase();
    return { country, geonameId: undefined, displayName: countryName(country) };
  }
  const g = geocodeCity(normalizeLocation(token));
  if (!g.value) return null;
  return {
    country: g.value.country,
    geonameId: g.value.geonameId,
    city: g.value.city,
    admin1: isAlphaAdmin1(g.value.admin1) ? g.value.admin1 : undefined,
    displayName: cityDisplayName(g.value),
  };
}

// ── Places suggest (typeahead) ───────────────────────────────────────
// Public, read-only. Returns up to `limit` verified-city matches PLUS any
// supported country whose name or ISO-2 code matches the query. Cities carry
// a geonameId token; countries carry an iso2 token. The frontend stores the
// token and submits it to /api/relocation for deterministic resolution.
app.get("/api/places/suggest", readLimiter, (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      return res.status(400).json({ ok: false, error: "`q` is required." });
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 8, 1), 15);

    const cities = searchCities(q, limit).map((c) => ({
      type: "city",
      // Use the city NAME and omit numeric admin1 codes:
      // "San Francisco, CA, US" vs "Bengaluru, IN".
      label: cityDisplayName(c),
      token: String(c.geonameId),
      geonameId: c.geonameId,
      country: c.country,
    }));

    const ql = q.toLowerCase();
    const countries = SUPPORTED_COUNTRIES.filter(
      (c) => c.code === ql || c.name.toLowerCase().includes(ql),
    ).map((c) => ({
      type: "country",
      label: c.name,
      token: c.code,
      country: c.code,
    }));

    res.json({ suggestions: [...cities, ...countries] });
  } catch (err) {
    next(err);
  }
});

app.get("/api/relocation", readLimiter, (req, res, next) => {
  try {
    const { from: fromRaw, to: toRaw } = req.query;
    if (!fromRaw || !toRaw) {
      return res.status(400).json({ ok: false, error: "`from` and `to` are required (city name or 2-letter country code)." });
    }

    const currency = String(req.query.currency || "").toUpperCase();
    if (!RELO_CURRENCIES.has(currency)) {
      return res.status(400).json({ ok: false, error: `Unknown currency. Valid: ${[...RELO_CURRENCIES].join(", ")}` });
    }

    const salary = Number(req.query.salary);
    if (!Number.isFinite(salary) || salary <= 0) {
      return res.status(400).json({ ok: false, error: "`salary` must be a positive number." });
    }
    const clampedSalary = Math.min(salary, MAX_SALARY);

    let targetSalary;
    if (req.query.targetSalary != null && String(req.query.targetSalary).trim() !== "") {
      const t = Number(req.query.targetSalary);
      if (!Number.isFinite(t) || t <= 0) {
        return res.status(400).json({ ok: false, error: "`targetSalary` must be a positive number." });
      }
      targetSalary = Math.min(t, MAX_SALARY);
    }

    const from = resolvePlace(fromRaw);
    const to = resolvePlace(toRaw);
    if (!from) {
      return res.status(400).json({ ok: false, error: `Couldn't resolve \`from\`: "${fromRaw}". Use a known city or 2-letter country code.` });
    }
    if (!to) {
      return res.status(400).json({ ok: false, error: `Couldn't resolve \`to\`: "${toRaw}". Use a known city or 2-letter country code.` });
    }

    const result = relocationRoi({
      salary: clampedSalary,
      currency,
      fromCountry: from.country,
      fromGeonameId: from.geonameId,
      toCountry: to.country,
      toGeonameId: to.geonameId,
      targetSalary,
    });

    res.json({
      ok: true,
      from: { ...from, input: fromRaw, currency: currencyForCountry(from.country) },
      to: { ...to, input: toRaw, currency: currencyForCountry(to.country) },
      // `from`/`to` above already carry { geonameId?, city?, admin1?, country,
      // displayName }; `currency` is appended for the destination symbol.
      salary: clampedSalary,
      currency,
      targetSalary: targetSalary ?? null,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

// ── Watchlist (auth-gated) ─────────────────────────────────────────────────
app.use("/api/watchlist", watchlistLimiter, watchlistRouter);

// ── Skill-Gap Advisor (auth-gated) ─────────────────────────────────────────
// Ranked skill recommendations scored by a transparent blend of live demand,
// momentum, disclosed-INR salary lift, and co-occurrence affinity with what the
// user already knows. Auth-gated: userId comes from the Clerk JWT only (auth
// contract unchanged). GET uses the caller's watchlist as knownSkills; POST may
// additionally supply an explicit { knownSkills: [...] } array.
async function skillGapRoiHandler(req, res, next) {
  try {
    const userId = req.auth.userId;

    // months + limit: clamp (limit in [1,50] per the route contract).
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
    const rawLimit = req.query.limit ?? (req.body && req.body.limit);
    const limit = Math.min(Math.max(Number(rawLimit) || 12, 1), 50);

    // role: optional, must resolve to a known bucket when present (else 400).
    let role = null;
    const rawRole = req.query.role ?? (req.body && req.body.role);
    if (rawRole != null && String(rawRole).trim() !== "") {
      role = resolveRole(rawRole);
      if (!role) {
        return res.status(400).json({ ok: false, error: `Unknown role. Valid: ${KNOWN_ROLES.join(", ")}` });
      }
    }

    // knownSkills: default to the caller's own watchlist (authoritative, read by
    // verified userId). POST may override with an explicit array; a non-array
    // body value is structurally invalid → 400. Unknown skills are dropped
    // inside computeSkillGapRoi (resolveSkill), never rejected here.
    let knownSkills;
    if (req.body && req.body.knownSkills !== undefined) {
      if (!Array.isArray(req.body.knownSkills)) {
        return res.status(400).json({ ok: false, error: "knownSkills must be an array of skill names." });
      }
      knownSkills = req.body.knownSkills;
    } else {
      const items = await Watchlist.find({ userId }).lean();
      knownSkills = items.map((i) => i.skill);
    }

    const data = await computeSkillGapRoi({ knownSkills, role, limit, months });
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
}

app.get("/api/skill-gap", readLimiter, requireAuth(), skillGapRoiHandler);
app.post("/api/skill-gap", readLimiter, requireAuth(), skillGapRoiHandler);

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

// ── Sentry error handler (must precede the central handler) ────────────────
// Feeds unhandled route errors to Sentry so they appear in the dashboard.
// No-op when SENTRY_DSN is unset (Sentry.init was never called).
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Central error handler ──────────────────────────────────────────────────
// Must be registered AFTER all routes. Routes signal errors via next(err).
// headersSent guard prevents double-response if a previous handler already
// flushed headers. Contextual log includes method + URL for easy grepping.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("%s %s", req.method, req.originalUrl, err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ ok: false, error: status >= 500 ? "Internal server error" : err.message });
});

export default app;
