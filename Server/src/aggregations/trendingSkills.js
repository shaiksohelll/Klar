import Job from "../models/Job.js"

export async function getTrendingSkills({ role, months = 12, limit = 25 }) {
	// Only look at jobs posted within the last N months
	const since = new Date()
	since.setMonth(since.getMonth() - Number(months))

	const match = { postedAt: { $gte: since } }
	if (role) match.normalizedRole = role // e.g. "backend", "frontend"

	const pipeline = [
		{ $match: match }, // 1. filter to relevant jobs
		{ $unwind: "$requiredSkills" }, // 2. split skills array → one row per skill
		{
			$group: {
				// 3. group identical skills together and tally them
				_id: "$requiredSkills",
				demand: { $sum: 1 }, // how many postings mention this skill
				avgSalary: { $avg: "$salaryRange.midpoint" },
				remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
			},
		},
		{ $sort: { demand: -1 } }, // 4. most in-demand first
		{ $limit: Number(limit) }, // 5. top N
		{
			$project: {
				// 6. clean up the output shape
				_id: 0,
				skill: "$_id",
				demand: 1,
				avgSalary: { $round: ["$avgSalary", 0] },
				remoteCount: 1,
			},
		},
	]

	const totalJobs = await Job.countDocuments(match)
	const skills = await Job.aggregate(pipeline)
	return { totalJobs, role: role || "all", months: Number(months), skills }
}