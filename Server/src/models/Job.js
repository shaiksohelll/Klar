import mongoose from "mongoose"

const JobSchema = new mongoose.Schema(
    {
        externalId: { type: String, required: true }, // unique ID from the source, for dedupe
        source: { type: String, enum: ["adzuna", "jsearch"], required: true },
        title: { type: String, required: true },
        normalizedRole: { type: String, index: true }, // "backend" | "frontend" | "fullstack"
        companyName: String,
        isRemote: { type: Boolean, default: false },
        requiredSkills: [{ type: String }], // ["node.js", "react", "mongodb"]
        salaryRange: { min: Number, max: Number, midpoint: Number, currency: String },
        location: String,
        redirectUrl: { type: String }, // direct link to the source job posting
        postedAt: { type: Date, required: true },
        // Cross-source deduplication key — normalizeCompany::normalizeTitle.
        // null when companyName is blank (those docs are never merged).
        // Set by both ingesters via makeDedupeKey() from lib/dedupe.js.
        dedupeKey: { type: String, default: null, index: true },
        // true only when the salary figures in salaryRange come from a
        // direct employer disclosure (not Adzuna predictions, not null).
        // Used by salaryInsights to compute honest stats.
        salaryDisclosed: { type: Boolean, default: false },
    },
    { timestamps: true },
)

JobSchema.index({ source: 1, externalId: 1 }, { unique: true })
JobSchema.index({ normalizedRole: 1, postedAt: -1 })
JobSchema.index({ postedAt: -1 })

export default mongoose.model("Job", JobSchema)