import mongoose from "mongoose";

const watchlistSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    skill: { type: String, required: true },
  },
  { timestamps: true },
);

watchlistSchema.index({ userId: 1, skill: 1 }, { unique: true });

export default mongoose.model("Watchlist", watchlistSchema);