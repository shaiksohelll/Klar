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

const app = express()
app.use(helmet())
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }))
app.use(express.json())

app.get("/health", (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() })
})

// Pull jobs into the DB
app.get("/api/ingest/adzuna", async (req, res) => {
    try {
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
        res.json({ ok: true, ...result })
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
