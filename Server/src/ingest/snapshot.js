import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { dedupeGroupStages } from "../lib/dedupe.js";

// ── Skill Momentum snapshot writer ───────────────────────────────────────────
// The data moat. On every SUCCESSFUL ingest run we bank one dated row per skill
// so we can later compute rising/falling momentum over time. Everything here is
// wrapped so a failure LOGS A WARNING and NEVER throws out of the ingest run:
// ingestion must stay green even if snapshotting fails.
//
// Idempotent per (skill, date): the write is an upsert keyed on the unique
// { skill, date } index, so re-running ingest on the same day updates the same
// row instead of appending a duplicate.

/** UTC midnight of the given date (day bucket). Pure. */
export function dayBucket(d = new Date()) {
  const bucket = new Date(d);
  bucket.setUTCHours(0, 0, 0, 0);
  return bucket;
}

// Median of a numeric array (linear-interpolated). Returns null for empty input.
// Kept local (not imported from salaryInsights) so this module stays
// self-contained and the salary aggregation is never coupled to ingest.
function median(nums) {
  const sorted = nums
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return lo === hi ? sorted[lo] : (sorted[lo] + sorted[hi]) / 2;
}

/**
 * Record a day-bucketed momentum snapshot for every skill.
 *
 * Metrics per skill (trailing 12-month window, cross-source deduped):
 *   - postingCount:          deduped demand
 *   - disclosedCount:        of those, how many disclosed a salary
 *   - salaryMidpointMedian:  median of DISCLOSED INR midpoints only (null if none)
 *
 * @param {{ date?: Date, months?: number }} [opts]
 * @returns {Promise<{ ok: boolean, skills: number, skipped?: boolean, error?: string }>}
 *   Always resolves; never rejects. `ok:false` signals a caught failure.
 */
export async function recordSkillMomentumSnapshot({ date, months = 12 } = {}) {
  try {
    const bucket = dayBucket(date);
    const since = new Date(bucket);
    since.setMonth(since.getMonth() - Number(months));

    // One pass: dedupe cross-source twins, then per skill collect demand,
    // disclosed count, and the disclosed INR midpoints (for a JS median).
    // Median is computed in JS because Mongo has no first-class median operator
    // that works cleanly with $push + interpolation across versions.
    const rows = await Job.aggregate([
      { $match: { postedAt: { $gte: since } } },
      ...dedupeGroupStages(),
      { $unwind: "$requiredSkills" },
      {
        $group: {
          _id: "$requiredSkills",
          postingCount: { $sum: 1 },
          disclosedCount: {
            $sum: { $cond: [{ $eq: ["$salaryDisclosed", true] }, 1, 0] },
          },
          // Collect ONLY disclosed INR midpoints > 0. Currency-scoped to INR so
          // the median is honest (mixing currencies would be meaningless), and
          // this matches the salary rules used everywhere else in the app.
          inrMidpoints: {
            $push: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$salaryDisclosed", true] },
                    { $eq: ["$salaryRange.currency", "INR"] },
                    { $gt: ["$salaryRange.midpoint", 0] },
                  ],
                },
                "$salaryRange.midpoint",
                "$$REMOVE",
              ],
            },
          },
        },
      },
    ]);

    if (rows.length === 0) {
      console.log("momentum snapshot: no skills to record");
      return { ok: true, skills: 0, skipped: true };
    }

    const ops = rows.map((r) => {
      const salaryMidpointMedian = median(r.inrMidpoints || []);
      return {
        updateOne: {
          // Idempotency key: one row per (skill, day).
          filter: { skill: r._id, date: bucket },
          update: {
            $set: {
              postingCount: r.postingCount,
              disclosedCount: r.disclosedCount,
              salaryMidpointMedian:
                salaryMidpointMedian == null
                  ? null
                  : Math.round(salaryMidpointMedian),
            },
            $setOnInsert: { skill: r._id, date: bucket },
          },
          upsert: true,
        },
      };
    });

    await SkillSnapshot.bulkWrite(ops, { ordered: false });
    console.log(`momentum snapshot: banked ${ops.length} skills for ${bucket.toISOString().slice(0, 10)}`);
    return { ok: true, skills: ops.length };
  } catch (err) {
    // NON-FATAL by contract: log and swallow so ingestion stays green.
    console.warn("momentum snapshot failed:", err?.message);
    return { ok: false, skills: 0, error: err?.message };
  }
}
