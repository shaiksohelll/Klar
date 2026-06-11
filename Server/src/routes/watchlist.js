import { Router } from "express";
import { requireAuth } from "@clerk/express";
import Watchlist from "../models/Watchlist.js";

const router = Router();

// Every watchlist endpoint requires a valid Clerk session token.
// Clerk verifies the JWT in the Authorization header and populates req.auth.
// This prevents any unauthenticated caller — or another logged-in user who
// knows someone else's userId — from reading or modifying another person's list.
router.use(requireAuth());

// Helper: return the verified user's current tracked skill names
async function getSkills(userId) {
  const items = await Watchlist.find({ userId }).sort({ createdAt: -1 });
  return items.map((i) => i.skill);
}

// GET /api/watchlist  → { skills: ["react", "node.js"] }
// userId comes from the verified Clerk token, NOT the request.
router.get("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("GET /api/watchlist", err);
    next(err);
  }
});

// POST /api/watchlist  body: { skill }  → adds, returns updated list
router.post("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { skill } = req.body || {};
    if (!skill) return res.status(400).json({ error: "skill is required" });
    await Watchlist.updateOne(
      { userId, skill },
      { $setOnInsert: { userId, skill } },
      { upsert: true },
    );
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("POST /api/watchlist", err);
    next(err);
  }
});

// DELETE /api/watchlist  body: { skill }  → removes, returns updated list
router.delete("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { skill } = req.body || {};
    if (!skill) return res.status(400).json({ error: "skill is required" });
    await Watchlist.deleteOne({ userId, skill });
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    console.error("DELETE /api/watchlist", err);
    next(err);
  }
});

export default router;
