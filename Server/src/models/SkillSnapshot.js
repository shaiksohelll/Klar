import mongoose from "mongoose";

const SkillSnapshotSchema = new mongoose.Schema({
  skill: { type: String, required: true, trim: true },
  // count / count30 are LEGACY velocity fields, only meaningful for the
  // ephemeral velocity rows written by ingest/adzuna.js (which always set them
  // explicitly). They are NOT required because day-bucketed momentum rows do not
  // carry them; making them required would reject a valid momentum document.
  count: { type: Number }, // trailing 12-month total (matches Demand page)
  count30: { type: Number }, // trailing 30-day total (for velocity)
  // capturedAt drives the 90-day velocity TTL below. NO default on purpose:
  // day-bucketed momentum rows (keyed on { skill, date }) must NOT carry a
  // capturedAt, or the TTL index could expire the data moat. It is set
  // EXPLICITLY only where legacy velocity snapshot rows are written
  // (see the SkillSnapshot.insertMany in ingest/adzuna.js).
  capturedAt: { type: Date },

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
// Auto-expire ONLY legacy velocity-only snapshots older than 90 days.
//
// The partial filter scopes the TTL to rows that HAVE a capturedAt. Day-bucketed
// momentum rows carry NO capturedAt (see the model field + ingest/snapshot.js),
// so they are excluded and the momentum data moat accrues indefinitely — that
// long history is the whole point of the feature and must survive the TTL sweep.
//
// IMPORTANT: MongoDB partial indexes support `$exists: true` but NOT
// `$exists: false` (the latter compiles to `$not`, which is rejected). So we key
// the filter on capturedAt presence, which is equivalent to "legacy row" here.
SkillSnapshotSchema.index(
  { capturedAt: 1 },
  {
    expireAfterSeconds: 60 * 60 * 24 * 90,
    partialFilterExpression: { capturedAt: { $exists: true } },
  },
);

export default mongoose.model("SkillSnapshot", SkillSnapshotSchema);
