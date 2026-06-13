import { SKILL_TAXONOMY, SKILL_ALIASES } from "./skills.js";

// ── Known role buckets ──────────────────────────────────────────────────────
// The complete set of values normalizeRole() can emit and therefore the only
// values Job.normalizedRole is ever set to. Any ?role= outside this set can
// match zero documents, so we reject it before touching Mongo.
export const KNOWN_ROLES = Object.freeze([
  "fullstack",
  "frontend",
  "backend",
  "devops",
  "data",
  "mobile",
  "other",
]);

const ROLE_SET = new Set(KNOWN_ROLES);

// Canonical skills are stored lowercase in Job.requiredSkills. O(1) lookup set.
const CANONICAL_SET = new Set(SKILL_TAXONOMY.map((s) => s.toLowerCase()));

/**
 * Resolve a raw ?skill= value to its canonical taxonomy form.
 *
 *   - Trims + lowercases.
 *   - Accepts a canonical skill ("react", "node.js", "c++", "c#").
 *   - Accepts a known alias ("reactjs", "k8s", "postgres", "google cloud") and
 *     resolves it to canonical. This also fixes a latent bug: passing an alias
 *     as a filter previously matched zero jobs because the DB only stores
 *     canonical names.
 *
 * @param {unknown} raw
 * @returns {string|null} canonical skill, or null if not a recognised skill.
 */
export function resolveSkill(raw) {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  if (CANONICAL_SET.has(key)) return key;
  if (Object.prototype.hasOwnProperty.call(SKILL_ALIASES, key)) {
    return SKILL_ALIASES[key];
  }
  return null;
}

/**
 * Resolve a raw ?role= value to a known role bucket.
 *
 * @param {unknown} raw
 * @returns {string|null} lowercased role bucket, or null if unknown.
 */
export function resolveRole(raw) {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  return ROLE_SET.has(key) ? key : null;
}
