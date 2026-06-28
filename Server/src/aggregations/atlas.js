import Job from "../models/Job.js";
import { dedupeGroupStages } from "../lib/dedupe.js";
import { createTtlCache } from "../lib/ttlCache.js";

// ── In-memory TTL cache for getAtlas ────────────────────────────────────────
// Key: `${role||"all"}:${skill||"all"}:${months}`. Value: the full result obj.
// TTL is long (6 h) because data only changes when an ingest runs, which calls
// clearAtlasCache() immediately after each successful write.
const ATLAS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ATLAS_CACHE = createTtlCache({ ttlMs: ATLAS_TTL_MS, maxEntries: 500 });

/**
 * Clears the atlas cache. Called by both ingesters right after a successful
 * bulkWrite so the next request recomputes from fresh data.
 */
export function clearAtlasCache() {
  ATLAS_CACHE.clear();
}

/**
 * Build the public Opportunity Map: per-VERIFIED-city job demand, disclosed
 * average salary, and 30-day momentum (velocity), ranked by demand.
 *
 * Only postings that resolved to a verified GeoNames place
 * (geo.geonameId != null) are included. avgSalary is computed per city and a
 * city maps to exactly one country, so the figure is single-currency and safe
 * to display directly.
 *
 * velocity = ((count30 - countPrev) / countPrev) * 100, rounded, where
 *   count30   = postings in the trailing 30 days, and
 *   countPrev = postings in the 30 days BEFORE that (days 30-60).
 * velocity is null when countPrev is 0 (no baseline to compare against).
 *
 * @param {{ role?: string, skill?: string, months?: number }} opts
 * @returns {Promise<{ cities: object[], totalCities: number, totalJobs: number }>}
 */
export async function getAtlas({ role, skill, months = 12, remote, disclosed } = {}) {
  // Cache key MUST include role + skill + months + facet filters.
  const cacheKey = `${role || "all"}:${skill || "all"}:${months}:${remote || "any"}:${disclosed ? "yes" : "no"}`;
  const hit = ATLAS_CACHE.get(cacheKey);
  if (hit) return hit;

  const since = new Date();
  since.setMonth(since.getMonth() - Number(months));
  const since30 = new Date();
  since30.setDate(since30.getDate() - 30);
  const sincePrev = new Date();
  sincePrev.setDate(sincePrev.getDate() - 60);

  const match = { postedAt: { $gte: since }, "geo.geonameId": { $ne: null } };
  if (role) match.normalizedRole = role;
  if (skill) match.requiredSkills = skill;
  if (remote === "remote") match.isRemote = true;
  else if (remote === "onsite") match.isRemote = false;
  if (disclosed) match.salaryDisclosed = true;

  const pipeline = [
    { $match: match },
    // Collapse cross-source twins before counting (preserves geo via $first).
    ...dedupeGroupStages(),
    {
      $group: {
        _id: "$geo.geonameId",
        city: { $first: "$geo.city" },
        admin1: { $first: "$geo.admin1" },
        country: { $first: "$geo.country" },
        lat: { $first: "$geo.lat" },
        lng: { $first: "$geo.lng" },
        count: { $sum: 1 },
        remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
        count30: { $sum: { $cond: [{ $gte: ["$postedAt", since30] }, 1, 0] } },
        countPrev: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ["$postedAt", sincePrev] },
                  { $lt: ["$postedAt", since30] },
                ],
              },
              1,
              0,
            ],
          },
        },
        avgSalary: {
          $avg: {
            $cond: [
              { $eq: ["$salaryDisclosed", true] },
              "$salaryRange.midpoint",
              null,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        geonameId: "$_id",
        city: 1,
        admin1: 1,
        country: 1,
        lat: 1,
        lng: 1,
        count: 1,
        remoteCount: 1,
        avgSalary: { $round: ["$avgSalary", 0] },
        velocity: {
          $cond: [
            { $gt: ["$countPrev", 0] },
            {
              $round: [
                {
                  $multiply: [
                    {
                      $divide: [
                        { $subtract: ["$count30", "$countPrev"] },
                        "$countPrev",
                      ],
                    },
                    100,
                  ],
                },
                0,
              ],
            },
            null,
          ],
        },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 500 },
  ];

  const cities = await Job.aggregate(pipeline);
  const result = {
    cities,
    totalCities: cities.length,
    totalJobs: cities.reduce((a, c) => a + c.count, 0),
  };
  ATLAS_CACHE.set(cacheKey, result);
  return result;
}
