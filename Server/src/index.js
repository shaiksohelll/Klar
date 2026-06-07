import "dotenv/config"
import express from "express"
import cors from "cors"
import helmet from "helmet"
import mongoose from "mongoose"
import { ingestAdzuna } from "./ingest/adzuna.js"
import { getTrendingSkills } from "./aggregations/trendingSkills.js"

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
		const what = req.query.what || "developer"
		const country = req.query.country || "in"
		const pages = Number(req.query.pages || 3)
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

const PORT = process.env.PORT || 5000

mongoose
	.connect(process.env.MONGODB_URI)
	.then(() => {
		console.log("✅ Mongo connected")
		app.listen(PORT, () => {
			console.log(`✅ API running on http://localhost:${PORT}`)
		})
	})
	.catch((err) => {
		console.error("❌ Mongo connection failed:", err.message)
		process.exit(1)
	})