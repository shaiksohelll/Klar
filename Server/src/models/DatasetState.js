import mongoose from "mongoose";

const SOURCE_STATUSES = [
  "idle",
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
];

const SourceStateSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    status: { type: String, enum: SOURCE_STATUSES, default: "idle" },
    lastAttemptAt: { type: Date, default: null },
    lastCompletedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastPartialAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const DatasetStateSchema = new mongoose.Schema(
  {
    // Fixed string _id uses MongoDB's built-in uniqueness and needs no
    // production autoIndex migration.
    _id: { type: String, default: "jobs" },
    version: { type: Number, required: true, default: 0, min: 0 },
    asOf: { type: Date, default: null },
    runningSources: {
      type: [{ type: String, enum: ["adzuna", "jsearch"] }],
      default: [],
    },
    sources: {
      adzuna: { type: SourceStateSchema, default: () => ({}) },
      jsearch: { type: SourceStateSchema, default: () => ({}) },
    },
  },
  { timestamps: true, minimize: false },
);

export default mongoose.model("DatasetState", DatasetStateSchema);
