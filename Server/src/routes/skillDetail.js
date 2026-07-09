import { Router } from "express";
import Job from "../models/Job.js";
import { getSkillPairs } from "../aggregations/skillPairs.js";
import { dedupeGroupStages } from "../lib/dedupe.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { resolveSkill } from "../lib/validate.js";

const router = Router();

// ── In-memory TTL cache for skill detail ───────────────────────────────────
// Key: `${normalizedName}:${months}`. Value: { data, expiresAt }.
// TTL is long (6 h) because the underlying data only changes when
// ingestAdzuna() runs, which calls clearDetailCache() after each successful write.
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DETAIL_CACHE = createTtlCache({ ttlMs: DETAIL_TTL_MS, maxEntries: 500 });

/**
 * Clears the skill-detail cache. Called by ingestAdzuna() right after a
 * successful bulkWrite so re-opening any drawer shows fresh data.
 */
export function clearDetailCache() {
  DETAIL_CACHE.clear();
}

function sinceDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - (Number(months) || 12));
  return d;
}

// Helper: run an aggregate pipeline and extract a single integer count.
async function countAgg(pipeline) {
  const result = await Job.aggregate([...pipeline, { $count: "n" }]);
  return result[0]?.n ?? 0;
}

// GET /api/skill/:name?months=12  → enriched detail for one skill
router.get("/:name", async (req, res, next) => {
  try {
    const name = resolveSkill(req.params.name);
    if (!name) {
      return res.status(400).json({ ok: false, error: "Unknown skill" });
    }
    // Clamp to [1, 24] like every other route so an attacker can't request an
    // arbitrarily large window (and to bound the cache key space). sinceDate
    // below receives this clamped value.
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));
    const cacheKey = `${name}:${months}`;

    const hit = DETAIL_CACHE.get(cacheKey);
    if (hit) {
      return res.json(hit);
    }

    // `name` is already the canonical output of resolveSkill() above, so the
    // cache key can only ever contain a known-taxonomy skill: an unknown skill
    // is rejected with 400 before we reach here and never reaches the cache.

    const since = sinceDate(months);
    // Type guards (P0/P1 audit): a direct Mongo import / bulkWrite that skips
    // Mongoose validation can persist a non-Date postedAt (which throws inside
    // the $dateToString trend stage below) or a non-array requiredSkills (which
    // $unwind silently miscounts). Both fields are constrained at $match —
    // mirroring the guards in ingest/snapshot.js — while preserving the existing
    // `$eq: name` (array-contains) and `$gte: since` semantics.
    const baseMatch = {
      requiredSkills: { $eq: name, $type: "array", $ne: [] },
      postedAt: { $type: "date", $gte: since },
    };
    // windowMatch sizes the share DENOMINATOR (totalJobs). It must mirror the
    // postedAt $type guard from baseMatch so a doc with a valid Date postedAt
    // but a non-array requiredSkills is excluded here too — otherwise it would
    // be dropped from `demand` (by baseMatch) yet still counted in `totalJobs`,
    // deflating `share`. NOTE: requiredSkills uses $type:"array" ONLY (no
    // $ne:[]): a well-formed job that legitimately lists zero skills must still
    // count toward the denominator, preserving the existing share semantics.
    const windowMatch = {
      postedAt: { $type: "date", $gte: since },
      requiredSkills: { $type: "array" },
    };
    // windowBase dedupes the WHOLE window first, then attributes to this skill —
    // matching how the ranking list counts (dedupe-then-attribute), instead of
    // filtering to the skill before dedupe. Filtering first can drop a doc whose
    // deduped representative doesn't list the skill even though a since-merged
    // twin did, or double-count/miss postings depending on which twin survives
    // dedupe — so demand/remoteCount must dedupe over the full window, then
    // $match on requiredSkills against the deduped output.
    const windowBase = {
      postedAt: { $type: "date", $gte: since },
      requiredSkills: { $type: "array", $ne: [] },
    };

    const [
      demand,
      remoteCount,
      totalJobs,
      topCompanies,
      relatedSkills,
      trend,
      recent,
      pairsResult,
    ] = await Promise.all([
      // demand: dedupe the full window, THEN attribute to this skill —
      // coherent with how trendingSkills.js computes demand for the ranking list.
      countAgg([
        { $match: windowBase },
        ...dedupeGroupStages(),
        { $match: { requiredSkills: name } },
      ]),
      // remoteCount: same dedupe-then-attribute order, plus isRemote.
      countAgg([
        { $match: windowBase },
        ...dedupeGroupStages(),
        { $match: { requiredSkills: name, isRemote: true } },
      ]),
      // totalJobs: deduplicated count of ALL postings in the window
      countAgg([{ $match: windowMatch }, ...dedupeGroupStages()]),
      // topCompanies: deduplicated, group by company
      Job.aggregate([
        { $match: baseMatch },
        ...dedupeGroupStages(),
        { $group: { _id: "$companyName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      // relatedSkills: deduplicated co-occurrence
      Job.aggregate([
        { $match: baseMatch },
        ...dedupeGroupStages(),
        { $unwind: "$requiredSkills" },
        { $match: { requiredSkills: { $ne: name } } },
        { $group: { _id: "$requiredSkills", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      // trend: monthly posting counts (deduplicated)
      Job.aggregate([
        { $match: baseMatch },
        ...dedupeGroupStages(),
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$postedAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // recent: raw individual postings — NOT deduplicated intentionally,
      // so users see real listings from both sources.
      Job.find(baseMatch)
        .sort({ postedAt: -1 })
        .limit(5)
        .select(
          "title companyName location isRemote postedAt salaryRange salaryDisclosed redirectUrl",
        )
        .lean(),
      getSkillPairs(name),
    ]);

    const data = {
      ok: true,
      skill: name,
      demand,
      remoteCount,
      remoteShare: demand ? Math.round((remoteCount / demand) * 100) : 0,
      share: totalJobs ? Math.round((demand / totalJobs) * 100) : 0,
      totalJobs,
      topCompanies: topCompanies
        .filter((c) => c._id)
        .map((c) => ({ company: c._id, count: c.count })),
      relatedSkills: relatedSkills
        .filter((s) => s._id)
        .map((s) => ({ skill: s._id, count: s.count })),
      trend: trend.map((t) => ({ month: t._id, count: t.count })),
      pairs: pairsResult.pairs,
      pairsBaseCount: pairsResult.baseCount,
      recent: recent.map((j) => ({
        title: j.title,
        company: j.companyName,
        location: j.location,
        isRemote: j.isRemote,
        postedAt: j.postedAt,
        // Disclosed-only: predicted/estimated salaries are never shown
        // per-listing — null hides the salary chip in the drawer.
        salary: j.salaryDisclosed ? j.salaryRange?.midpoint || null : null,
        currency: j.salaryDisclosed ? j.salaryRange?.currency || null : null,
        url: j.redirectUrl || null,
      })),
    };

    DETAIL_CACHE.set(cacheKey, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
