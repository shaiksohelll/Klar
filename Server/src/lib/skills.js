// A small, honest skill dictionary. Extend it anytime.
export const SKILL_TAXONOMY = [
	"javascript", "typescript", "react", "angular", "vue", "next.js", "node.js",
	"express", "mongodb", "postgresql", "mysql", "redis", "graphql", "rest",
	"python", "django", "flask", "java", "spring", "go", "rust", "php", "laravel",
	"c#", ".net", "ruby", "rails", "html", "css", "tailwind", "sass",
	"docker", "kubernetes", "aws", "azure", "gcp", "terraform", "ci/cd",
	"git", "jest", "cypress", "playwright", "kafka", "rabbitmq", "elasticsearch",
]

// Precompiled patterns with boundaries so "go" won't match "category", etc.
const PATTERNS = SKILL_TAXONOMY.map((skill) => ({
	skill,
	re: new RegExp(
		`(^|[^a-z0-9+#./])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9+#./]|$)`,
		"i",
	),
}))

export function extractSkills(text = "") {
	const found = new Set()
	for (const { skill, re } of PATTERNS) {
		if (re.test(text)) found.add(skill)
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