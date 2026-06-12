// ── Conservative remote-work detection ────────────────────────────────────────
//
// The previous check was a bare /remote/i.test(...) which produced false
// positives on phrases like "not remote", "no remote option", "on-site only"
// and "hybrid — occasionally remote". For an honest-data product a false
// NEGATIVE (missing a genuinely remote job) is cheaper than a false POSITIVE
// (inflating remote-share stats), so this detector is deliberately strict:
//
//   1. If ANY negated/qualified context appears, the posting is NOT remote.
//   2. Otherwise the text must contain a clear positive signal.
//
// Used by the Adzuna ingester (free-text title + description). JSearch is
// not affected — it provides a structured `job_is_remote` boolean.

// Negated or qualified mentions — any single match disqualifies the text.
// Input is lowercased before testing, so the patterns are lowercase-only.
const NEGATIVE_PATTERNS = [
  // "not remote", "no remote", "non-remote", "never remote", "isn't remote",
  // including qualified forms: "not a remote", "not fully remote".
  /\b(?:not|no|non|never|isn['\u2019]?t)[\s-]+(?:a\s+)?(?:fully\s+|100%\s*)?remote\b/,
  // "remote work is not …", "remote working not …"
  /\bremote\s+(?:work(?:ing)?\s+)?(?:is\s+)?not\b/,
  // "on-site only", "onsite only", "in-office only", "office only"
  /\b(?:on[\s-]?site|in[\s-]?office|office)\s+only\b/,
  // Hybrid roles are not fully remote by definition.
  /\bhybrid\b/,
  // "occasionally remote", "partially remote", "sometimes remote"
  /\b(?:occasionally|partially|partly|sometimes|some)\s+remote\b/,
];

// Clear positive signals, checked only after negatives are ruled out.
const POSITIVE_PATTERNS = [
  /\bfully\s+remote\b/,
  /\b100%\s*remote\b/,
  /\bremote[\s-]first\b/,
  /\bwork\s+from\s+home\b/,
  /\bwfh\b/,
  // Standalone "remote" — safe here because every negated/qualified
  // context has already returned false above.
  /\bremote\b/,
];

/**
 * Returns true only when `text` clearly advertises a remote position.
 * Conservative by design: any negation/qualification → false.
 *
 * @param {string} text  Free text (e.g. `${title} ${description}`).
 * @returns {boolean}
 */
export function detectRemote(text = "") {
  const t = String(text).toLowerCase();
  if (!t.trim()) return false;
  if (NEGATIVE_PATTERNS.some((re) => re.test(t))) return false;
  return POSITIVE_PATTERNS.some((re) => re.test(t));
}
