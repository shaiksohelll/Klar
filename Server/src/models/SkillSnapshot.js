import mongoose from "mongoose";

const SkillSnapshotSchema = new mongoose.Schema({
  skill: { type: String, required: true, trim: true },
  count: { type: Number, required: true }, // trailing 12-month total (matches Demand page)
  count30: { type: Number, required: true }, // trailing 30-day total (for velocity)
  // capturedAt drives the 90-day velocity TTL below. Optional so a momentum-only
  // upsert (keyed on { skill, date }) is valid without a capturedAt; the ingest
  // orchestrator always sets it on the combined row, so in practice it is present.
  capturedAt: { type: Date, default: Date.now },

  // ── Momentum (Trends) fields ───────────────────────────────────────────────
  // Added for the Skill Momentum feature. These are day-bucketed so the daily
  // ingest cron banks exactly one row per (skill, date). Older rows recorded
  // before this migration simply lack these fields; computeSkillMomentum()
  // tolerates their absence (treats them as 0 / null).
  //
  // date — UTC midnight of the ingest day. Together with skill it forms the
  //   idempotency key (unique index below): re-running ingest on the same day
  //   upserts the same row rather than appending a duplicate.
  date: { type: Date },
  // postingCount — trailing 12-month deduped demand for this skill on `date`.
  //   Mirrors `count` semantically but is the value momentum compares over time.
  postingCount: { type: Number },
  // disclosedCount — of postingCount, how many had an employer-disclosed salary.
  disclosedCount: { type: Number },
  // salaryMidpointMedian — median of disclosed INR salary midpoints only
  //   (null when there are no disclosed INR rows for the skill on `date`).
  //   INR-only keeps the figure honest: mixing currencies would be meaningless.
  salaryMidpointMedian: { type: Number, default: null },
});

// Fast time-series queries: "give me all snapshots for skill X, newest first"
// and "give me all skills captured at timestamp T".
SkillSnapshotSchema.index({ skill: 1, capturedAt: -1 });
// Idempotency + fast momentum reads: one row per (skill, day). The partial
// filter keeps legacy rows (which have no `date`) out of the unique index so
// this can be added without a backfill. New momentum rows upsert on this key.
SkillSnapshotSchema.index(
  { skill: 1, date: 1 },
  { unique: true, partialFilterExpression: { date: { $type: "date" } } },
);
// Range scans over the day-bucketed series ("all rows in the last N months").
SkillSnapshotSchema.index({ date: -1 });
// Auto-expire ONLY legacy velocity-only snapshots older than 90 days. The
// partial filter excludes day-bucketed momentum rows (those with a `date`) so
// the momentum data moat accrues indefinitely — that long history is the whole
// point of the feature and must survive the TTL sweep.
SkillSnapshotSchema.index(
  { capturedAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 90,
    partialFilterExpression: { date: { $exists: false } },
  },
);

export default mongoose.model("SkillSnapshot", SkillSnapshotSchema);
