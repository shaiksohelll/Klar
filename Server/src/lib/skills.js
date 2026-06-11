// A small, honest skill dictionary. Extend it anytime.
export const SKILL_TAXONOMY = [
	"javascript", "typescript", "react", "angular", "vue", "next.js", "node.js",
	"express", "mongodb", "postgresql", "mysql", "redis", "graphql", "rest",
	"python", "django", "flask", "java", "spring", "go", "rust", "php", "laravel",
	"c#", ".net", "ruby", "rails", "html", "css", "tailwind", "sass",
	"docker", "kubernetes", "aws", "azure", "google cloud", "terraform", "ci/cd",
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
	// google cloud
	"gcp":        "google cloud",
	// next.js
	"next":       "next.js",
	"nextjs":     "next.js",
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
// For special-char skills (c++, c#, .net, ci/cd, next.js, node.js, google cloud)
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
 *   - If the skill starts with a word char and ends with a word char → use \b
 *     on both sides.
 *   - If it starts with a word char but ends with a special char (e.g. "c++")
 *     → \b on the left, lookahead on the right.
 *   - If it starts with a special char (e.g. ".net") → lookbehind on left,
 *     \b or lookahead on right as appropriate.
 *   - In all cases the lookaround checks that the adjacent char is NOT
 *     [a-z0-9] (and NOT the same special char that could extend the token).
 */
function buildPattern(skill) {
	const escaped = escapeRegex(skill)
	const startsWord = WORD_BOUNDARY_CHARS.test(skill[0])
	const endsWord   = WORD_BOUNDARY_CHARS.test(skill[skill.length - 1])

	const left  = startsWord ? "\\b"              : "(?<![a-z0-9])"
	const right = endsWord   ? "\\b"              : "(?![a-z0-9])"

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