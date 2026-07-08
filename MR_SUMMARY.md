# MR Summary — `fix/ingest-write-path-hardening`

Branch: `fix/ingest-write-path-hardening` (off `main`, NOT off `fix/skilldetail-type-guards`).

Hardens the two ingest write paths (`adzuna.js`, `jsearch.js`) against three
read-only-backend-audit findings. Both files share the same code shape and got
the same three fixes, each mirroring the proven pattern already live in
`Server/src/ingest/snapshot.js` (`recordDailySkillBuckets`). `snapshot.js` was
read as a reference ONLY and was NOT modified.

## Fixes

### Class 5 (P1) — `bulkWrite` has no error handling → partial-count surfacing
`Job.bulkWrite(ops, { ordered: false })` previously had no try/catch. On a
`BulkWriteError` (e.g. E11000 on the `{source, externalId}` unique index under
concurrent runs) the promise rejected: `upsertedCount`/`modifiedCount` were
never read, the run reported total failure, and the downstream snapshot +
`clear*Caches()` block was skipped.

Fix: wrap the bulkWrite in try/catch (mirroring `snapshot.js:275-295`). On a
BulkWriteError the partial result is read off `err.result`
(`upsertedCount ?? nUpserted`, `modifiedCount ?? nModified`,
`matchedCount ?? nMatched`), logged, surfaced in the return value via a new
`bulkWriteError` field, and execution CONTINUES to the prune + cache-clear
block. Only truly-unexpected (non-BulkWrite) errors rethrow. `{ ordered: false }`
is preserved.

- `Server/src/ingest/adzuna.js:157-183` (bulkWrite at `:160`, `bulkWriteError` returned at `:308`)
- `Server/src/ingest/jsearch.js:211-245` (bulkWrite at `:221`, `bulkWriteError` returned at `:325`)

### Class 12 (P1) — Unchunked `deleteMany` → batched delete in 500s
The single unbounded `Job.deleteMany({ source, updatedAt: { $lt: runStartedAt } })`
could hold a long-lived lock / spike WAL on a large `jobs` collection.

Fix: replace with the chunked-delete pattern from `snapshot.js:326-348`. The
EXACT stale-selection filter is preserved
(`{ source: "<adzuna|jsearch>", updatedAt: { $lt: runStartedAt } }`). Stale
`_id`s are gathered via `Job.find(filter).select("_id").lean()`, then deleted in
batches of 500 via `bulkWrite` of `deleteOne` ops, accumulating `deletedCount`
across batches with per-batch partial-success accounting
(`partial.deletedCount ?? partial.nRemoved`). Total `removed` is surfaced in the
return value.

- `Server/src/ingest/adzuna.js:193-224` (stale find at `:198`, batch loop `:205-223`)
- `Server/src/ingest/jsearch.js:258-290` (stale find at `:264`, batch loop `:271-289`)

### Class 1 (P1) — Missing ROI cache clear → all 9 caches invalidated
`ingestAdzuna`/`ingestJSearch` cleared 8 of the 9 `createTtlCache` caches but
missed `clearSkillGapRoiCache()` (`ROI_CACHE` in
`aggregations/skillGapRoi.js:53`). Stale "Learn Next" ROI recommendations were
served for up to 6h after every ingest.

Fix: import `clearSkillGapRoiCache` from `../aggregations/skillGapRoi.js`
(export confirmed at `skillGapRoi.js:56`) and call it alongside the existing
`clear*()` calls so all 9 caches are cleared.

- `Server/src/ingest/adzuna.js` — import `:15`, call `:301`
- `Server/src/ingest/jsearch.js` — import `:13`, call `:317`

### Greptile P1 — Fresh rows deleted by prune → full stale predicate in deleteOne
Between reading `staleIds` (via `Job.find({ source, updatedAt: { $lt: runStartedAt } })`)
and executing the batched `bulkWrite` of `deleteOne` ops, a concurrent ingest can
refresh a row (same `_id`, newer `updatedAt`). The original `_id`-only filter
(`deleteOne: { filter: { _id: doc._id } }`) still matched and deleted the
now-fresh row.

Fix: each `deleteOne` filter now carries the full stale predicate:
`{ _id: doc._id, source: "<adzuna|jsearch>", updatedAt: { $lt: runStartedAt } }`.
A refreshed row (`updatedAt >= runStartedAt`) no longer matches and is correctly
spared; `deletedCount` reflects only rows still stale at delete time.

- `Server/src/ingest/adzuna.js:208-216` — already had the full predicate (applied in prior commit)
- `Server/src/ingest/jsearch.js:273-281` — updated from bare `_id` to full predicate

### Greptile P1 — Prune failure silently reports success → pruneBatchFailures counter
When a delete-batch `bulkWrite` throws WITHOUT a usable partial `err.result`, the
catch block previously only logged and continued. The ingest function returned
success with `removed: 0` while stale rows remained — the failure was invisible.

Fix: accumulate a `pruneBatchFailures` counter (increment when a batch throws with
no usable partial result). Surface it in the return value as `pruneFailures`,
mirroring the `bulkWriteError` partial-count surfacing already in the file. The
run still proceeds to cache-clear (no abort), but the failure is now visible.

- `Server/src/ingest/adzuna.js:187,229,322` — already had the counter (applied in prior commit)
- `Server/src/ingest/jsearch.js:255,289,326` — added counter + surfaced in return

### CodeRabbit Major — Prune guard ignores `bulkWriteError` → wrongly prunes failed upserts
When `bulkWriteError` is set (a BulkWriteError with partial result), some jobs
whose upsert failed this run still have an old `updatedAt`. The prune guard
(`shouldPrune && errorCount === 0 && fetched > 0`) would match them as stale and
delete them. This silently removes data that the run failed to refresh.

Fix: add `!bulkWriteError` to the prune guard in BOTH ingesters:
`if (shouldPrune && !hadFailures && !bulkWriteError && fetched > 0)` (adzuna)
`if (shouldPrune && errorCount === 0 && !bulkWriteError && fetched > 0)` (jsearch).
The cache-clear block still runs unconditionally when `bulkWriteError` is set.

- `Server/src/ingest/adzuna.js:191-194` — guard + skip-warning updated
- `Server/src/ingest/jsearch.js:256-259` — guard + skip-warning updated

### CodeRabbit Minor — JSearch early-return shape incomplete
The missing-API-key early return (`!JSEARCH_API_KEY`) omitted `removed`,
`pruneFailures`, and `errors`, causing consumers to receive `undefined` for those
fields.

Fix: return the complete shape with all zero/empty defaults matching the full
return's field set: `{ requested: 0, fetched: 0, unique: 0, upserted: 0,
modified: 0, removed: 0, pruneFailures: 0, errors: 0, bulkWriteError: null }`.
Adzuna's missing-key path throws (not a return), so no change was needed there.

- `Server/src/ingest/jsearch.js:157` — early return now includes all 9 fields

## Tests

Existing tests updated + new tests added, matching the in-memory-Mongo +
stubbed-`fetch` mocking style.

`Server/src/ingest/adzuna.test.js` (now 11 tests):
1. **bulkWrite partial success (class 5)** — mocks `Job.bulkWrite` to throw a
   `BulkWriteError`; asserts the ingest RETURNS, `bulkWriteError` carries the
   partial counts, `clearSkillGapRoiCache` is still called, prune is SKIPPED
   (`removed === 0`, stale row survives).
2. **chunked delete >500 (class 12)** — seeds 1200 stale rows; asserts
   `removed === 1200` and exactly 3 deleteOne-batch `bulkWrite` calls
   (ceil(1200/500)).
3. **ROI cache clear on success (class 1)** — asserts `clearSkillGapRoiCache`
   is called on a normal successful run.
4. **concurrent refresh spares refreshed row** — seeds a stale row, simulates a
   concurrent ingest refreshing it (`updatedAt` bumped to now) between
   `staleIds` read and the delete batch; asserts the refreshed row is NOT
   deleted (`removed === 0`).
5. **prune failure surfaced in return value** — mocks the delete-batch
   `bulkWrite` to throw with no usable partial result; asserts the return
   reports `pruneFailures > 0` AND `clearSkillGapRoiCache` still runs.

`Server/src/ingest/jsearch.test.js` (now 10 tests):
- Same 5 production cases as adzuna (3 original + 2 concurrency), adapted to
  JSearch's full-sweep + sequential-fetch shape. The bulkWrite partial-success
  test now asserts prune is SKIPPED (stale row survives) matching adzuna.
- **return shape completeness (2 tests)**: (a) normal run returns every expected
  field with no `undefined` values, (b) static source read verifies the
  early-return literal includes all 9 canonical field names.

The ROI cache clear is spied via a module-level `vi.mock("../aggregations/skillGapRoi.js")`
(ESM live bindings are read-only, so a runtime spy can't observe the imported
`clearSkillGapRoiCache`).

## Verification

Full vitest suite (`cd Server; npm test` = `vitest run`):

```
 Test Files  26 passed (26)
      Tests  322 passed (322)
   Start at  14:37:15
   Duration  64.02s
```

All green — no regressions.

## Scope

- Edited ONLY: `Server/src/ingest/adzuna.js`, `Server/src/ingest/adzuna.test.js`,
  `Server/src/ingest/jsearch.js`, `Server/src/ingest/jsearch.test.js`, and this
  `MR_SUMMARY.md`.
- `Server/src/ingest/snapshot.js` was READ-ONLY reference — NOT modified.
- No other files touched.
- Not merged, not pushed, not committed.

