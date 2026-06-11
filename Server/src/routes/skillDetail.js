import { Router } from "express";
import Job from "../models/Job.js";
import { getSkillPairs } from "../aggregations/skillPairs.js";
import { dedupeGroupStages } from "../lib/dedupe.js";

const router = Router();

// ── In-memory TTL cache for skill detail ───────────────────────────────────
// Key: `${normalizedName}:${months}`. Value: { data, expiresAt }.
// TTL is long (6 h) because the underlying data only changes when
// ingestAdzuna() runs, which calls clearDetailCache() after each successful write.
const DETAIL_CACHE = new Map();
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
    const name = req.params.name;
    const months = Number(req.query.months) || 12;
    const cacheKey = `${name}:${months}`;

    const cached = DETAIL_CACHE.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.data);
    }

    const since = sinceDate(months);
    const baseMatch = { requiredSkills: name, postedAt: { $gte: since } };
    const windowMatch = { postedAt: { $gte: since } };

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
      // demand: deduplicated count of postings that require this skill
      countAgg([{ $match: baseMatch }, ...dedupeGroupStages()]),
      // remoteCount: deduplicated count of remote postings for this skill
      countAgg([
        { $match: { ...baseMatch, isRemote: true } },
        ...dedupeGroupStages(),
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
          "title companyName location isRemote postedAt salaryRange redirectUrl",
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
        salary: j.salaryRange?.midpoint || null,
        currency: j.salaryRange?.currency || null,
        url: j.redirectUrl || null,
      })),
    };

    DETAIL_CACHE.set(cacheKey, { data, expiresAt: Date.now() + DETAIL_TTL_MS });
    res.json(data);
  } catch (err) {
    console.error("GET /api/skill/:name", err);
    next(err);
  }
});

export default router;
