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

  // ── Velocity: last 30 days vs the prior 30 days ─────────────────────────────
  // Always compares the two most recent 30-day buckets, independent of the
  // role filter and the months window the caller selected. One aggregation
  // builds a Map so the merge below is O(n) with no per-skill DB calls.
  const now = new Date();
  const since30 = new Date(now);
  since30.setDate(now.getDate() - 30);
  const since60 = new Date(now);
  since60.setDate(now.getDate() - 60);

  const velocityRaw = await Job.aggregate([
    { $match: { postedAt: { $gte: since60 } } },
    { $unwind: "$requiredSkills" },
    {
      $group: {
        _id: "$requiredSkills",
        recent: {
          $sum: { $cond: [{ $gte: ["$postedAt", since30] }, 1, 0] },
        },
        previous: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ["$postedAt", since60] },
                  { $lt: ["$postedAt", since30] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const velocityMap = new Map();
  for (const { _id, recent, previous } of velocityRaw) {
    const total = recent + previous;
    let velocity, trend;
    if (total < 8) {
      // Sample too small — avoid noisy signals from barely-seen skills.
      velocity = null;
      trend = "flat";
    } else if (previous === 0) {
      // Skill only appeared in the most recent 30 days.
      velocity = null;
      trend = "new";
    } else {
      velocity = Math.round(((recent - previous) / previous) * 100);
      trend = velocity >= 10 ? "up" : velocity <= -10 ? "down" : "flat";
    }
    velocityMap.set(_id, { velocity, trend });
  }

  // Merge velocity into the skills list. Skills absent from the map (no jobs
  // in the 60-day window) get a safe default: null velocity, flat trend.
  const skillsWithVelocity = skills.map((s) => {
    const v = velocityMap.get(s.skill) ?? { velocity: null, trend: "flat" };
    return { ...s, velocity: v.velocity, trend: v.trend };
  });

  return {
    totalJobs,
    role: role || "all",
    months: Number(months),
    skills: skillsWithVelocity,
  };
}
