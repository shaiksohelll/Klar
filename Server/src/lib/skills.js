// A small, honest skill dictionary. Extend it anytime.
export const SKILL_TAXONOMY = [
	"javascript", "typescript", "react", "angular", "vue", "next.js", "node.js",
	"express", "mongodb", "postgresql", "mysql", "redis", "graphql", "rest",
	"python", "django", "flask", "java", "spring", "go", "rust", "php", "laravel",
	"c#", ".net", "ruby", "rails", "html", "css", "tailwind", "sass",
	"docker", "kubernetes", "aws", "azure", "gcp", "terraform", "ci/cd",
	"git", "jest", "cypress", "playwright", "kafka", "rabbitmq", "elasticsearch",
	"c++",
]

// ── Alias map ─────────────────────────────────────────────────────────────────
// Keys are common synonyms / abbreviations; values MUST be an entry in
// SKILL_TAXONOMY (verified at startup — see assertion below).
export const SKILL_ALIASES = {
	// react
	"reactjs":    "react",
	"react.js":   "react",
	// node.js
	"node":       "node.js",
	"nodejs":     "node.js",
	// kubernetes
	"k8s":        "kubernetes",
	// postgresql
	"postgres":   "postgresql",
	// gcp — canonical key matches historical ingests and displayName.js
	"google cloud": "gcp",
	// next.js  (bare "next" removed — too ambiguous)
	"nextjs":     "next.js",
	// html
	"html5":      "html",
	"html 5":     "html",
	"xhtml":      "html",
}

// Validate at startup that every alias target exists in SKILL_TAXONOMY.
for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
	if (!SKILL_TAXONOMY.includes(canonical)) {
		throw new Error(
			`SKILL_ALIASES: alias "${alias}" points to "${canonical}" which is NOT in SKILL_TAXONOMY`,
		)
	}
}

// ── Pattern building ──────────────────────────────────────────────────────────
//
// For "plain" skills (letters/digits only) we rely on \b word boundaries.
// For special-char skills (c++, c#, .net, ci/cd, next.js, node.js)
// we use a custom lookaround: assert non-alnum on each side.
// The character class [a-z0-9] is intentionally ASCII-only to match the corpus.

const WORD_BOUNDARY_CHARS = /[a-z0-9]/i

/**
 * Escape all regex metacharacters in a literal string.
 */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Build a case-insensitive RegExp that matches `skill` as a standalone token
 * regardless of whether the skill contains special characters.
 *
 * Strategy:
 *   - Plain skills (start AND end with a word char) → \b on both sides.
 *   - Skills starting with a word char but ending with a special char (e.g.
 *     "c++", "c#") → \b left, (?![a-z]) right.
 *   - Skills starting with a special char (e.g. ".net") → empty left boundary
 *     (the literal leading char is its own delimiter), (?![a-z]) right.
 *
 * Right boundary for any skill that does NOT end with a word char:
 *   (?![a-z]) — blocks a trailing LETTER (.network ≠ .net) but allows a
 *   trailing DIGIT (c++17, c#8, .net8 all qualify the skill).
 *
 * For skills starting with a special char but ending with a word char (e.g.
 * ".net" ends with 't'), \b would wrongly block ".net8" because \b sees no
 * boundary between 't' and '8' (both are \w). We use (?![a-z]) here too,
 * so the version digit is allowed while ".network" is still blocked.
 */
function buildPattern(skill) {
	const escaped = escapeRegex(skill)
	const startsWord = WORD_BOUNDARY_CHARS.test(skill[0])
	const endsWord   = WORD_BOUNDARY_CHARS.test(skill[skill.length - 1])

	// Skills starting with a special char carry their own left boundary (the
	// special char itself); no extra assertion is needed.
	const left = startsWord ? "\\b" : ""

	// Right boundary:
	//   • Plain word-ending skills whose LEFT is also a word char → \b is safe.
	//   • Everything else → block only trailing letters, not digits.
	//     This covers "c++" (ends special), "c#" (ends special), AND ".net"
	//     (starts special, ends word — \b would fail before a version digit).
	const right = (startsWord && endsWord) ? "\\b" : "(?![a-z])"

	return new RegExp(`${left}${escaped}${right}`, "i")
}

// Precompile patterns for every taxonomy entry.
const TAXONOMY_PATTERNS = SKILL_TAXONOMY.map((skill) => ({
	skill,
	re: buildPattern(skill),
}))

// Precompile patterns for every alias.
const ALIAS_PATTERNS = Object.entries(SKILL_ALIASES).map(([alias, canonical]) => ({
	alias,
	canonical,
	re: buildPattern(alias),
}))

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract canonical skill names from free-form text.
 * Aliases are resolved to their canonical form.
 * Results are deduplicated.
 */
export function extractSkills(text = "") {
	const found = new Set()

	// 1. Direct taxonomy matches.
	for (const { skill, re } of TAXONOMY_PATTERNS) {
		if (re.test(text)) found.add(skill)
	}

	// 2. Alias matches → resolve to canonical.
	for (const { canonical, re } of ALIAS_PATTERNS) {
		if (re.test(text)) found.add(canonical)
	}

	return [...found]
}

export function normalizeRole(title = "") {
	const t = title.toLowerCase()
	if (t.includes("full") && t.includes("stack")) return "fullstack"
	if (t.includes("front")) return "frontend"
	if (t.includes("back")) return "backend"
	if (t.includes("devops") || t.includes("sre")) return "devops"
	if (t.includes("data")) return "data"
	if (t.includes("mobile") || t.includes("android") || t.includes("ios")) return "mobile"
	return "other"
}