import Job from "../models/Job.js";
import { dedupeGroupStages } from "../lib/dedupe.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { resolveSkill, resolveRole } from "../lib/validate.js";

// ── In-memory TTL cache for getTopCompanies ─────────────────────────────────
// Key: `${role||"all"}:${skill||"all"}:${months}:${limit}`. Value: { data, expiresAt }.
// TTL is long (6 h) because data only changes when ingestAdzuna() runs, which
// calls clearCompaniesCache() immediately after each successful write.
const COMPANIES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const COMPANIES_CACHE = createTtlCache({ ttlMs: COMPANIES_TTL_MS, maxEntries: 500 });

/**
 * Clears the companies cache. Called by ingestAdzuna() right after a
 * successful bulkWrite so the next request recomputes from fresh data.
 */
export function clearCompaniesCache() {
  COMPANIES_CACHE.clear();
}

/**
 * Returns the top companies hiring, ranked by number of active job postings.
 *
 * Algorithm
 * ─────────
 * 1. Build a match stage: window by postedAt, optionally filter by
 *    normalizedRole and/or a specific skill in requiredSkills.
 * 2. Group by companyName; compute openings count, remote count, and a
 *    sub-array of all requiredSkills in that company's postings.
 * 3. Exclude blank/null company names.
 * 4. Sort by openings desc, limit to `limit`.
 * 5. Project topSkills: unwind the collected skills sub-array, count each,
 *    sort desc, take top 5.
 *
 * All of this runs as a single $facet-free aggregation pipeline. The topSkills
 * sub-pipeline runs as a $lookup-free $group within the same pipeline using
 * $reduce / $map tricks — but the cleaner approach here is a two-stage
 * aggregation: first collect skill arrays, then compute top-5 in JS (the
 * collection is already limited to `limit` companies before this step).
 *
 * @param {{ role?: string, skill?: string, months?: number, limit?: number }} opts
 * @returns {Promise<Array<{ company, openings, remoteShare, topSkills: Array<{ skill, count }> }>>}
 */
export async function getTopCompanies({
  role,
  skill,
  months = 12,
  limit = 20,
} = {}) {
  const cacheKey = `${role || "all"}:${skill || "all"}:${months}:${limit}`;
  const hit = COMPANIES_CACHE.get(cacheKey);
  if (hit) return hit;

  // Only cache keys built from KNOWN skill/role values. Unknown (arbitrary
  // user-sprayed) values are still computed + returned below, but never
  // written to the cache, so junk keys can't accumulate or evict hot entries.
  // A blank skill/role means "all" (the unfiltered baseline) and is cacheable.
  const cacheable =
    (!skill || resolveSkill(skill) !== null) &&
    (!role || resolveRole(role) !== null);

  // Build the match stage.
  const since = new Date();
  since.setMonth(since.getMonth() - Number(months));

  const match = { postedAt: { $gte: since } };
  if (role) match.normalizedRole = role.toLowerCase();
  if (skill) match.requiredSkills = skill.toLowerCase().trim();

  // Stage 1 — deduplicate twins, then group by companyName.
  const raw = await Job.aggregate([
    { $match: match },
    // Collapse cross-source twins before counting openings.
    ...dedupeGroupStages(),
    {
      $group: {
        _id: "$companyName",
        openings: { $sum: 1 },
        remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
        // Push every skill array so we can flatten + count them.
        skillArrays: { $push: "$requiredSkills" },
      },
    },
    // Exclude blank / null company names.
    { $match: { _id: { $nin: [null, ""] } } },
    { $sort: { openings: -1 } },
    { $limit: Number(limit) },
  ]);

  // Stage 2 — compute topSkills in JS (we're already limited to `limit` docs).
  const companies = raw.map(({ _id, openings, remoteCount, skillArrays }) => {
    // Flatten and count each skill.
    const skillCounts = new Map();
    for (const arr of skillArrays) {
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        if (s) skillCounts.set(s, (skillCounts.get(s) || 0) + 1);
      }
    }
    // Sort by count desc, take top 5.
    const topSkills = [...skillCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s, count]) => ({ skill: s, count }));

    return {
      company: _id,
      openings,
      remoteShare: openings > 0 ? remoteCount / openings : 0,
      topSkills,
    };
  });

  if (cacheable) COMPANIES_CACHE.set(cacheKey, companies);
  return companies;
}
