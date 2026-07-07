import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { dedupeGroupStages } from "../lib/dedupe.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { salaryBandMatch, SALARY_BAND_IDS } from "../lib/salaryBands.js";

// ── In-memory TTL cache for getAllSkills ────────────────────────────────────
// Key: months (number). Value: { data, expiresAt }.
// TTL is long (6 h) because data only changes when ingestAdzuna() runs, which
// calls clearTrendingCaches() immediately after each successful write.
const ALL_SKILLS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ALL_SKILLS_CACHE = createTtlCache({ ttlMs: ALL_SKILLS_TTL_MS, maxEntries: 500 });

// ── In-memory TTL cache for getTrendingSkills ───────────────────────────────
// Key: `${role||"all"}:${months}:${limit}`. Value: { data, expiresAt }.
const TRENDING_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const TRENDING_CACHE = createTtlCache({ ttlMs: TRENDING_TTL_MS, maxEntries: 500 });

// ── Velocity snapshot context (promise-coalescing) ──────────────────────────
// The snapshot lookups (latest batch, baseline batch, nowDocs, baseDocs) are
// identical for every getTrendingSkills call regardless of role/months/limit.
// When /api/warm fires N concurrent calls, this coalesces them into a single
// DB round-trip instead of N duplicate ones.
let _velocityCtxPromise = null;
let _velocityCtxCache = null;   // { value, expiresAt }
let _cacheGeneration   = 0;     // bumped by clearTrendingCaches()

async function _loadVelocityContext() {
  // 1. Return cached result if still fresh.
  if (_velocityCtxCache && Date.now() < _velocityCtxCache.expiresAt) {
    return _velocityCtxCache.value;
  }
  // 2. If another caller is already in-flight, piggyback on its promise.
  if (_velocityCtxPromise) return _velocityCtxPromise;

  // 3. First caller — do the work.
  //    Capture the generation BEFORE any async work so we can detect a
  //    clearTrendingCaches() call that landed mid-flight.
  const gen = _cacheGeneration;

  const promise = (async () => {
    try {
      const latestSnap = await SkillSnapshot.findOne()
        .sort({ capturedAt: -1 })
        .select("capturedAt")
        .lean();

      if (!latestSnap) return null; // no snapshot history yet

      const latestCapturedAt = latestSnap.capturedAt;
      const sevenDaysAgo = new Date(latestCapturedAt);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const [idealBase, oldestBase] = await Promise.all([
        SkillSnapshot.findOne({ capturedAt: { $lte: sevenDaysAgo } })
          .sort({ capturedAt: -1 })
          .select("capturedAt")
          .lean(),
        SkillSnapshot.findOne().sort({ capturedAt: 1 }).select("capturedAt").lean(),
      ]);

      const baseSnap = idealBase ?? oldestBase;
      if (!baseSnap) return null; // collection emptied mid-flight; reload next call
      const baselineCapturedAt = baseSnap.capturedAt;
      const gapDays = Math.floor(
        (latestCapturedAt.getTime() - baselineCapturedAt.getTime()) / 86_400_000,
      );

      if (gapDays < 2) {
        const ctx = { gapDays, tooClose: true };
        if (gen === _cacheGeneration) {
          _velocityCtxCache = { value: ctx, expiresAt: Date.now() + TRENDING_TTL_MS };
        }
        return ctx;
      }

      const [nowDocs, baseDocs] = await Promise.all([
        SkillSnapshot.find({ capturedAt: latestCapturedAt })
          .select("skill count30 -_id")
          .lean(),
        SkillSnapshot.find({ capturedAt: baselineCapturedAt })
          .select("skill count30 -_id")
          .lean(),
      ]);

      const nowMap = new Map(nowDocs.map(({ skill, count30 }) => [skill, count30]));
      const baseMap = new Map(baseDocs.map(({ skill, count30 }) => [skill, count30]));

      const ctx = { gapDays, tooClose: false, nowMap, baseMap };
      // Only cache if no clear happened while we were loading.
      // If gen drifted, return the result to THIS caller (no wasted work)
      // but leave the cache empty so the next request reloads fresh.
      if (gen === _cacheGeneration) {
        _velocityCtxCache = { value: ctx, expiresAt: Date.now() + TRENDING_TTL_MS };
      }
      return ctx;
    } finally {
      // Only clear the in-flight promise if it's still ours.
      if (gen === _cacheGeneration) {
        _velocityCtxPromise = null;
      }
    }
  })();

  // Guard: a clearTrendingCaches() call may have fired synchronously during the
  // IIFE's startup (before the first await). If the generation drifted, do NOT
  // store the stale promise in the module variable — return it to this caller
  // only so the next request starts a fresh load.
  if (gen === _cacheGeneration) {
    _velocityCtxPromise = promise;
  }

  return promise;
}

// Exposed for testing only — verifies the coalescing behaviour.
export { _loadVelocityContext };

/**
 * Clears both trending caches. Called by ingestAdzuna() right after a
 * successful bulkWrite so the next request recomputes from fresh data.
 */
export function clearTrendingCaches() {
  ALL_SKILLS_CACHE.clear();
  TRENDING_CACHE.clear();
  _velocityCtxCache = null;
  _velocityCtxPromise = null;
  _cacheGeneration++;
}

/**
 * Returns the full ranked skill list for /api/skills/all.
 * Reuses the same $facet aggregation as getTrendingSkills but:
 *  - no limit (returns every skill in the collection)
 *  - no velocity/snapshot queries (not needed for search/filter UX)
 *  - adds remoteShare as a 0-1 float so the frontend can sort/filter on it
 *
 * Results are cached in-process for 6 hours (TTL). The cache invalidates
 * naturally — no manual busting required.
 *
 * Shape: Array<{ skill, demand, remoteCount, remoteShare }>
 */
export async function getAllSkills({ months = 12 } = {}) {
  const key = Number(months);
  const hit = ALL_SKILLS_CACHE.get(key);
  if (hit) return hit;

  const since = new Date();
  since.setMonth(since.getMonth() - key);

  const [facetResult] = await Job.aggregate([
    { $match: { postedAt: { $gte: since } } },
    // Deduplicate cross-source twins before counting.
    // Postcondition: at most one doc per (company, title) per window.
    ...dedupeGroupStages(),
    {
      $facet: {
        skills: [
          { $unwind: "$requiredSkills" },
          {
            $group: {
              _id: "$requiredSkills",
              demand: { $sum: 1 },
              remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
            },
          },
          { $sort: { demand: -1 } },
          {
            $project: {
              _id: 0,
              skill: "$_id",
              demand: 1,
              remoteCount: 1,
            },
          },
        ],
      },
    },
  ]);

  const skills = (facetResult?.skills ?? []).map((s) => ({
    ...s,
    remoteShare: s.demand > 0 ? s.remoteCount / s.demand : 0,
  }));

  ALL_SKILLS_CACHE.set(key, skills);
  return skills;
}

export async function getTrendingSkills({ role, months = 12, limit = 25, remote, disclosed, country, salary }) {
  // Normalize salary before the cache key: unknown/empty strings would fragment
  // the cache into identical but separately-cached entries.
  const normalizedSalary = SALARY_BAND_IDS.has(salary) ? salary : "";
  const cacheKey = `${role || "all"}:${months}:${limit}:${remote || "any"}:${disclosed ? "yes" : "no"}:${country || "any"}:${normalizedSalary || "any"}`;
  const hit = TRENDING_CACHE.get(cacheKey);
  if (hit) return hit;

  // Only look at jobs posted within the last N months
  const since = new Date();
  since.setMonth(since.getMonth() - Number(months));

  const match = { postedAt: { $gte: since } };
  if (role) match.normalizedRole = role; // e.g. "backend", "frontend"
  if (remote === "remote") match.isRemote = true;
  else if (remote === "onsite") match.isRemote = false;
  if (disclosed) match.salaryDisclosed = true;
  if (country) match["geo.country"] = country;
  if (salary) Object.assign(match, salaryBandMatch(salary));

  // Single round-trip: $facet runs totalJobs count and the skills aggregation
  // together so MongoDB only scans the collection once.
  const [facetResult] = await Job.aggregate([
    { $match: match },
    // Deduplicate cross-source twins before counting.
    ...dedupeGroupStages(),
    {
      $facet: {
        // Branch A: just count the matched (deduped) documents
        totalJobs: [{ $count: "count" }],
        // Branch B: unwind → group → sort → limit → project
        skills: [
          { $unwind: "$requiredSkills" },
          {
            $group: {
              _id: "$requiredSkills",
              demand: { $sum: 1 },
              // Disclosed-only average: $avg ignores nulls, so postings
              // without an employer-disclosed salary never drag the figure.
              avgSalary: {
                $avg: {
                  $cond: [
                    { $eq: ["$salaryDisclosed", true] },
                    "$salaryRange.midpoint",
                    null,
                  ],
                },
              },
              remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
            },
          },
          { $sort: { demand: -1 } },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 0,
              skill: "$_id",
              demand: 1,
              avgSalary: { $round: ["$avgSalary", 0] },
              remoteCount: 1,
            },
          },
        ],
      },
    },
  ]);

  const totalJobs = facetResult?.totalJobs[0]?.count ?? 0;
  const skills = facetResult?.skills ?? [];

  // ── Velocity: snapshot-based count30 comparison ─────────────────────────────
  // Compares each skill's trailing-30-day count across two snapshot batches
  // instead of using raw job postedAt buckets, which produce inflated percentages
  // when posting activity is uneven within a 30-day window.
  //
  // The snapshot lookups are param-independent, so _loadVelocityContext()
  // coalesces concurrent callers (e.g. /api/warm's 3 parallel calls) into
  // a single DB round-trip.

  // Helper: stamp every skill with safe null-velocity defaults and return.
  const noVelocity = (skillList) =>
    skillList.map((s) => ({ ...s, velocity: null, trend: "flat" }));

  const velocityCtx = await _loadVelocityContext();

  if (!velocityCtx || velocityCtx.tooClose) {
    // No snapshot history, or batches too close for a meaningful signal.
    const result = {
      totalJobs,
      role: role || "all",
      months: Number(months),
      skills: noVelocity(skills),
      velocityReady: false,
      velocityBasisDays: velocityCtx?.gapDays ?? null,
    };
    TRENDING_CACHE.set(cacheKey, result);
    return result;
  }

  const { gapDays, nowMap, baseMap } = velocityCtx;

  // Step 4 — compute velocity for each skill in the trending list.
  const velocityMap = new Map();
  for (const s of skills) {
    const now = nowMap.get(s.skill) ?? 0;
    const base = baseMap.get(s.skill) ?? 0;
    const total = now + base;
    let velocity, trend;
    if (total < 8) {
      velocity = null;
      trend = "flat";
    } else if (base === 0) {
      velocity = null;
      trend = "new";
    } else {
      velocity = Math.round(((now - base) / base) * 100);
      trend = velocity >= 10 ? "up" : velocity <= -10 ? "down" : "flat";
    }
    velocityMap.set(s.skill, { velocity, trend });
  }

  // Step 5 — merge velocity into skills; add envelope fields.
  // Skills absent from the velocity map default to { velocity: null, trend: "flat" }.
  const skillsWithVelocity = skills.map((s) => {
    const v = velocityMap.get(s.skill) ?? { velocity: null, trend: "flat" };
    return { ...s, velocity: v.velocity, trend: v.trend };
  });

  const result = {
    totalJobs,
    role: role || "all",
    months: Number(months),
    skills: skillsWithVelocity,
    velocityReady: true,
    velocityBasisDays: gapDays,
  };
  TRENDING_CACHE.set(cacheKey, result);
  return result;
}
