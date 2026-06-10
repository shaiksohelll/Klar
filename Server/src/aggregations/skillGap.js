import { getSkillPairs } from "./skillPairs.js";
import { getAllSkills } from "./trendingSkills.js";

/**
 * For a user's watchlist, find skills that co-occur most often with tracked
 * skills in real postings but that the user does NOT already track.
 *
 * Algorithm
 * ─────────
 * 1. For each watched skill, call getSkillPairs() (limit 12) to get its
 *    co-occurring partners.
 * 2. getAllSkills() is fetched IN PARALLEL with the pair queries (single
 *    Promise.all) so no work is sequential.
 * 3. Across all watched skills, accumulate per-candidate:
 *      • totalPairCount — sum of raw co-occurrence counts
 *      • pairedWith     — which watched skills it appears alongside
 *    Skip any candidate already in watchedSkills (set lookup, O(1)).
 * 4. Build a demand + remoteShare lookup Map from the allSkills result.
 * 5. Sort candidates: totalPairCount desc, tiebreak demand desc.
 * 6. Return top `limit` items shaped as:
 *      { skill, demand, remoteShare, pairCount, pairedWith: [...] }
 *
 * Both getSkillPairs and getAllSkills are cached in-process (10-min TTL)
 * so after the first request results are served from memory.
 *
 * @param {string[]} watchedSkills - raw lowercase skill keys
 * @param {{ limit?: number, months?: number }} opts
 */
export async function getSkillGap(watchedSkills, { limit = 6, months = 12 } = {}) {
  if (!watchedSkills || watchedSkills.length === 0) return [];

  const watchedSet = new Set(watchedSkills.map((s) => s.toLowerCase().trim()));

  // Steps 1 + 2 — all DB work in parallel: pair queries AND the demand list.
  const [pairResults, allSkills] = await Promise.all([
    Promise.all([...watchedSet].map((skill) => getSkillPairs(skill, { limit: 12 }))),
    getAllSkills({ months }),
  ]);

  // Step 3 — candidate accumulation.
  const candidates = new Map();

  for (const result of pairResults) {
    const source = result.skill; // the watched skill we queried
    for (const { skill: candidate, count } of result.pairs) {
      // Exclude anything the user already tracks.
      if (watchedSet.has(candidate)) continue;

      if (!candidates.has(candidate)) {
        candidates.set(candidate, { totalPairCount: 0, pairedWith: new Set() });
      }
      const entry = candidates.get(candidate);
      entry.totalPairCount += count;
      entry.pairedWith.add(source);
    }
  }

  if (candidates.size === 0) return [];

  // Step 4 — demand lookup Map (already fetched, no extra DB call).
  const demandMap = new Map(
    allSkills.map((s) => [s.skill, { demand: s.demand, remoteShare: s.remoteShare }]),
  );

  // Step 5 — sort: totalPairCount desc, then demand desc.
  const sorted = [...candidates.entries()]
    .map(([skill, { totalPairCount, pairedWith }]) => {
      const dm = demandMap.get(skill) ?? { demand: 0, remoteShare: 0 };
      return {
        skill,
        demand: dm.demand,
        remoteShare: dm.remoteShare,
        pairCount: totalPairCount,
        pairedWith: [...pairedWith],
      };
    })
    .sort((a, b) => {
      if (b.pairCount !== a.pairCount) return b.pairCount - a.pairCount;
      return b.demand - a.demand;
    });

  // Step 6 — return top limit.
  return sorted.slice(0, limit);
}
