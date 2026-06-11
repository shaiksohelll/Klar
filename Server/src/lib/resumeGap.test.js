import { describe, it, expect } from "vitest"
import { computeResumeGap } from "./resumeGap.js"

// ── Sample demand list (demand-desc order, as the route supplies) ──────────
const DEMAND = [
	{ skill: "react",      count: 120 },
	{ skill: "node.js",    count: 95 },
	{ skill: "python",     count: 80 },
	{ skill: "typescript", count: 70 },
	{ skill: "docker",     count: 55 },
]

describe("computeResumeGap", () => {
	// ── Matched / missing split ──────────────────────────────────────────────

	it("splits demand into matched and missing correctly", () => {
		const { matched, missing } = computeResumeGap({
			resumeText: "I have experience with React and Node.js in production.",
			demand: DEMAND,
		})

		expect(matched.map((m) => m.skill)).toContain("react")
		expect(matched.map((m) => m.skill)).toContain("node.js")
		expect(missing.map((m) => m.skill)).toContain("python")
		expect(missing.map((m) => m.skill)).toContain("typescript")
		expect(missing.map((m) => m.skill)).toContain("docker")
	})

	it("preserves demand-desc order inside matched and missing", () => {
		const { matched, missing } = computeResumeGap({
			resumeText: "Python, React, Docker",
			demand: DEMAND,
		})

		// matched: react (120), python (80), docker (55) — original demand order
		expect(matched[0].skill).toBe("react")
		expect(matched[1].skill).toBe("python")
		expect(matched[2].skill).toBe("docker")

		// missing: node.js (95), typescript (70) — original demand order
		expect(missing[0].skill).toBe("node.js")
		expect(missing[1].skill).toBe("typescript")
	})

	// ── matchScore math ──────────────────────────────────────────────────────

	it("computes matchScore as a rounded percentage", () => {
		// 3 of 5 matched → Math.round(3/5*100) = 60
		const { matchScore, totalConsidered } = computeResumeGap({
			resumeText: "I know React, Python, and Docker.",
			demand: DEMAND,
		})

		expect(totalConsidered).toBe(5)
		expect(matchScore).toBe(60)
	})

	it("matchScore is 100 when every demand skill is in the résumé", () => {
		const { matchScore } = computeResumeGap({
			resumeText: "React Node.js Python TypeScript Docker",
			demand: DEMAND,
		})
		expect(matchScore).toBe(100)
	})

	// ── Empty résumé ─────────────────────────────────────────────────────────

	it("returns empty matched, full missing, and matchScore 0 for an empty résumé", () => {
		const { resumeSkills, matched, missing, matchScore } = computeResumeGap({
			resumeText: "",
			demand: DEMAND,
		})

		expect(resumeSkills).toEqual([])
		expect(matched).toEqual([])
		expect(missing).toEqual(DEMAND)
		expect(matchScore).toBe(0)
	})

	// ── Empty demand list ────────────────────────────────────────────────────

	it("returns matchScore 0 and empty slices when demand is empty", () => {
		const { matched, missing, matchScore, totalConsidered } = computeResumeGap({
			resumeText: "React Node.js Python",
			demand: [],
		})

		expect(matched).toEqual([])
		expect(missing).toEqual([])
		expect(matchScore).toBe(0)
		expect(totalConsidered).toBe(0)
	})

	// ── Alias / normalization ────────────────────────────────────────────────

	it("matches 'ReactJS' in résumé to canonical 'react' in demand", () => {
		const { matched } = computeResumeGap({
			resumeText: "Built UI components with ReactJS.",
			demand: DEMAND,
		})
		expect(matched.map((m) => m.skill)).toContain("react")
	})

	it("matches 'React.js' in résumé to canonical 'react' in demand", () => {
		const { matched } = computeResumeGap({
			resumeText: "React.js developer with 3 years of experience.",
			demand: DEMAND,
		})
		expect(matched.map((m) => m.skill)).toContain("react")
	})

	it("matches 'nodejs' alias to 'node.js' in demand", () => {
		const { matched } = computeResumeGap({
			resumeText: "Backend services built with nodejs and express.",
			demand: DEMAND,
		})
		expect(matched.map((m) => m.skill)).toContain("node.js")
	})

	// ── resumeSkills passthrough ─────────────────────────────────────────────

	it("returns the extracted resumeSkills array", () => {
		const { resumeSkills } = computeResumeGap({
			resumeText: "Python and Docker are my main tools.",
			demand: DEMAND,
		})
		expect(resumeSkills).toContain("python")
		expect(resumeSkills).toContain("docker")
	})
})
