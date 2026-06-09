import Job from "../models/Job.js";

/**
 * For a given skill, find which other skills most often appear in the same
 * job postings and what percentage of those postings include each partner.
 *
 * Window-independent: counts across ALL jobs so the percentages are stable
 * and comparable regardless of the time window selected in the UI.
 *
 * @param {string} skill  - the skill to look up (casing is normalised internally)
 * @param {{ limit?: number }} [opts]
 * @returns {{ skill: string, baseCount: number, pairs: Array<{ skill: string, count: number, percentage: number }> }}
 */
export async function getSkillPairs(skill, { limit = 8 } = {}) {
  const normalized = skill.toLowerCase().trim();

  // One count to establish the denominator for percentages.
  const baseCount = await Job.countDocuments({ requiredSkills: normalized });

  if (baseCount === 0) {
    return { skill: normalized, baseCount: 0, pairs: [] };
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

  return { skill: normalized, baseCount, pairs };
}
