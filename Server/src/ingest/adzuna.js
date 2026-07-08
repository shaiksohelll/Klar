import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { extractSkills, normalizeRole } from "../lib/skills.js";
import { detectRemote } from "../lib/remote.js";
import { makeDedupeKey, normalizeLocation } from "../lib/dedupe.js";
import { geocodeCity } from "../lib/geocode.js";
import { clearTrendingCaches } from "../aggregations/trendingSkills.js";
import { clearPairsCache } from "../aggregations/skillPairs.js";
import { clearDetailCache } from "../routes/skillDetail.js";
import { clearCompaniesCache } from "../aggregations/topCompanies.js";
import { clearSalaryCache } from "../aggregations/salaryInsights.js";
import { clearAtlasCache } from "../aggregations/atlas.js";
import { clearMomentumCache } from "../aggregations/skillMomentum.js";
import { clearSkillForecastCache } from "../aggregations/skillForecast.js";
import { clearSkillGapRoiCache } from "../aggregations/skillGapRoi.js";
import { recordDailySkillBuckets } from "./snapshot.js";

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

// Roles we sweep for full market breadth (used when no specific search term is given)
const ROLE_QUERIES = [
  "frontend developer",
  "backend developer",
  "full stack developer",
  "devops engineer",
  "data engineer",
  "mobile developer",
  "software developer",
];

// Fetch one page of results from Adzuna
// Wraps the request in a 10-second AbortController timeout so a stalled
// connection settles the Promise.allSettled entry (rejected) rather than
// hanging the entire ingest run indefinitely.
async function fetchPage({ country, page, what }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url =
      `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}` +
      `?app_id=${APP_ID}&app_key=${APP_KEY}` +
      `&results_per_page=50&what=${encodeURIComponent(what)}&content-type=application/json`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Adzuna ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Map one Adzuna job into our Job schema shape
function mapJob(raw, country) {
  const title = raw.title || "";
  const description = raw.description || "";
  const companyName = raw.company?.display_name || "";
  const min = raw.salary_min ?? null;
  const max = raw.salary_max ?? null;
  const midpoint =
    min != null && max != null ? (min + max) / 2 : (min ?? max ?? null);
  // Resolve the posting's display location to a VERIFIED GeoNames place.
  // countryHint = the Adzuna country code (already ISO-2 lowercased, e.g. "in").
  const g = geocodeCity(normalizeLocation(raw.location?.display_name || ""), country);
  return {
    externalId: String(raw.id),
    source: "adzuna",
    title,
    normalizedRole: normalizeRole(title),
    companyName,
    isRemote: detectRemote(`${title} ${description}`),
    requiredSkills: extractSkills(`${title} ${description}`),
    salaryRange: {
      min,
      max,
      midpoint,
      currency: country === "in" ? "INR" : country === "us" ? "USD" : "GBP",
    },
    // Mark as disclosed when Adzuna provides a real salary figure (min OR max —
    // matching the midpoint logic above, which uses min ?? max) and has NOT
    // flagged it as predicted/estimated. salary_is_predicted is coerced to a
    // string first so a numeric 1 is treated the same as the string "1".
    salaryDisclosed: Boolean(
      (raw.salary_min || raw.salary_max) &&
        String(raw.salary_is_predicted) !== "1",
    ),
    location: raw.location?.display_name || "",
    redirectUrl: raw.redirect_url || "",
    postedAt: raw.created ? new Date(raw.created) : new Date(),
    dedupeKey: makeDedupeKey(companyName, title, raw.location?.display_name || ""),
    geo: g.value,
    geoConfidence: g.confidence,
  };
}

export async function ingestAdzuna({
  what,
  queries,
  country = "in",
  pages = 2,
  prune,
} = {}) {
  if (!APP_ID || !APP_KEY) {
    throw new Error("Missing ADZUNA_APP_ID or ADZUNA_APP_KEY in .env");
  }

  // What to search: explicit queries → single `what` → else all roles (breadth)
  const searchTerms = queries?.length ? queries : what ? [what] : ROLE_QUERIES;
  // Only prune stale jobs on a full sweep (not a narrow single-term query)
  const shouldPrune = prune ?? (!what && !queries?.length);

  const runStartedAt = new Date();
  let fetched = 0;
  const docsById = new Map(); // dedupe: same job can match multiple role queries

  // Build every (term, page) pair we need to fetch, then fire them all in
  // parallel with Promise.allSettled so a single Adzuna hiccup doesn't abort
  // the whole run — we just skip that batch and log the warning.
  const fetchJobs = searchTerms.flatMap((term) =>
    Array.from({ length: pages }, (_, i) => ({ term, page: i + 1 })),
  );

  const responses = await Promise.allSettled(
    fetchJobs.map(({ term, page }) => fetchPage({ country, page, what: term })),
  );

  let hadFailures = false;
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === "rejected") {
      hadFailures = true;
      console.warn(
        `Adzuna fetch failed [term="${fetchJobs[i].term}" page=${fetchJobs[i].page}]:`,
        responses[i].reason?.message,
      );
      continue;
    }
    const results = responses[i].value?.results || [];
    fetched += results.length;
    for (const raw of results) {
      const doc = mapJob(raw, country);
      docsById.set(doc.externalId, doc);
    }
  }

  const ops = [...docsById.values()].map((doc) => ({
    updateOne: {
      filter: { source: doc.source, externalId: doc.externalId },
      update: { $set: doc },
      upsert: true,
    },
  }));

  let upserted = 0;
  let modified = 0;
  let bulkWriteError = null;
  if (ops.length > 0) {
    try {
      const result = await Job.bulkWrite(ops, { ordered: false });
      upserted = result.upsertedCount || 0;
      modified = result.modifiedCount || 0;
    } catch (err) {
      // BulkWriteError (e.g. E11000 on {source,externalId} under concurrent
      // runs) still carries a partial result under ordered:false. Surface the
      // ops that landed instead of reporting total failure, and CONTINUE to the
      // prune + cache-clear block. Mirrors recordDailySkillBuckets (snapshot.js).
      const partial = err?.result;
      if (partial) {
        upserted = partial.upsertedCount ?? partial.nUpserted ?? 0;
        modified = partial.modifiedCount ?? partial.nModified ?? 0;
        bulkWriteError = {
          upsertedCount: upserted,
          modifiedCount: modified,
          matchedCount: partial.matchedCount ?? partial.nMatched ?? 0,
        };
        console.warn(
          `Adzuna bulkWrite partial success (${upserted} upserted, ${modified} modified) — ${err?.message}`,
        );
      } else {
        throw err; // not a BulkWriteError — propagate unexpected errors.
      }
    }
  }

  let removed = 0;
  let pruneBatchFailures = 0;
  // Skip pruning whenever any fetch failed: we only saw a partial snapshot of
  // the current market, so jobs that weren't refreshed this run should not be
  // deleted — they may still be live, we just couldn't reach Adzuna for them.
  if ((hadFailures || bulkWriteError) && shouldPrune) {
    console.warn("prune skipped due to fetch failures or bulkWrite error");
  }
  if (shouldPrune && !hadFailures && !bulkWriteError && fetched > 0) {
    // Chunked delete: a single unbounded deleteMany over a large stale
    // partition can hold a long-lived lock / spike WAL. Find the stale _ids,
    // then delete in batches of 500 with per-batch partial-success accounting.
    // Mirrors recordDailySkillBuckets' chunked prune (snapshot.js).
    const staleIds = await Job.find({
      source: "adzuna",
      updatedAt: { $lt: runStartedAt },
    })
      .select("_id")
      .lean();
    const BATCH = 500;
    for (let i = 0; i < staleIds.length; i += BATCH) {
      const batch = staleIds.slice(i, i + BATCH);
      const deleteOps = batch.map((doc) => ({
        deleteOne: {
          filter: {
            _id: doc._id,
            source: "adzuna",
            updatedAt: { $lt: runStartedAt },
          },
        },
      }));
      try {
        const delResult = await Job.bulkWrite(deleteOps, { ordered: false });
        removed += delResult.deletedCount || 0;
      } catch (batchErr) {
        // ANY caught error is a batch failure — increment unconditionally so
        // an incomplete prune never looks clean in the return value.
        pruneBatchFailures++;
        // Partial-success: a BulkWriteError still carries a result.
        const partial = batchErr?.result;
        if (partial) {
          removed += partial.deletedCount ?? partial.nRemoved ?? 0;
        }
        console.warn(
          `Adzuna prune batch ${Math.floor(i / BATCH) + 1} failed — ${batchErr?.message}`,
        );
      }
    }
  }

  // Count once: used both as the snapshot safety guard and the return value.
  const totalInDb = await Job.countDocuments();

  // ── Skill-velocity snapshot ──────────────────────────────────────────────
  // Records a point-in-time demand reading for every skill so we can later
  // compute velocity (rising / falling). Isolated in its own try/catch so a
  // snapshot failure never breaks or throws out of ingest.
  try {
    if (totalInDb > 0) {
      // Outer window matches the Demand page default (12 months).
      // count30 is a conditional sum inside the same pass — one aggregation.
      const since = new Date();
      since.setMonth(since.getMonth() - 12);
      const since30 = new Date();
      since30.setDate(since30.getDate() - 30);

      const counts = await Job.aggregate([
        { $match: { postedAt: { $gte: since } } },
        { $unwind: "$requiredSkills" },
        {
          $group: {
            _id: "$requiredSkills",
            count: { $sum: 1 },
            count30: {
              $sum: { $cond: [{ $gte: ["$postedAt", since30] }, 1, 0] },
            },
          },
        },
      ]);

      if (counts.length > 0) {
        const capturedAt = new Date();
        await SkillSnapshot.insertMany(
          counts.map(({ _id, count, count30 }) => ({
            skill: _id,
            count,
            count30,
            capturedAt,
          })),
          { ordered: false },
        );
        console.log(`snapshot: recorded demand for ${counts.length} skills`);
      }
    }
  } catch (err) {
    console.warn("snapshot failed:", err.message);
  }

  // ── Day-bucketed daily-flow rows (Trends/Foresight history) ─────────────
  // Banks one row per (skill, UTC day) with postingCount = new postings that
  // day. Recomputes the last 2 UTC days so partial-day ingests self-heal.
  // Non-fatal by contract; the extra try/catch is belt-and-braces so a
  // snapshot failure can NEVER abort the ingest run.
  try {
    await recordDailySkillBuckets();
  } catch (err) {
    console.warn("daily buckets threw unexpectedly:", err?.message);
  }

  // ── Invalidate read caches ─────────────────────────────────────────────
  // The underlying data has changed. Clear every in-memory cache so the next
  // request recomputes from the freshly-written rows.
  clearTrendingCaches();
  clearPairsCache();
  clearDetailCache();
  clearCompaniesCache();
  clearSalaryCache();
  clearAtlasCache();
  // Momentum + forecast read from the freshly-written day-buckets. Mirror the
  // admin backfill route so /api/skills/momentum and /api/skills/forecast never
  // serve up to 6h of stale results after a normal ingest.
  clearMomentumCache();
  clearSkillForecastCache();
  // ROI cache was the 9th createTtlCache; clearing it here stops the "Learn
  // Next" recommendations from serving up to 6h of stale results after ingest.
  clearSkillGapRoiCache();
  console.log("🗑️  Read caches cleared after ingest");

  return {
    fetched,
    unique: docsById.size,
    upserted,
    modified,
    removed,
    pruneFailures: pruneBatchFailures,
    totalInDb,
    bulkWriteError,
  };
}
