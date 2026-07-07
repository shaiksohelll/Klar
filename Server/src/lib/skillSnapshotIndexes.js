import SkillSnapshot from "../models/SkillSnapshot.js";

// ── One-time, NON-FATAL SkillSnapshot index migration ──────────────────────
// The momentum feature relies on a PARTIAL capturedAt TTL index that only
// expires legacy velocity rows (those without a `date`). But an existing prod
// database still physically holds the OLD non-partial `capturedAt_1` TTL index
// created before this change — dropping it from the schema does NOT drop it from
// the server, so it would keep silently expiring day-bucketed momentum rows and
// destroy the data moat.
//
// This runs once at boot: it drops any capturedAt TTL index that is NOT partial,
// then (re)creates the schema-defined indexes and verifies the end state.
// Everything is wrapped so a migration failure LOGS but never aborts boot — the
// API must come up even if index maintenance hiccups.

// A capturedAt TTL index is "legacy / unsafe" when it indexes capturedAt, has a
// TTL (expireAfterSeconds), and has NO partialFilterExpression scoping it to
// legacy rows. Those are the ones that would expire momentum rows.
function isUnsafeCapturedAtTtl(idx) {
  const keys = Object.keys(idx.key || {});
  const isCapturedAtIndex = keys.length === 1 && keys[0] === "capturedAt";
  const hasTtl = typeof idx.expireAfterSeconds === "number";
  const hasPartial = idx.partialFilterExpression != null;
  return isCapturedAtIndex && hasTtl && !hasPartial;
}

// The schema now defines a `{ date: 1 }` TTL/range index. Any deployed DB that
// once had an OLD `{ date: -1 }` index (descending, from before this feature)
// still physically holds it — Mongo treats { date: 1 } and { date: -1 } as
// distinct indexes, so syncIndexes creates the new one while the obsolete
// descending one lingers. Detect it here so we can drop it (same guarded,
// idempotent pattern as the legacy capturedAt TTL cleanup). Scoped to a
// single-key descending `date` index only; the current ascending TTL is left be.
function isObsoleteDateDescIndex(idx) {
  const keys = Object.keys(idx.key || {});
  return keys.length === 1 && keys[0] === "date" && idx.key.date === -1;
}

// The schema now defines the day TTL index's partialFilterExpression as
// { date: { $type: "date" } }. An existing deployment that was created before
// this change still holds the OLD partialFilter { date: { $exists: true } }.
// MongoDB treats different partialFilterExpressions on the same key as distinct
// indexes, so syncIndexes alone cannot converge — the old one must be dropped
// explicitly before the new one can be created. Scoped to a single-key ascending
// `date` TTL with a partial filter that uses $exists (not $type).
function isStaleExistsDateTtl(idx) {
  const keys = Object.keys(idx.key || {});
  if (keys.length !== 1 || keys[0] !== "date") return false;
  if (typeof idx.expireAfterSeconds !== "number") return false;
  const pf = idx.partialFilterExpression;
  if (!pf || !pf.date) return false;
  // Stale if it uses $exists instead of $type.
  return pf.date.$exists != null && pf.date.$type == null;
}

/**
 * Ensure the SkillSnapshot capturedAt TTL index is the partial (safe) one.
 * Non-fatal: always resolves, never throws.
 *
 * @returns {Promise<{ ok: boolean, dropped: string[], error?: string }>}
 */
export async function ensureSkillSnapshotIndexes() {
  const dropped = [];
  try {
    const collection = SkillSnapshot.collection;

    // 1. Read the indexes currently on the deployed collection.
    let existing = [];
    try {
      existing = await collection.indexes();
    } catch (err) {
      // A brand-new collection has no indexes yet (namespace not found) — that
      // is fine; createIndexes below will build them from scratch.
      console.log(
        `SkillSnapshot index migration: no existing indexes to inspect (${err?.message})`,
      );
    }

    // 2. Drop any capturedAt TTL index that is NOT partial, and any obsolete
    //    descending { date: -1 } index left over from before the { date: 1 }
    //    TTL/range index existed. Both are guarded + idempotent (a missing
    //    index simply isn't found, and a failed drop only logs).
    for (const idx of existing) {
      if (isUnsafeCapturedAtTtl(idx) || isObsoleteDateDescIndex(idx) || isStaleExistsDateTtl(idx)) {
        try {
          await collection.dropIndex(idx.name);
          dropped.push(idx.name);
          console.log(
            `SkillSnapshot index migration: dropped obsolete index "${idx.name}"`,
          );
        } catch (err) {
          console.warn(
            `SkillSnapshot index migration: failed to drop "${idx.name}": ${err?.message}`,
          );
        }
      }
    }

    // 3. Create the schema-defined indexes (the partial TTL + unique { skill,
    //    date } + range indexes). syncIndexes drops indexes not in the schema
    //    and creates missing ones, converging the collection on the model spec.
    try {
      await SkillSnapshot.syncIndexes();
      console.log("SkillSnapshot index migration: schema indexes synced");
    } catch (err) {
      // Fall back to a non-destructive create if syncIndexes is unhappy (e.g. a
      // concurrent build). ensureIndexes only adds missing indexes.
      console.warn(
        `SkillSnapshot index migration: syncIndexes failed (${err?.message}); trying ensureIndexes`,
      );
      try {
        await SkillSnapshot.ensureIndexes();
        console.log("SkillSnapshot index migration: schema indexes ensured");
      } catch (err2) {
        console.warn(
          `SkillSnapshot index migration: ensureIndexes also failed: ${err2?.message}`,
        );
      }
    }

    // 4. Verify the end state: exactly ONE capturedAt TTL index and it is partial.
    try {
      const after = await collection.indexes();
      const capturedAtTtls = after.filter((idx) => {
        const keys = Object.keys(idx.key || {});
        return (
          keys.length === 1 &&
          keys[0] === "capturedAt" &&
          typeof idx.expireAfterSeconds === "number"
        );
      });
      const onlyOne = capturedAtTtls.length === 1;
      const isPartial = onlyOne && capturedAtTtls[0].partialFilterExpression != null;
      if (onlyOne && isPartial) {
        console.log(
          `SkillSnapshot index migration: OK — exactly one capturedAt TTL and it is partial ("${capturedAtTtls[0].name}")`,
        );
      } else {
        console.warn(
          `SkillSnapshot index migration: unexpected end state — ${capturedAtTtls.length} capturedAt TTL index(es), partial=${isPartial}`,
        );
      }
    } catch (err) {
      console.warn(
        `SkillSnapshot index migration: verification read failed: ${err?.message}`,
      );
    }

    return { ok: true, dropped };
  } catch (err) {
    // NON-FATAL by contract: log and swallow so boot always proceeds.
    console.warn("SkillSnapshot index migration failed:", err?.message);
    return { ok: false, dropped, error: err?.message };
  }
}
