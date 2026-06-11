import { extractSkills } from "./skills.js";

/**
 * Compute the gap between a résumé's skills and the current demand list.
 *
 * Pure function — no DB calls. Caller is responsible for providing a
 * pre-fetched, demand-sorted `demand` array.
 *
 * @param {{ resumeText: string, demand: Array<{ skill: string, count: number }> }} opts
 * @returns {{
 *   resumeSkills: string[],
 *   matched: Array<{ skill: string, count: number }>,
 *   missing: Array<{ skill: string, count: number }>,
 *   matchScore: number,
 *   totalConsidered: number
 * }}
 */
export function computeResumeGap({ resumeText, demand }) {
	const resumeSkills = extractSkills(resumeText);
	const resumeSet = new Set(resumeSkills);

	const matched = [];
	const missing = [];

	// demand is already sorted by count desc — preserve that order in both slices.
	for (const item of demand) {
		if (resumeSet.has(item.skill)) {
			matched.push(item);
		} else {
			missing.push(item);
		}
	}

	const matchScore =
		demand.length === 0
			? 0
			: Math.round((matched.length / demand.length) * 100);

	return {
		resumeSkills,
		matched,
		missing,
		matchScore,
		totalConsidered: demand.length,
	};
}
