import { Router } from "express";
import Job from "../models/Job.js";
import { getSkillPairs } from "../aggregations/skillPairs.js";

const router = Router();

// ── In-memory TTL cache for skill detail ───────────────────────────────────
// Key: `${normalizedName}:${months}`. Value: { data, expiresAt }.
// Safe because the underlying job data only changes on the 8h ingest cron.
const DETAIL_CACHE = new Map();
const DETAIL_TTL_MS = 10 * 60 * 1000; // 10 minutes

function sinceDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - (Number(months) || 12));
  return d;
}

// GET /api/skill/:name?months=12  → enriched detail for one skill
router.get("/:name", async (req, res) => {
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
      Job.countDocuments(baseMatch),
      Job.countDocuments({ ...baseMatch, isRemote: true }),
      Job.countDocuments({ postedAt: { $gte: since } }),
      Job.aggregate([
        { $match: baseMatch },
        { $group: { _id: "$companyName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      Job.aggregate([
        { $match: baseMatch },
        { $unwind: "$requiredSkills" },
        { $match: { requiredSkills: { $ne: name } } },
        { $group: { _id: "$requiredSkills", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      Job.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$postedAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;

