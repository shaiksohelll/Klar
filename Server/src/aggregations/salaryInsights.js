import Job from "../models/Job.js";
import { dedupeGroupStages } from "../lib/dedupe.js";

// ── In-memory TTL cache for getSalaryInsights ────────────────────────────────
// Key: `${skill||"all"}:${role||"all"}:${months}`. Value: { data, expiresAt }.
// 6h TTL — data only changes when an ingest cron runs, which calls
// clearSalaryCache() immediately afterwards.
const SALARY_CACHE = new Map();
const SALARY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Clears the salary cache. Called by ingestAdzuna() and ingestJSearch()
 * after a successful bulkWrite.
 */
export function clearSalaryCache() {
  SALARY_CACHE.clear();
}

// ── Median / percentile helpers (pure JS, no extra deps) ────────────────────
// Used when the aggregated midpoint list is pulled into JS for stats.

function sortedNums(arr) {
  return [...arr].filter((n) => typeof n === "number" && isFinite(n)).sort((a, b) => a - b);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

function median(sorted) {
  return percentile(sorted, 50);
}

/**
 * Returns salary insight stats for a given skill / role / time window.
 * Only postings where salaryDisclosed === true are counted in the stats.
 * Postings are first deduplicated via dedupeGroupStages() so cross-source
 * twins are counted once.
 *
 * Shape:
 * {
 *   totalCount:      number,   // deduped postings in scope
 *   disclosedCount:  number,   // of those, how many have salaryDisclosed
 *   disclosureRate:  number,   // disclosedCount / totalCount (0 if total 0)
 *   byCurrency: [{
 *     currency, count,
 *     median, p25, p75, min, max   // all in that currency unit
 *   }],  // sorted by count desc
 *   primary: byCurrency[0] || null
 * }
 *
 * @param {{ skill?: string, role?: string, months?: number }} opts
 */
export async function getSalaryInsights({ skill, role, months = 12 } = {}) {
  const cacheKey = `${skill || "all"}:${role || "all"}:${months}`;
  const cached = SALARY_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const since = new Date();
  since.setMonth(since.getMonth() - Number(months));

  // Build the pre-dedupe match.
  const match = { postedAt: { $gte: since } };
  if (role) match.normalizedRole = role.toLowerCase();
  if (skill) match.requiredSkills = skill.toLowerCase().trim();

  // ── Stage 1: deduplicate, then split into total count + disclosed docs ──
  // We run a single aggregate:
  //   $match  →  dedupeGroupStages  →  $facet(totalCount, disclosed midpoints)
  //
  // After dedupeGroupStages the document shape is the one projected by the
  // $group stage in dedupeGroupStages() — fields: companyName, isRemote,
  // requiredSkills, salaryRange, salaryDisclosed, postedAt, ...
  //
  // NOTE: dedupeGroupStages() uses $first for every field, so salaryDisclosed
  // and salaryRange are inherited from the "winner" document (newest postedAt).

  const [facetResult] = await Job.aggregate([
    { $match: match },
    ...dedupeGroupStages(),
    {
      $facet: {
        // Branch A — total deduped count
        total: [{ $count: "n" }],
        // Branch B — disclosed salary midpoints per currency
        disclosed: [
          {
            $match: {
              salaryDisclosed: true,
              "salaryRange.midpoint": { $gt: 0 },
            },
          },
          {
            $group: {
              _id: { $ifNull: ["$salaryRange.currency", "UNKNOWN"] },
              midpoints: { $push: "$salaryRange.midpoint" },
            },
          },
        ],
      },
    },
  ]);

  const totalCount = facetResult?.total[0]?.n ?? 0;
  const disclosedGroups = facetResult?.disclosed ?? [];

  // ── Stage 2: compute stats per currency in JS ───────────────────────────
  // Midpoint arrays are already pulled; no extra DB round-trips.
  const byCurrency = disclosedGroups
    .map(({ _id: currency, midpoints }) => {
      const sorted = sortedNums(midpoints);
      return {
        currency,
        count: sorted.length,
        median: Math.round(median(sorted) ?? 0),
        p25: Math.round(percentile(sorted, 25) ?? 0),
        p75: Math.round(percentile(sorted, 75) ?? 0),
        min: sorted[0] ?? null,
        max: sorted[sorted.length - 1] ?? null,
      };
    })
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count);

  const disclosedCount = byCurrency.reduce((s, g) => s + g.count, 0);

  const data = {
    totalCount,
    disclosedCount,
    disclosureRate: totalCount > 0 ? disclosedCount / totalCount : 0,
    byCurrency,
    primary: byCurrency[0] ?? null,
  };

  SALARY_CACHE.set(cacheKey, { data, expiresAt: Date.now() + SALARY_TTL_MS });
  return data;
}
