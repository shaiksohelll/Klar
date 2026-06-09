import Job from "../models/Job.js";

export async function getTrendingSkills({ role, months = 12, limit = 25 }) {
  // Only look at jobs posted within the last N months
  const since = new Date();
  since.setMonth(since.getMonth() - Number(months));

  const match = { postedAt: { $gte: since } };
  if (role) match.normalizedRole = role; // e.g. "backend", "frontend"

  // Single round-trip: $facet runs totalJobs count and the skills aggregation
  // together so MongoDB only scans the collection once.
  const [facetResult] = await Job.aggregate([
    { $match: match },
    {
      $facet: {
        // Branch A: just count the matched documents
        totalJobs: [{ $count: "count" }],
        // Branch B: unwind → group → sort → limit → project
        skills: [
          { $unwind: "$requiredSkills" },
          {
            $group: {
              _id: "$requiredSkills",
              demand: { $sum: 1 },
              avgSalary: { $avg: "$salaryRange.midpoint" },
              remoteCount: { $sum: { $cond: ["$isRemote", 1, 0] } },
            },
          },
          { $sort: { demand: -1 } },
          { $limit: Number(limit) },
          {
            $project: {
              _id: 0,
              skill: "$_id",
              demand: 1,
              avgSalary: { $round: ["$avgSalary", 0] },
              remoteCount: 1,
            },
          },
        ],
      },
    },
  ]);

  const totalJobs = facetResult?.totalJobs[0]?.count ?? 0;
  const skills = facetResult?.skills ?? [];
  return { totalJobs, role: role || "all", months: Number(months), skills };
}
