import { Router } from "express";
import { requireAuth } from "@clerk/express";
import Watchlist from "../models/Watchlist.js";
import { resolveSkill } from "../lib/validate.js";

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
    next(err);
  }
});

// POST /api/watchlist  body: { skill }  → adds (canonicalized), returns updated list
router.post("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { skill } = req.body || {};
    if (!skill) return res.status(400).json({ error: "skill is required" });
    // Validate against the canonical taxonomy and store the canonical name so
    // aliases (e.g. "reactjs") dedupe to one entry ("react").
    const canonical = resolveSkill(skill);
    if (!canonical) {
      return res.status(400).json({
        error: "Unknown skill — see /api/skills/all for valid values.",
      });
    }
    await Watchlist.updateOne(
      { userId, skill: canonical },
      { $setOnInsert: { userId, skill: canonical } },
      { upsert: true },
    );
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/watchlist  body: { skill }  → removes, returns updated list
router.delete("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { skill } = req.body || {};
    if (!skill) return res.status(400).json({ error: "skill is required" });
    // Resolve to canonical so deleting an alias ("reactjs") removes the stored
    // "react". Fall back to the raw value so users can still remove any legacy
    // entries saved before validation existed.
    const target = resolveSkill(skill) || skill;
    await Watchlist.deleteOne({ userId, skill: target });
    res.json({ skills: await getSkills(userId) });
  } catch (err) {
    next(err);
  }
});

export default router;
