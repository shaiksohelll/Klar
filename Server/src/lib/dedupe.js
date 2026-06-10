// ── Shared cross-source deduplication helpers ────────────────────────────────
//
// A job that appears on BOTH Adzuna and JSearch must be counted ONCE in every
// aggregation. We achieve this NON-DESTRUCTIVELY: both raw documents are kept;
// deduplication happens at COUNT time via a stable composite key.
//
// Key: `${normalizeCompany(companyName)}::${normalizeJobTitle(title)}`
// Blank-company postings cannot be reliably matched across sources and are
// left standalone (key = null).

// Suffixes that identify legal entity / filler words with no semantic value.
// Stripped ONLY at the end of the company name token sequence.
const COMPANY_SUFFIX_RE =
  /\b(inc|llc|ltd|limited|pvt|private|technologies|technology|solutions|services|india|corp|co)\b\.?$/gi;

/**
 * Normalise a company name for deduplication matching.
 * - Lowercase, trim, collapse whitespace.
 * - Strip trailing legal/filler suffixes iteratively (e.g. "Acme Pvt Ltd" → "acme").
 * - Returns "" if the result is blank (callers treat "" as unmatachable).
 */
export function normalizeCompany(name = "") {
  let s = String(name).toLowerCase().trim().replace(/\s+/g, " ");
  // Strip trailing suffixes repeatedly in case of "Pvt Ltd" (two suffixes).
  let prev;
  do {
    prev = s;
    s = s.replace(COMPANY_SUFFIX_RE, "").trim();
  } while (s !== prev);
  return s;
}

/**
 * Normalise a job title for deduplication matching.
 * - Lowercase, trim, collapse whitespace.
 * - Strip punctuation (hyphens, commas, parens, slashes, etc.).
 * - Seniority words (senior, junior, lead, staff, principal) are KEPT —
 *   a "Senior React Developer" is a different posting from "React Developer".
 */
export function normalizeJobTitle(title = "") {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, " ") // replace punctuation with spaces
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the deduplication composite key.
 *
 * Returns `"${normalizeCompany}::${normalizeJobTitle}"` when company is
 * non-blank, or `null` when company is blank/unknown.  A null key means the
 * document is left standalone in aggregations (not merged with anything).
 *
 * @param {string} companyName
 * @param {string} title
 * @returns {string|null}
 */
export function makeDedupeKey(companyName, title) {
  const co = normalizeCompany(companyName);
  if (!co) return null; // blank company → cannot dedupe reliably
  return `${co}::${normalizeJobTitle(title)}`;
}

// ── Reusable MongoDB pipeline stages for count-time deduplication ──────────
//
// Insert dedupeGroupStages() at the START of any pipeline that counts postings
// (before the existing $match / $group that does the real counting work).
//
// What it does:
//   1. $sort postedAt desc  → ensures the most-recent document wins the $group.
//   2. $group by dedupeKey  → collapses twin documents to ONE, keeping the
//      fields needed by every downstream stage.  When dedupeKey is null (blank
//      company) $ifNull falls back to the raw MongoDB _id so each such
//      document keeps its own group and is never accidentally merged.
//
// Invariant: with no JSearch data in the collection the output of these stages
// is IDENTICAL to the raw collection — counts will not change.

/**
 * Returns the two pipeline stages that deduplicate jobs at count time.
 *
 * @returns {object[]}  Two Mongoose/MongoDB aggregation stage objects.
 */
export function dedupeGroupStages() {
  return [
    // Newest posting wins (deterministic choice when twins exist).
    { $sort: { postedAt: -1 } },
    {
      $group: {
        // Blank-company docs each get their own group (no merging).
        _id: { $ifNull: ["$dedupeKey", { $toString: "$_id" }] },
        // Preserve every field a downstream stage might need.
        jobId:          { $first: "$_id" },
        companyName:    { $first: "$companyName" },
        normalizedRole: { $first: "$normalizedRole" },
        isRemote:       { $first: "$isRemote" },
        requiredSkills: { $first: "$requiredSkills" },
        salaryRange:    { $first: "$salaryRange" },
        location:       { $first: "$location" },
        postedAt:       { $first: "$postedAt" },
        title:          { $first: "$title" },
        redirectUrl:    { $first: "$redirectUrl" },
      },
    },
  ];
}
