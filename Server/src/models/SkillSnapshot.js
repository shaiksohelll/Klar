import mongoose from "mongoose";

const SkillSnapshotSchema = new mongoose.Schema({
  skill: { type: String, required: true, trim: true },
  count: { type: Number, required: true }, // trailing 12-month total (matches Demand page)
  count30: { type: Number, required: true }, // trailing 30-day total (for velocity)
  capturedAt: { type: Date, required: true, default: Date.now },
});

// Fast time-series queries: "give me all snapshots for skill X, newest first"
// and "give me all skills captured at timestamp T".
SkillSnapshotSchema.index({ skill: 1, capturedAt: -1 });
// Auto-expire snapshots older than 90 days. On first run, any existing docs
// older than 90 days will be purged by MongoDB's TTL thread — this is expected
// and safe; the cron re-fills snapshots on the next run.
SkillSnapshotSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export default mongoose.model("SkillSnapshot", SkillSnapshotSchema);
