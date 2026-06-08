import Job from "../models/Job.js"
import { extractSkills, normalizeRole } from "../lib/skills.js"

const APP_ID = process.env.ADZUNA_APP_ID
const APP_KEY = process.env.ADZUNA_APP_KEY

// Roles we sweep for full market breadth (used when no specific search term is given)
const ROLE_QUERIES = [
	"frontend developer",
	"backend developer",
	"full stack developer",
	"devops engineer",
	"data engineer",
	"mobile developer",
	"software developer",
]

// Fetch one page of results from Adzuna
async function fetchPage({ country, page, what }) {
	const url =
		`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}` +
		`?app_id=${APP_ID}&app_key=${APP_KEY}` +
		`&results_per_page=50&what=${encodeURIComponent(what)}&content-type=application/json`
	const res = await fetch(url)
	if (!res.ok) {
		const body = await res.text()
		throw new Error(`Adzuna ${res.status}: ${body.slice(0, 200)}`)
	}
	return res.json()
}

// Map one Adzuna job into our Job schema shape
function mapJob(raw, country) {
	const title = raw.title || ""
	const description = raw.description || ""
	const min = raw.salary_min ?? null
	const max = raw.salary_max ?? null
	const midpoint =
		min != null && max != null ? (min + max) / 2 : (min ?? max ?? null)
	return {
		externalId: String(raw.id),
		source: "adzuna",
		title,
		normalizedRole: normalizeRole(title),
		companyName: raw.company?.display_name || "",
		isRemote: /remote/i.test(`${title} ${description}`),
		requiredSkills: extractSkills(`${title} ${description}`),
		salaryRange: {
			min,
			max,
			midpoint,
			currency: country === "in" ? "INR" : country === "us" ? "USD" : "GBP",
		},
		location: raw.location?.display_name || "",
		redirectUrl: raw.redirect_url || "",
		postedAt: raw.created ? new Date(raw.created) : new Date(),
	}
}

export async function ingestAdzuna({ what, queries, country = "in", pages = 2, prune } = {}) {
	if (!APP_ID || !APP_KEY) {
		throw new Error("Missing ADZUNA_APP_ID or ADZUNA_APP_KEY in .env")
	}

	// What to search: explicit queries → single `what` → else all roles (breadth)
	const searchTerms = queries?.length ? queries : what ? [what] : ROLE_QUERIES
	// Only prune stale jobs on a full sweep (not a narrow single-term query)
	const shouldPrune = prune ?? (!what && !queries)

	const runStartedAt = new Date()
	let fetched = 0
	const docsById = new Map() // dedupe: same job can match multiple role queries

	for (const term of searchTerms) {
		for (let page = 1; page <= pages; page++) {
			const data = await fetchPage({ country, page, what: term })
			const results = data.results || []
			fetched += results.length
			for (const raw of results) {
				const doc = mapJob(raw, country)
				docsById.set(doc.externalId, doc)
			}
			if (results.length === 0) break
		}
	}

	const ops = [...docsById.values()].map((doc) => ({
		updateOne: {
			filter: { source: doc.source, externalId: doc.externalId },
			update: { $set: doc },
			upsert: true,
		},
	}))

	let upserted = 0
	let modified = 0
	if (ops.length > 0) {
		const result = await Job.bulkWrite(ops, { ordered: false })
		upserted = result.upsertedCount || 0
		modified = result.modifiedCount || 0
	}

	let removed = 0
	if (shouldPrune && fetched > 0) {
		const pruneResult = await Job.deleteMany({
			source: "adzuna",
			updatedAt: { $lt: runStartedAt },
		})
		removed = pruneResult.deletedCount || 0
	}

	return {
		fetched,
		unique: docsById.size,
		upserted,
		modified,
		removed,
		totalInDb: await Job.countDocuments(),
	}
}