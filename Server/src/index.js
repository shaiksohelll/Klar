import "dotenv/config"
import express from "express"
import cors from "cors"
import helmet from "helmet"
import mongoose from "mongoose"
import { ingestAdzuna } from "./ingest/adzuna.js"
import cron from "node-cron"
import { getTrendingSkills } from "./aggregations/trendingSkills.js"
import watchlistRouter from "./routes/watchlist.js"
import skillDetailRouter from "./routes/skillDetail.js"
import Job from "./models/Job.js"

const app = express()
app.use(helmet())

// Only allow our own frontend (prod) + any localhost port (dev).
const allowedOrigins = [process.env.CLIENT_ORIGIN].filter(Boolean)
app.use(
    cors({
        origin(origin, cb) {
            // No origin = server-to-server / curl / health checks → allow.
            if (
                !origin ||
                /^http:\/\/localhost:\d+$/.test(origin) ||
                allowedOrigins.includes(origin)
            ) {
                return cb(null, true)
            }
            return cb(new Error(`Blocked by CORS: ${origin}`))
        },
        credentials: true,
    }),
)
app.use(express.json())

app.get("/health", (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() })
})

// Pull jobs into the DB
app.get("/api/ingest/adzuna", async (req, res) => {
    try {
        // No ?what → full market-breadth sweep (all roles) + prune.
        // ?what=react → narrow refresh of just that term, no prune.
        const what = req.query.what || undefined
        const country = req.query.country || "in"
        const pages = Number(req.query.pages || 2)
        const result = await ingestAdzuna({ what, country, pages })
        res.json({ ok: true, ...result })
    } catch (err) {
        console.error("Ingestion error:", err)
        res.status(500).json({ ok: false, error: err.message })
    }
})

// Analyze the DB → which skills are most in demand
app.get("/api/skills/trending", async (req, res) => {
    try {
        const { role, months, limit } = req.query
        const result = await getTrendingSkills({ role, months, limit })
        // Most recently touched job = how fresh the dataset is.
        const newest = await Job.findOne()
            .sort({ updatedAt: -1 })
            .select("updatedAt")
            .lean()
        res.json({ ok: true, ...result, lastUpdated: newest?.updatedAt || null })
    } catch (err) {
        console.error("Trending error:", err)
        res.status(500).json({ ok: false, error: err.message })
    }
})

// Saved skill watchlists (per Clerk user)
app.use("/api/watchlist", watchlistRouter)

// Enriched detail for a single skill
app.use("/api/skill", skillDetailRouter)

const PORT = process.env.PORT || 5000
mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
        console.log("✅ Mongo connected")
        // Keep data fresh automatically (near real-time): re-ingest every 6 hours.
        cron.schedule("0 */6 * * *", async () => {
            try {
                const r = await ingestAdzuna({ country: "in", pages: 2 })
                console.log("🔄 Auto-ingest:", r)
            } catch (e) {
                console.error("Auto-ingest failed:", e.message)
            }
        })
        app.listen(PORT, () => {
            console.log(`✅ API running on http://localhost:${PORT}`)
        })
    })
    .catch((err) => {
        console.error("❌ Mongo connection failed:", err.message)
        process.exit(1)
    })