import { describe, it, expect } from "vitest"
import { extractSkills, SKILL_ALIASES, SKILL_TAXONOMY } from "./skills.js"

// ── Alias resolution ──────────────────────────────────────────────────────────

describe("SKILL_ALIASES integrity", () => {
	it("every alias target exists in SKILL_TAXONOMY", () => {
		for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
			expect(
				SKILL_TAXONOMY,
				`alias "${alias}" → "${canonical}" not found in SKILL_TAXONOMY`,
			).toContain(canonical)
		}
	})
})

describe("alias resolution via extractSkills", () => {
	it("reactjs → react", () => {
		expect(extractSkills("looking for a reactjs developer")).toContain("react")
	})

	it("react.js → react", () => {
		expect(extractSkills("experience with react.js required")).toContain("react")
	})

	it("k8s → kubernetes", () => {
		expect(extractSkills("deploy on k8s clusters")).toContain("kubernetes")
	})

	it("node → node.js", () => {
		expect(extractSkills("strong node experience")).toContain("node.js")
	})

	it("nodejs → node.js", () => {
		expect(extractSkills("nodejs REST API")).toContain("node.js")
	})

	it("postgres → postgresql", () => {
		expect(extractSkills("postgres database experience")).toContain("postgresql")
	})

	it("gcp → gcp (canonical)", () => {
		expect(extractSkills("deploy on gcp")).toContain("gcp")
	})

	it("google cloud → gcp (alias)", () => {
		expect(extractSkills("experience with google cloud platform")).toContain("gcp")
	})

	it("nextjs → next.js", () => {
		expect(extractSkills("nextjs app router")).toContain("next.js")
	})

	it("next.js (literal) → next.js", () => {
		expect(extractSkills("built with next.js framework")).toContain("next.js")
	})

	it("bare 'next' does NOT resolve to next.js", () => {
		// "next" is too ambiguous — must not be treated as next.js
		const skills = extractSkills("your next opportunity awaits")
		expect(skills).not.toContain("next.js")
	})
})

// ── Word-boundary guard: java vs javascript ───────────────────────────────────

describe("extractSkills word-boundary guard", () => {
	it('"strong javascript skills" does NOT include java', () => {
		const skills = extractSkills("strong javascript skills")
		expect(skills).toContain("javascript")
		expect(skills).not.toContain("java")
	})

	it('"java backend" does NOT include javascript', () => {
		const skills = extractSkills("java backend developer")
		expect(skills).toContain("java")
		expect(skills).not.toContain("javascript")
	})

	it('"java and javascript" extracts both', () => {
		const skills = extractSkills("java and javascript both required")
		expect(skills).toContain("java")
		expect(skills).toContain("javascript")
	})
})

// ── Case-insensitivity ────────────────────────────────────────────────────────

describe("extractSkills case insensitivity", () => {
	it("REACT (uppercase) → react", () => {
		expect(extractSkills("REACT developer")).toContain("react")
	})

	it("JavaScript (mixed case) → javascript", () => {
		expect(extractSkills("JavaScript experience required")).toContain("javascript")
	})

	it("TypeScript (mixed case) → typescript", () => {
		expect(extractSkills("TypeScript preferred")).toContain("typescript")
	})

	it("K8S (uppercase alias) → kubernetes", () => {
		expect(extractSkills("deploy on K8S")).toContain("kubernetes")
	})
})

// ── Special-character skills ──────────────────────────────────────────────────

describe("extractSkills special-char skills", () => {
	it("c++ extracts correctly", () => {
		expect(extractSkills("experience in c++ development")).toContain("c++")
	})

	it("c++ does NOT match c# or c", () => {
		const skills = extractSkills("c++ developer")
		expect(skills).not.toContain("c#")
	})

	it("c# extracts correctly", () => {
		expect(extractSkills("senior c# developer")).toContain("c#")
	})

	it("c# does NOT match c++ or c", () => {
		const skills = extractSkills("c# .net developer")
		expect(skills).not.toContain("c++")
	})

	it("ci/cd extracts correctly", () => {
		expect(extractSkills("experience with ci/cd pipelines")).toContain("ci/cd")
	})

	it("ci/cd does NOT produce false positives on slash-containing text", () => {
		// Adversarial: these share the "/" but must NOT match
		expect(extractSkills("pricing/discount rules")).not.toContain("ci/cd")
		expect(extractSkills("acid/base chemistry")).not.toContain("ci/cd")
	})

	it(".net extracts correctly", () => {
		expect(extractSkills("dotnet and .net experience")).toContain(".net")
	})

	it(".net does NOT trigger on 'dotnet' (no leading dot)", () => {
		// "dotnet" has no leading dot, so the .net pattern (which requires a
		// literal '.') must NOT match it.
		const skills = extractSkills("dotnet core developer")
		expect(skills).not.toContain(".net")
	})

	it(".net extracts from compound tokens like 'asp.net'", () => {
		// The leading dot IS its own left boundary; asp.net must yield .net.
		expect(extractSkills("asp.net developer")).toContain(".net")
	})

	it(".network does NOT match .net (right lookahead blocks extension)", () => {
		expect(extractSkills(".network engineer role")).not.toContain(".net")
	})
})

// ── No false positives on edge cases ─────────────────────────────────────────

describe("extractSkills no false positives", () => {
	it("empty string returns empty array", () => {
		expect(extractSkills("")).toEqual([])
	})

	it('"go" does not match "category" or "cargo"', () => {
		const skills = extractSkills("category of cargo items")
		expect(skills).not.toContain("go")
	})

	it('"go" matches standalone "go"', () => {
		expect(extractSkills("strong go backend skills")).toContain("go")
	})

	it('"rust" does not match "trusted"', () => {
		expect(extractSkills("trusted developers")).not.toContain("rust")
	})
})
