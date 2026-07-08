import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import mongoose from "mongoose"
import { MongoMemoryServer } from "mongodb-memory-server"
import Job from "../models/Job.js"
import { makeDedupeKey, normalizeCompany, dedupeGroupStages } from "./dedupe.js"

// ── normalizeCompany behaviour (read before writing assertions) ───────────────
//
// From dedupe.js:
//   - Lowercase, trim, collapse whitespace.
//   - Strip trailing legal/filler suffixes iteratively
//     (inc, llc, ltd, limited, pvt, private, technologies, technology,
//      solutions, services, india, corp, co).
//   - Returns "" if result is blank.

describe("normalizeCompany", () => {
	it("lowercases and trims", () => {
		expect(normalizeCompany("  Acme  ")).toBe("acme")
	})

	it("strips trailing Ltd suffix", () => {
		expect(normalizeCompany("Acme Ltd")).toBe("acme")
	})

	it("strips multiple trailing suffixes (Pvt Ltd)", () => {
		expect(normalizeCompany("Acme Pvt Ltd")).toBe("acme")
	})

	it("strips 'Technologies' suffix", () => {
		expect(normalizeCompany("Acme Technologies")).toBe("acme")
	})

	it("strips 'Inc' suffix", () => {
		expect(normalizeCompany("Acme Inc")).toBe("acme")
	})

	it("returns empty string for blank input", () => {
		expect(normalizeCompany("")).toBe("")
	})

	it("returns empty string for whitespace-only input", () => {
		expect(normalizeCompany("   ")).toBe("")
	})
})

// ── makeDedupeKey ─────────────────────────────────────────────────────────────

describe("makeDedupeKey", () => {
	it("produces a normalized company::title::city key", () => {
		// normalizeCompany("Acme Inc") → "acme"
		// normalizeJobTitle("Senior React Developer") → "senior react developer"
		// normalizeLocation("Mumbai, Maharashtra, India") → "mumbai"
		const key = makeDedupeKey("Acme Inc", "Senior React Developer", "Mumbai, Maharashtra, India")
		expect(key).toBe("acme::senior react developer::mumbai")
	})

	it("company is stripped of Pvt Ltd suffixes", () => {
		const key = makeDedupeKey("Globex Pvt Ltd", "Backend Engineer", "Pune")
		expect(key).toBe("globex::backend engineer::pune")
	})

	it("title punctuation is removed", () => {
		// normalizeJobTitle replaces non-word non-space chars with spaces, then
		// collapses all whitespace runs — so "Full-Stack (Node/React) Dev" becomes
		// "full stack node react dev" (single spaces throughout).
		const key = makeDedupeKey("Initech", "Full-Stack (Node/React) Dev", "")
		expect(key).toBe("initech::full stack node react dev::")
		// Also assert determinism: two calls with the same args produce the same key.
		const key2 = makeDedupeKey("Initech", "Full-Stack (Node/React) Dev", "")
		expect(key).toBe(key2)
	})

	it("omitted location defaults to empty city segment", () => {
		const key = makeDedupeKey("Vandalay Industries", "Latex Salesman")
		expect(key).toBe("vandalay industries::latex salesman::")
	})

	it("blank company returns null (no-accidental-merge contract)", () => {
		expect(makeDedupeKey("", "Software Engineer", "Delhi")).toBeNull()
	})

	it("whitespace-only company returns null", () => {
		expect(makeDedupeKey("   ", "Software Engineer", "Delhi")).toBeNull()
	})

	it("company that reduces to empty after suffix stripping returns null", () => {
		// A name composed entirely of suffix words collapses to "".
		// e.g. "India Ltd" → strip "ltd" → "india" → strip "india" → ""
		expect(makeDedupeKey("India Ltd", "Developer", "Bangalore")).toBeNull()
	})

	it("same posting from two sources produces the same key", () => {
		const keyA = makeDedupeKey("Acme Corp", "React Developer", "Hyderabad")
		const keyB = makeDedupeKey("Acme Corp.", "React Developer", "Hyderabad, Telangana")
		// normalizeCompany strips "Corp" via COMPANY_SUFFIX_RE, which includes \.?$
		// so the trailing period in "Corp." is absorbed by the same regex pass.
		// normalizeLocation takes only the first comma-separated segment →
		// "hyderabad" for both inputs. Both keys must converge.
		expect(keyA).toBe(keyB)
	})

	it("different cities produce different keys (no cross-city merge)", () => {
		const keyMumbai = makeDedupeKey("Acme Corp", "Backend Dev", "Mumbai")
		const keyPune   = makeDedupeKey("Acme Corp", "Backend Dev", "Pune")
		expect(keyMumbai).not.toBe(keyPune)
	})
})

// ── dedupeGroupStages — salary coherence (integration) ────────────────────────
//
// salaryDisclosed, salaryRange (including the embedded currency) MUST be picked
// as ONE unit from the SAME document.  This suite verifies that when one twin
// is disclosed and the other is not, the deduped group always carries the
// disclosed twin's salary fields — never a mixed pair.

describe("dedupeGroupStages — salary coherence (integration)", () => {
	let mongod

	beforeAll(async () => {
		mongod = await MongoMemoryServer.create()
		await mongoose.connect(mongod.getUri(), { autoIndex: false })
	})

	afterAll(async () => {
		await mongoose.disconnect()
		await mongod.stop()
	})

	beforeEach(async () => {
		await Job.deleteMany({})
	})

	it("disclosed twin's salaryRange+currency+flag win even when it is the older posting", async () => {
		const title       = "Backend Developer"
		const companyName = "CoherentCorp"
		const location    = "Bangalore"
		const key         = makeDedupeKey(companyName, title, location)

		// Adzuna twin: NEWER, but undisclosed — USD salary should NOT win.
		await Job.create({
			externalId:      "adzuna:coh1",
			source:          "adzuna",
			title,
			normalizedRole:  "backend",
			companyName,
			isRemote:        false,
			requiredSkills:  ["node.js"],
			salaryRange:     { min: 999, max: 999, midpoint: 999, currency: "USD" },
			salaryDisclosed: false,
			location,
			redirectUrl:     "",
			postedAt:        new Date("2024-06-02"), // newer
			dedupeKey:       key,
		})

		// JSearch twin: OLDER, but disclosed — INR salary MUST win.
		await Job.create({
			externalId:      "jsearch:coh1",
			source:          "jsearch",
			title,
			normalizedRole:  "backend",
			companyName,
			isRemote:        false,
			requiredSkills:  ["node.js"],
			salaryRange:     { min: 500_000, max: 500_000, midpoint: 500_000, currency: "INR" },
			salaryDisclosed: true,
			location,
			redirectUrl:     "",
			postedAt:        new Date("2024-06-01"), // older
			dedupeKey:       key,
		})

		const [result] = await Job.aggregate([...dedupeGroupStages()])

		// The salary fields must be coherent and come from the disclosed (JSearch) twin.
		expect(result.salaryDisclosed).toBe(true)
		expect(result.salaryRange.midpoint).toBe(500_000)
		expect(result.salaryRange.currency).toBe("INR")

		// Non-salary fields still follow newest-wins ($first on postedAt:-1).
		// postedAt itself is the first-picked value = most recent = Adzuna's date.
		expect(result.postedAt).toEqual(new Date("2024-06-02"))
	})

	it("when both twins are undisclosed the group stays undisclosed", async () => {
		const title       = "Frontend Developer"
		const companyName = "BothUndisclosed"
		const location    = "Mumbai"
		const key         = makeDedupeKey(companyName, title, location)

		await Job.create([
			{
				externalId: "adzuna:und1", source: "adzuna", title,
				normalizedRole: "frontend", companyName, isRemote: false,
				requiredSkills: ["react"],
				salaryRange: { min: 800, max: 800, midpoint: 800, currency: "USD" },
				salaryDisclosed: false,
				location, redirectUrl: "", postedAt: new Date("2024-06-02"), dedupeKey: key,
			},
			{
				externalId: "jsearch:und1", source: "jsearch", title,
				normalizedRole: "frontend", companyName, isRemote: false,
				requiredSkills: ["react"],
				salaryRange: { min: 700, max: 700, midpoint: 700, currency: "USD" },
				salaryDisclosed: false,
				location, redirectUrl: "", postedAt: new Date("2024-06-01"), dedupeKey: key,
			},
		])

		const [result] = await Job.aggregate([...dedupeGroupStages()])
		expect(result.salaryDisclosed).toBe(false)
	})

	it("when both twins are disclosed the one with the newer postedAt wins", async () => {
		const title       = "Data Engineer"
		const companyName = "BothDisclosed"
		const location    = "Hyderabad"
		const key         = makeDedupeKey(companyName, title, location)

		await Job.create([
			{
				externalId: "adzuna:disc1", source: "adzuna", title,
				normalizedRole: "backend", companyName, isRemote: false,
				requiredSkills: ["python"],
				salaryRange: { min: 2_000_000, max: 2_000_000, midpoint: 2_000_000, currency: "INR" },
				salaryDisclosed: true,
				location, redirectUrl: "", postedAt: new Date("2024-06-02"), dedupeKey: key,
			},
			{
				externalId: "jsearch:disc1", source: "jsearch", title,
				normalizedRole: "backend", companyName, isRemote: false,
				requiredSkills: ["python"],
				salaryRange: { min: 1_500_000, max: 1_500_000, midpoint: 1_500_000, currency: "INR" },
				salaryDisclosed: true,
				location, redirectUrl: "", postedAt: new Date("2024-06-01"), dedupeKey: key,
			},
		])

		const [result] = await Job.aggregate([...dedupeGroupStages()])
		expect(result.salaryDisclosed).toBe(true)
		// Both disclosed — $top(salaryDisclosed:-1, postedAt:-1) picks the newest = Adzuna.
		expect(result.salaryRange.midpoint).toBe(2_000_000)
	})
})
