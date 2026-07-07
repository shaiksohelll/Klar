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
