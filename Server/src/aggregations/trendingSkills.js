import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";

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

  // ── Velocity: snapshot-based count30 comparison ─────────────────────────────
  // Compares each skill's trailing-30-day count across two snapshot batches
  // instead of using raw job postedAt buckets, which produce inflated percentages
  // when posting activity is uneven within a 30-day window.

  // Step 1 — find the latest snapshot batch.
  const latestSnap = await SkillSnapshot.findOne()
    .sort({ capturedAt: -1 })
    .select("capturedAt")
    .lean();

  // Helper: stamp every skill with safe null-velocity defaults and return.
  const noVelocity = (skillList) =>
    skillList.map((s) => ({ ...s, velocity: null, trend: "flat" }));

  if (!latestSnap) {
    // No snapshot history recorded yet.
    return {
      totalJobs,
      role: role || "all",
      months: Number(months),
      skills: noVelocity(skills),
      velocityReady: false,
      velocityBasisDays: null,
    };
  }

  const latestCapturedAt = latestSnap.capturedAt;

  // Step 2 — pick a baseline batch.
  // Ideal: the most recent batch that is at least 7 days older than the latest.
  // Fallback: the oldest batch available (used when history is < 7 days old).
  const sevenDaysAgo = new Date(latestCapturedAt);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [idealBase, oldestBase] = await Promise.all([
    SkillSnapshot.findOne({ capturedAt: { $lte: sevenDaysAgo } })
      .sort({ capturedAt: -1 })
      .select("capturedAt")
      .lean(),
    SkillSnapshot.findOne().sort({ capturedAt: 1 }).select("capturedAt").lean(),
  ]);

  const baseSnap = idealBase ?? oldestBase;
  const baselineCapturedAt = baseSnap.capturedAt;
  const gapDays = Math.floor(
    (latestCapturedAt.getTime() - baselineCapturedAt.getTime()) / 86_400_000,
  );

  if (gapDays < 2) {
    // Batches are too close together — not enough elapsed time for a meaningful signal.
    return {
      totalJobs,
      role: role || "all",
      months: Number(months),
      skills: noVelocity(skills),
      velocityReady: false,
      velocityBasisDays: null,
    };
  }

  // Step 3 — load count30 for both batches in parallel (no per-skill DB calls).
  const [nowDocs, baseDocs] = await Promise.all([
    SkillSnapshot.find({ capturedAt: latestCapturedAt })
      .select("skill count30 -_id")
      .lean(),
    SkillSnapshot.find({ capturedAt: baselineCapturedAt })
      .select("skill count30 -_id")
      .lean(),
  ]);

  const nowMap = new Map(nowDocs.map(({ skill, count30 }) => [skill, count30]));
  const baseMap = new Map(
    baseDocs.map(({ skill, count30 }) => [skill, count30]),
  );

  // Step 4 — compute velocity for each skill in the trending list.
  const velocityMap = new Map();
  for (const s of skills) {
    const now = nowMap.get(s.skill) ?? 0;
    const base = baseMap.get(s.skill) ?? 0;
    const total = now + base;
    let velocity, trend;
    if (total < 8) {
      velocity = null;
      trend = "flat";
    } else if (base === 0) {
      velocity = null;
      trend = "new";
    } else {
      velocity = Math.round(((now - base) / base) * 100);
      trend = velocity >= 10 ? "up" : velocity <= -10 ? "down" : "flat";
    }
    velocityMap.set(s.skill, { velocity, trend });
  }

  // Step 5 — merge velocity into skills; add envelope fields.
  // Skills absent from the velocity map default to { velocity: null, trend: "flat" }.
  const skillsWithVelocity = skills.map((s) => {
    const v = velocityMap.get(s.skill) ?? { velocity: null, trend: "flat" };
    return { ...s, velocity: v.velocity, trend: v.trend };
  });

  return {
    totalJobs,
    role: role || "all",
    months: Number(months),
    skills: skillsWithVelocity,
    velocityReady: true,
    velocityBasisDays: gapDays,
  };
}
