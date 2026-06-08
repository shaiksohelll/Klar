import { Router } from "express";
import Watchlist from "../models/Watchlist.js";

const router = Router();

// Helper: return the user's current tracked skill names
async function getSkills(userId) {
  const items = await Watchlist.find({ userId }).sort({ createdAt: -1 });
  return items.map((i) => i.skill);
}

// GET /api/watchlist?userId=...  -> { skills: ["react", "node.js"] }
router.get("/", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("GET /api/watchlist", err);
    res.status(500).json({ error: "Failed to load watchlist" });
  }
});

// POST /api/watchlist  body: { userId, skill }  -> adds, returns updated list
router.post("/", async (req, res) => {
  try {
    const { userId, skill } = req.body;
    if (!userId || !skill)
      return res.status(400).json({ error: "userId and skill are required" });
    await Watchlist.updateOne(
      { userId, skill },
      { $setOnInsert: { userId, skill } },
      { upsert: true },
    );
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("POST /api/watchlist", err);
    res.status(500).json({ error: "Failed to add to watchlist" });
  }
});

// DELETE /api/watchlist  body: { userId, skill }  -> removes, returns updated list
router.delete("/", async (req, res) => {
  try {
    const { userId, skill } = req.body;
    if (!userId || !skill)
      return res.status(400).json({ error: "userId and skill are required" });
    await Watchlist.deleteOne({ userId, skill });
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("DELETE /api/watchlist", err);
    res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

export default router;
