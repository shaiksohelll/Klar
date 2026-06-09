import mongoose from "mongoose";

const SkillSnapshotSchema = new mongoose.Schema({
  skill:      { type: String, required: true, trim: true },
  count:      { type: Number, required: true },
  capturedAt: { type: Date,   required: true, default: Date.now },
});

// Fast time-series queries: "give me all snapshots for skill X, newest first"
// and "give me all skills captured at timestamp T".
SkillSnapshotSchema.index({ skill: 1, capturedAt: -1 });

export default mongoose.model("SkillSnapshot", SkillSnapshotSchema);
