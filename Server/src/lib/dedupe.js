// ── Shared cross-source deduplication helpers ────────────────────────────────
//
// A job that appears on BOTH Adzuna and JSearch must be counted ONCE in every
// aggregation. We achieve this NON-DESTRUCTIVELY: both raw documents are kept;
// deduplication happens at COUNT time via a stable composite key.
//
// Key: `${normalizeCompany(companyName)}::${normalizeJobTitle(title)}::${normalizeLocation(location)}`
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
 * Normalise a location string for deduplication matching.
 * - If blank/null, returns "" (location-unaware postings won't be excluded
 *   from matching; they'll just share a blank city segment).
 * - Lowercase, trim, take ONLY the first comma-separated segment (the city).
 * - Strip punctuation, collapse whitespace.
 * - Examples: "Pune, Maharashtra, India" → "pune"
 *             "Bangalore" → "bangalore"
 *             "" or null  → ""
 */
export function normalizeLocation(loc = "") {
  if (!loc) return "";
  const city = String(loc).split(",")[0]; // take the city segment
  return city
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the deduplication composite key.
 *
 * Returns `"${normalizeCompany}::${normalizeJobTitle}::${normalizeLocation}"`
 * when company is non-blank, or `null` when company is blank/unknown.
 * A null key means the document is left standalone in aggregations (not
 * merged with anything).
 *
 * Including location means "Acme Corp Backend Dev Mumbai" and
 * "Acme Corp Backend Dev Pune" are treated as distinct postings.
 *
 * @param {string} companyName
 * @param {string} title
 * @param {string} [location]
 * @returns {string|null}
 */
export function makeDedupeKey(companyName, title, location = "") {
  const co = normalizeCompany(companyName);
  if (!co) return null; // blank company → cannot dedupe reliably
  return `${co}::${normalizeJobTitle(title)}::${normalizeLocation(location)}`;
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
 * Returns the pipeline stages that deduplicate jobs at count time.
 *
 * Salary coherence: salaryDisclosed, salaryRange (and the currency embedded
 * within it) are picked together as ONE unit from the SAME source document
 * using $top with its own sort (prefer disclosed twin, then newest).  This
 * prevents pairing a "disclosed" flag from one twin with the salary range of
 * the other twin's undisclosed posting — a mismatch that would corrupt INR
 * salary averages.
 *
 * All non-salary fields continue to use $first on the postedAt:-1 sort, so
 * newest-wins semantics are unchanged for every other field.
 *
 * @returns {object[]}  Four Mongoose/MongoDB aggregation stage objects.
 */
export function dedupeGroupStages() {
  return [
    // Newest posting wins for non-salary fields (deterministic choice when twins exist).
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
        location:       { $first: "$location" },
        geo:            { $first: "$geo" },
        postedAt:       { $first: "$postedAt" },
        title:          { $first: "$title" },
        redirectUrl:    { $first: "$redirectUrl" },
        // ── Coherent salary pick ─────────────────────────────────────────────
        // salaryDisclosed, salaryRange (and the currency nested inside it) MUST
        // come from the same document.  $top's own sortBy (independent of the
        // pipeline $sort above) prefers the disclosed twin, then the newest, so
        // a disclosed posting always wins over an undisclosed one regardless of
        // which source posted first.
        _salaryPick: {
          $top: {
            sortBy: { salaryDisclosed: -1, postedAt: -1 },
            output: {
              salaryDisclosed: "$salaryDisclosed",
              salaryRange:     "$salaryRange",
            },
          },
        },
      },
    },
    // Flatten the coherent salary pick back to top-level fields so the output
    // shape is identical to what downstream stages expect.
    {
      $addFields: {
        salaryDisclosed: "$_salaryPick.salaryDisclosed",
        salaryRange:     "$_salaryPick.salaryRange",
      },
    },
    { $unset: "_salaryPick" },
  ];
}
