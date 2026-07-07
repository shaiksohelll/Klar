# MR Summary — fix/skilldetail-type-guards

Scope: harden the `baseMatch` in the skill-detail route so malformed docs imported
via direct Mongo writes / `bulkWrite` (which skip Mongoose validation) cannot crash
the user-facing `GET /api/skill/:name` route or silently skew co-occurrence counts.

> **Path note:** the audit referred to `Server/src/aggregations/skillDetail.js`,
> but that module does not exist — the `baseMatch`, the `$dateToString` trend stage,
> and the `$unwind "$requiredSkills"` co-occurrence pipeline all live in
> `Server/src/routes/skillDetail.js` (audit line numbers 60 / 106 / 94 match that
> file exactly). The fix and tests are applied there.

## Fixes

| Audit class | Severity | File:line | Change |
| --- | --- | --- | --- |
| Time-field correctness — non-Date `postedAt` throws inside `$dateToString` | P0 | `Server/src/routes/skillDetail.js:68` | `postedAt: { $type: "date", $gte: since }` — adds `$type: "date"` alongside the preserved `$gte: since` so the trend stage's `$dateToString` never receives a non-Date. Mirrors `ingest/snapshot.js:215`. |
| Unguarded `$unwind` — non-array `requiredSkills` miscounts co-occurrence | P1 | `Server/src/routes/skillDetail.js:67` | `requiredSkills: { $eq: name, $type: "array", $ne: [] }` — adds `$type: "array"` + `$ne: []` while preserving the existing array-contains name match (explicit `$eq: name` form of the original `requiredSkills: name` shorthand). Mirrors `ingest/snapshot.js:216`. |

Only `baseMatch` was changed; `windowMatch` and all other route logic are untouched.
Behavior is unchanged for well-formed docs (a valid `Date` / `String[]` passes both guards).

## Tests (`Server/src/routes/skillDetail.test.js`)

The file's existing months-clamp tests use a mocked `Job` + supertest. The mock's
`aggregate` spy was extended (via `importOriginal`) to optionally delegate to the
**real** model against an in-memory Mongo (`LIVE_DB` flag), so the new cases run the
actual `$dateToString` / `$unwind` stages. Malformed docs are inserted through the
**raw** collection (`mongoose.connection.collection("jobs").insertOne`) to bypass
Mongoose validation — exactly the bulkWrite scenario the audit describes.

- `excludes a doc whose postedAt is a STRING so $dateToString never throws` — inserts
  a doc with `postedAt: "2024-01-15"` (string); asserts no throw (200), the doc is
  excluded from `demand`, and `baseMatch` carries `postedAt.$type === "date"`.
- `excludes a doc whose requiredSkills is a NON-ARRAY so $unwind never miscounts` —
  inserts a doc with `requiredSkills: "react"` (string); asserts no throw, `demand`
  stays at 1 (would be 2 without the guard), `node.js` co-occurrence stays at 1, and
  `baseMatch` carries `requiredSkills.$type === "array"` + `$eq === "react"`.

## Verification

`cd Server; npm test` → **25 test files passed (25), 301 tests passed (301)**.
`skillDetail.test.js` alone → **6 passed (6)** (4 pre-existing clamp tests + 2 new).

No merge, no push, no commit. Branch `fix/skilldetail-type-guards` (off `main`).

---

## Follow-up fixes (round 2) — windowMatch denominator + skillPairs $match guard

Two follow-up P1 findings (codeant + greptile) on the same branch. Scope remains
ESM-only: `Server/src/routes/skillDetail.js`, `Server/src/aggregations/skillPairs.js`,
and `Server/src/routes/skillDetail.test.js`. **`baseMatch` was NOT touched.**

### Fixes

| Review source | Severity | File:line | Change |
| --- | --- | --- | --- |
| codeant | P1 — `windowMatch` denominator | `Server/src/routes/skillDetail.js:77` | `windowMatch` (the `totalJobs` share denominator) was `{ postedAt: { $gte: since } }`. A doc with a valid Date `postedAt` but a non-array `requiredSkills` was excluded from `demand` (by `baseMatch`) yet still counted in `totalJobs`, skewing `share` downward. Now `{ postedAt: { $type: "date", $gte: since }, requiredSkills: { $type: "array" } }`. CRITICAL: `requiredSkills` uses `$type: "array"` ONLY — no `$ne: []` — so a well-formed job that legitimately lists zero skills still counts toward the denominator, preserving existing share semantics. |
| greptile | P1 — `skillPairs` `$match` guard | `Server/src/aggregations/skillPairs.js:51` (baseCount) and `:65` (pairs pipeline) | Both `$match` stages used a bare `requiredSkills: normalized` (shorthand `$eq`), which matches a non-array string field equal to `normalized`. A malformed doc (string `requiredSkills`) could enter the pipeline and be silently miscounted by the subsequent `$unwind "$requiredSkills"` (MongoDB treats a non-array scalar as a single-element array). Replaced with `requiredSkills: { $type: "array", $ne: [], $in: [normalized] }` in BOTH stages — dropping only malformed (non-array) docs while preserving array-contains semantics. No `postedAt` guard added: this path is window-independent by design. All other semantics (cache key, `$unwind`, `$group`, `$project`, `$count`) unchanged. |

### Tests (`Server/src/routes/skillDetail.test.js`)

All existing tests (4 months-clamp + 2 prior `baseMatch` type-guard regressions)
remain intact. One NEW case added inside the `baseMatch type guards` describe block:

- `excludes a non-array requiredSkills doc from the totalJobs denominator (windowMatch)` —
  inserts via the raw collection (bypassing Mongoose validation) a doc with a VALID
  Date `postedAt` but a STRING `requiredSkills` (`"react"`) alongside a well-formed
  doc (valid Date + `["react","node.js"]`). Asserts: status 200 (no throw),
  `demand === 1` (malformed doc excluded by `baseMatch`), `totalJobs === 1`
  (malformed doc ALSO excluded from the denominator by `windowMatch` — would be 2
  without the guard), `share === 100` (not the skewed 50%), and `node.js`
  co-occurrence === 1 (never inflated by the malformed doc). This is the regression
  for the codeant `windowMatch` fix.

Note: `getSkillPairs` is mocked at the route level (existing test harness), so the
greptile `skillPairs` guard is covered by the code change itself rather than a
direct route assertion. No `skillPairs.test.js` exists to extend, and creating a
new test file is outside the declared edit scope, so the guard stands on its code
correctness.

### Verification

`cd Server; npm test` → **25 test files passed (25), 302 tests passed (302)**, duration 43.35s.
`skillDetail.test.js` alone → **7 passed (7)** (4 clamp + 2 prior guard + 1 new windowMatch).

No merge, no push, no commit. Branch `fix/skilldetail-type-guards` (off `main`), unchanged.
