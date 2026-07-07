import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { dedupeGroupStages } from "../lib/dedupe.js";

// ── Skill Momentum snapshot writer ─────────────────────────────────────────
// LEGACY / UNWIRED. This trailing-12-month cumulative writer is NO LONGER wired
// into any ingest path (see ingest/adzuna.js + ingest/jsearch.js, which call
// recordDailySkillBuckets ONLY). It banked one dated row per skill keyed on the
// unique { skill, date } index — the SAME key the day-bucketed daily-flow writer
// below uses. If both ran over the same day the last writer would win and the
// day-bucketed series would be corrupted with a cumulative value. It is kept
// here only for the momentum-era regression tests; do NOT re-wire it into ingest
// without introducing a distinct key (see the MR "future option" note about a
// `kind` discriminator / separate collection). Everything here is wrapped so a
// failure LOGS A WARNING and NEVER throws out of the caller.

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
 * LEGACY / UNWIRED (see the module header): this still writes day-keyed
 * { skill, date } rows, so it MUST NOT be called from ingest alongside
 * recordDailySkillBuckets — the two would collide on the shared unique key and
 * the last writer would corrupt the day-bucketed series. It survives only for
 * the momentum-era regression suite.
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

// ── Day-bucketed DAILY-FLOW skill writer ───────────────────────────────────
// A SECOND, independent snapshot writer that banks one row per (skill, UTC day)
// where `postingCount` is the DAILY FLOW: the number of jobs whose `postedAt`
// falls on that UTC day and whose `requiredSkills` includes the skill. This is
// NEW postings that day, NOT a cumulative/trailing window.
//
// This is the ONLY writer wired into ingest. recordSkillMomentumSnapshot() above
// is legacy/unwired; both key on { skill, date } but only ONE may ever run over
// a given day or they collide. See the MR description for the semantic split.
//
// Idempotent per (skill, date): the write is an upsert keyed on the unique
// { skill, date } index, so re-running on the same day updates the same row
// instead of appending a duplicate. Recomputing the last 2 UTC days each run
// lets partial-day ingests self-heal (today's count grows as more postings for
// today arrive across the day's ingest runs).
//
// Zero-flow correctness: after upserting the fresh set we DELETE any day-keyed
// row inside the recompute window that is NOT in the fresh set, so a skill that
// drops to zero postings on a recomputed day leaves NO stale positive row for
// forecast/momentum to read. Upsert-first-then-delete keeps reads gap-free.
//
// Non-fatal by contract: any failure LOGS A WARNING and NEVER throws out of the
// ingest run — ingestion must stay green even if snapshotting fails.

/**
 * Validate a single day-bucket op payload before it is written.
 * Returns true only for a non-empty skill, a valid Date, and an integer
 * postingCount >= 0. Guards against wrong-shaped rows since bulkWrite bypasses
 * Mongoose validators.
 */
export function isValidDailyBucket({ skill, date, postingCount } = {}) {
  if (typeof skill !== "string" || skill.trim() === "") return false;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  if (!Number.isInteger(postingCount) || postingCount < 0) return false;
  return true;
}

/**
 * Record day-bucketed DAILY-FLOW postingCount rows.
 *
 * By default recomputes the last 2 UTC days (yesterday + today) so partial-day
 * ingests self-heal. Pass `lookbackDays` to widen the recomputed window (the
 * backfill passes the full history range via `since`).
 *
 * @param {{ now?: Date, since?: Date, lookbackDays?: number }} [opts]
 *   - now: "current" time (defaults to new Date()); the recompute window ends here.
 *   - since: explicit lower bound for postedAt (overrides lookbackDays).
 *   - lookbackDays: how many whole UTC days back to recompute (default 1 => the
 *     last 2 UTC days: yesterday's midnight through now).
 * @returns {Promise<{ ok: boolean, buckets: number, deleted?: number, skipped?: boolean, error?: string }>}
 *   Always resolves; never rejects. `ok:false` signals a caught failure. On a
 *   BulkWriteError (e.g. a concurrent duplicate key) the PARTIAL success count
 *   is surfaced with ok:true rather than reported as a total failure.
 */
export async function recordDailySkillBuckets({
  now = new Date(),
  since,
  lookbackDays = 1,
} = {}) {
  try {
    // Lower bound on postedAt. Default: UTC midnight `lookbackDays` days ago, so
    // the default (1) recomputes yesterday + today.
    const lowerBound =
      since instanceof Date
        ? since
        : new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate() - Number(lookbackDays),
            ),
          );

    const buckets = await Job.aggregate([
      {
        $match: {
          // Strict type guards so $dateTrunc / $unwind can never throw and flip
          // the writer to ok:false on a malformed doc. The $lte: now upper bound
          // prevents a bad feed with future-dated postedAt from leaking into buckets.
          postedAt: { $type: "date", $gte: lowerBound, $lte: now },
          requiredSkills: { $type: "array", $ne: [] },
        },
      },
      { $unwind: "$requiredSkills" },
      {
        $group: {
          _id: {
            skill: "$requiredSkills",
            day: { $dateTrunc: { date: "$postedAt", unit: "day", timezone: "UTC" } },
          },
          postingCount: { $sum: 1 },
        },
      },
    ]);

    // Shape-guard every row before writing. bulkWrite skips Mongoose validators,
    // so a wrong-shaped row would otherwise slip through — reject in code.
    // Track the fresh (skill, date) keys so we can prune stale rows afterwards.
    const ops = [];
    const freshKeys = new Set();
    let skipped = 0;
    for (const b of buckets) {
      const skill = b?._id?.skill;
      const date = b?._id?.day;
      const postingCount = b?.postingCount;
      if (!isValidDailyBucket({ skill, date, postingCount })) {
        skipped++;
        continue;
      }
      freshKeys.add(`${skill}\u0000${date.getTime()}`);
      ops.push({
        updateOne: {
          filter: { skill, date },
          update: {
            // A pure daily-flow row carries ONLY postingCount. Unset the
            // momentum/legacy-only fields so a row previously written by the
            // momentum writer can never linger with mixed semantics.
            $set: { postingCount },
            $unset: {
              disclosedCount: "",
              salaryMidpointMedian: "",
              count: "",
              count30: "",
              capturedAt: "",
            },
            $setOnInsert: { skill, date },
          },
          upsert: true,
        },
      });
    }

    if (skipped > 0) {
      console.warn(`daily buckets: skipped ${skipped} invalid row(s)`);
    }

    // Upsert fresh FIRST so reads never see a gap, then prune stale rows.
    let written = 0;
    if (ops.length > 0) {
      try {
        const result = await SkillSnapshot.bulkWrite(ops, { ordered: false });
        // Partial-success accounting: a duplicate-key (E11000) under
        // ordered:false still applies the other ops; count what actually landed.
        written = (result.upsertedCount || 0) + (result.modifiedCount || 0);
      } catch (err) {
        // BulkWriteError still carries a partial result. Surface the ops that
        // succeeded instead of reporting a total failure, so concurrent
        // ingest/backfill doesn't look like it wrote nothing.
        const partial = err?.result;
        if (partial) {
          const up = partial.upsertedCount ?? partial.nUpserted ?? 0;
          const mod = partial.modifiedCount ?? partial.nModified ?? 0;
          written = up + mod;
          console.warn(
            `daily buckets: partial bulkWrite (${written} applied) — ${err?.message}`,
          );
        } else {
          throw err; // not a BulkWriteError — let the outer catch handle it.
        }
      }
    }

    // ── Prune zero-flow day rows ────────────────────────────────────────
    // Any day-keyed row inside the recompute window [lowerBound, now] that is
    // NOT in the fresh set is stale (its skill dropped to zero postings that
    // day). Delete it so forecast/momentum never read a stale positive count.
    // Scoped strictly to rows that HAVE a `date` in the window — legacy
    // capturedAt-only rows (no `date`) are never touched by the partial filter.
    let deleted = 0;
    const inWindow = await SkillSnapshot.find({
      date: { $type: "date", $gte: lowerBound, $lte: now },
    })
      .select("skill date -_id")
      .lean();
    const staleKeys = [];
    for (const r of inWindow) {
      const key = `${r.skill}\u0000${r.date.getTime()}`;
      if (!freshKeys.has(key)) {
        staleKeys.push({ skill: r.skill, date: r.date });
      }
    }
    // Delete in batches of 500 keys to stay clear of MongoDB BSON/query limits
    // when backfill mode produces a large staleKeys set. Idempotent: each batch
    // is independently safe and a re-run deletes nothing extra.
    if (staleKeys.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < staleKeys.length; i += BATCH) {
        const batch = staleKeys.slice(i, i + BATCH);
        const delResult = await SkillSnapshot.deleteMany({
          date: { $type: "date", $gte: lowerBound, $lte: now },
          $or: batch,
        });
        deleted += delResult.deletedCount || 0;
      }
    }

    if (ops.length === 0 && deleted === 0) {
      console.log("daily buckets: nothing to record");
      return { ok: true, buckets: 0, deleted: 0, skipped: skipped > 0 };
    }

    console.log(
      `daily buckets: banked ${written}/${ops.length} (skill, day) rows, pruned ${deleted} stale since ${lowerBound.toISOString().slice(0, 10)}`,
    );
    return { ok: true, buckets: written, deleted };
  } catch (err) {
    // NON-FATAL by contract: log and swallow so ingestion stays green.
    console.warn("daily buckets failed:", err?.message);
    return { ok: false, buckets: 0, error: err?.message };
  }
}

/**
 * One-time, idempotent BACKFILL of day-bucketed daily-flow rows across ALL jobs.
 *
 * Aggregates every job (skipping empty requiredSkills / null postedAt), groups
 * by (skill, UTC day of postedAt), counts, and upserts every (skill, date) with
 * the SAME upsert + shape-guard + zero-flow prune as recordDailySkillBuckets.
 * Because it recomputes the FULL history in one pass, its prune removes any
 * day-keyed row whose (skill, date) is not in the fresh full set. Fully
 * idempotent. Logs buckets written, the date range, and distinct skill count.
 *
 * Implemented by calling recordDailySkillBuckets with `since` at the Unix epoch
 * so the recompute window spans the entire postedAt history.
 *
 * @returns {Promise<{ ok: boolean, buckets: number, deleted: number,
 *   minDate: string|null, maxDate: string|null, distinctSkills: number,
 *   error?: string }>}
 */
export async function backfillDailySkillBuckets() {
  try {
    // Epoch lower bound => the full history is recomputed in one pass, and the
    // prune inside recordDailySkillBuckets is scoped to the entire day-keyed set.
    const res = await recordDailySkillBuckets({ since: new Date(0) });
    if (!res.ok) {
      return {
        ok: false,
        buckets: 0,
        deleted: 0,
        minDate: null,
        maxDate: null,
        distinctSkills: 0,
        error: res.error,
      };
    }

    // Report the written range + distinct skills for observability.
    const [range] = await SkillSnapshot.aggregate([
      { $match: { date: { $type: "date" } } },
      {
        $group: {
          _id: null,
          minDate: { $min: "$date" },
          maxDate: { $max: "$date" },
          skills: { $addToSet: "$skill" },
        },
      },
    ]);

    const minDate = range?.minDate ? new Date(range.minDate).toISOString() : null;
    const maxDate = range?.maxDate ? new Date(range.maxDate).toISOString() : null;
    const distinctSkills = range?.skills?.length ?? 0;

    console.log(
      `daily buckets backfill: ${res.buckets} rows, pruned ${res.deleted ?? 0}, range ${minDate} .. ${maxDate}, ${distinctSkills} distinct skills`,
    );
    return {
      ok: true,
      buckets: res.buckets,
      deleted: res.deleted ?? 0,
      minDate,
      maxDate,
      distinctSkills,
    };
  } catch (err) {
    console.warn("daily buckets backfill failed:", err?.message);
    return {
      ok: false,
      buckets: 0,
      deleted: 0,
      minDate: null,
      maxDate: null,
      distinctSkills: 0,
      error: err?.message,
    };
  }
}
