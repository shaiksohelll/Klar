import Job from "../models/Job.js";

// ── In-memory TTL cache for getSkillPairs ──────────────────────────────────
// Key: `${normalizedSkill}:${limit}`. Value: { data, expiresAt }.
// Safe because pair co-occurrence data only changes on the 8h ingest cron.
const PAIRS_CACHE = new Map();
const PAIRS_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * For a given skill, find which other skills most often appear in the same
 * job postings and what percentage of those postings include each partner.
 *
 * Window-independent: counts across ALL jobs so the percentages are stable
 * and comparable regardless of the time window selected in the UI.
 *
 * Results are cached in-process for 10 minutes (TTL). The cache invalidates
 * naturally — no manual busting required.
 *
 * @param {string} skill  - the skill to look up (casing is normalised internally)
 * @param {{ limit?: number }} [opts]
 * @returns {{ skill: string, baseCount: number, pairs: Array<{ skill: string, count: number, percentage: number }> }}
 */
export async function getSkillPairs(skill, { limit = 8 } = {}) {
  const normalized = skill.toLowerCase().trim();
  const cacheKey = `${normalized}:${limit}`;

  const cached = PAIRS_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  // One count to establish the denominator for percentages.
  const baseCount = await Job.countDocuments({ requiredSkills: normalized });

  if (baseCount === 0) {
    const result = { skill: normalized, baseCount: 0, pairs: [] };
    PAIRS_CACHE.set(cacheKey, { data: result, expiresAt: Date.now() + PAIRS_TTL_MS });
    return result;
  }

  // One aggregation: match → unwind → exclude self → group → sort → limit.
  const raw = await Job.aggregate([
    { $match: { requiredSkills: normalized } },
    { $unwind: "$requiredSkills" },
    { $match: { requiredSkills: { $ne: normalized } } },
    { $group: { _id: "$requiredSkills", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: Number(limit) },
  ]);

  const pairs = raw.map(({ _id, count }) => ({
    skill: _id,
    count,
    percentage: Math.round((count / baseCount) * 100),
  }));

  const result = { skill: normalized, baseCount, pairs };
  PAIRS_CACHE.set(cacheKey, { data: result, expiresAt: Date.now() + PAIRS_TTL_MS });
  return result;
}
