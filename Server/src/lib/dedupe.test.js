import { describe, it, expect } from "vitest"
import { makeDedupeKey, normalizeCompany } from "./dedupe.js"

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
		// normalizeCompany handles trailing period via suffix logic (corp stripped, period in word boundary)
		// normalizeLocation takes only first segment → "hyderabad" for both
		// Both should converge to the same key
		expect(keyA).toBe(keyB)
	})

	it("different cities produce different keys (no cross-city merge)", () => {
		const keyMumbai = makeDedupeKey("Acme Corp", "Backend Dev", "Mumbai")
		const keyPune   = makeDedupeKey("Acme Corp", "Backend Dev", "Pune")
		expect(keyMumbai).not.toBe(keyPune)
	})
})
