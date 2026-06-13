import Job from "../models/Job.js";
import { dedupeGroupStages } from "../lib/dedupe.js";
import { createTtlCache } from "../lib/ttlCache.js";

// ── In-memory TTL cache for getSkillPairs ──────────────────────────────────
// Key: `${normalizedSkill}:${limit}`. Value: { data, expiresAt }.
// TTL is long (6 h) because pair co-occurrence data only changes when
// ingestAdzuna() runs, which calls clearPairsCache() after each successful write.
const PAIRS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PAIRS_CACHE = createTtlCache({ ttlMs: PAIRS_TTL_MS, maxEntries: 500 });

/**
 * Clears the pairs cache. Called by ingestAdzuna() right after a successful
 * bulkWrite so the next drawer open recomputes from fresh data.
 */
export function clearPairsCache() {
  PAIRS_CACHE.clear();
}

/**
 * For a given skill, find which other skills most often appear in the same
 * job postings and what percentage of those postings include each partner.
 *
 * Window-independent: counts across ALL jobs so the percentages are stable
 * and comparable regardless of the time window selected in the UI.
 *
 * Results are cached in-process for 6 hours (TTL). The cache invalidates
 * naturally — no manual busting required.
 *
 * @param {string} skill  - the skill to look up (casing is normalised internally)
 * @param {{ limit?: number }} [opts]
 * @returns {{ skill: string, baseCount: number, pairs: Array<{ skill: string, count: number, percentage: number }> }}
 */
export async function getSkillPairs(skill, { limit = 8 } = {}) {
  const normalized = skill.toLowerCase().trim();
  const cacheKey = `${normalized}:${limit}`;

  const hit = PAIRS_CACHE.get(cacheKey);
  if (hit) return hit;

  // Deduplicated baseCount: aggregate rather than countDocuments so we can
  // prepend the dedupe stages. This ensures the denominator matches the counts
  // computed in the pairs pipeline below.
  const baseCountResult = await Job.aggregate([
    { $match: { requiredSkills: normalized } },
    ...dedupeGroupStages(),
    { $count: "n" },
  ]);
  const baseCount = baseCountResult[0]?.n ?? 0;

  if (baseCount === 0) {
    const result = { skill: normalized, baseCount: 0, pairs: [] };
    PAIRS_CACHE.set(cacheKey, result);
    return result;
  }

  // Deduplicated pairs: match → dedupe → unwind → exclude self → group → sort → limit.
  const raw = await Job.aggregate([
    { $match: { requiredSkills: normalized } },
    ...dedupeGroupStages(),
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
  PAIRS_CACHE.set(cacheKey, result);
  return result;
}
