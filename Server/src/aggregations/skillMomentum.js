import SkillSnapshot from "../models/SkillSnapshot.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { resolveRole } from "../lib/validate.js";

// ── Skill Momentum aggregation (Trends) ───────────────────────────────────
// Compares the most-recent window of day-bucketed snapshots against the
// immediately-prior window of equal length to surface which skills are rising
// vs falling. Reads ONLY the durable day-bucketed SkillSnapshot rows (those
// with a `date`); the ephemeral velocity rows are ignored here.
//
// NOTE ON ROLE: day-bucketed snapshots are recorded across ALL roles (there is
// no per-role snapshot dimension yet), so `role` currently does not sub-filter
// the series. It is still accepted + validated + used in the cache key so the
// endpoint contract is stable and a future per-role snapshot can slot in without
// an API change. Unknown roles are rejected by the route before reaching here.

const MOMENTUM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MOMENTUM_CACHE = createTtlCache({ ttlMs: MOMENTUM_TTL_MS, maxEntries: 500 });

/** Clear the momentum cache. Called by both ingesters after a successful run. */
export function clearMomentumCache() {
  MOMENTUM_CACHE.clear();
}

// Percentage delta from `prev` to `curr`, rounded. Returns null when there is
// no valid baseline (prev is 0/absent) so callers can render — instead of ∞.
function pctDelta(curr, prev) {
  if (prev == null || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
}

/**
 * Build the per-skill momentum list plus topRisers / topFallers.
 *
 * @param {{ windowMonths?: number, role?: string|null, limit?: number }} opts
 * @returns {Promise<{
 *   risers: Array<object>, fallers: Array<object>,
 *   asOf: string|null, insufficientHistory: boolean
 * }>}
 */
export async function computeSkillMomentum({
  windowMonths = 3,
  role = null,
  limit = 20,
} = {}) {
  const win = Math.min(Math.max(Number(windowMonths) || 3, 1), 24);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const normalizedRole = role ? resolveRole(role) : null;

  // Only cache KNOWN roles (or the unfiltered "all"). An unrecognised role
  // value is still computed + returned, but never written to the cache — same
  // discipline as the trending / salary caches.
  const cacheable = !role || normalizedRole !== null;
  const cacheKey = `${normalizedRole || "all"}:${win}:${lim}`;
  if (cacheable) {
    const hit = MOMENTUM_CACHE.get(cacheKey);
    if (hit) return hit;
  }

  // Latest banked day-bucket. If there are no day-bucketed rows at all, history
  // has not started — return the insufficientHistory cold-start shape.
  const latest = await SkillSnapshot.findOne({ date: { $type: "date" } })
    .sort({ date: -1 })
    .select("date -_id")
    .lean();

  if (!latest) {
    const result = { risers: [], fallers: [], asOf: null, insufficientHistory: true };
    if (cacheable) MOMENTUM_CACHE.set(cacheKey, result);
    return result;
  }

  const asOfDate = latest.date;
  // Current window: (currStart, asOf]. Prior window: (prevStart, currStart].
  const currStart = new Date(asOfDate);
  currStart.setMonth(currStart.getMonth() - win);
  const prevStart = new Date(currStart);
  prevStart.setMonth(prevStart.getMonth() - win);

  // Pull both windows in parallel. For each skill in a window we take the
  // LATEST row within that window (its most representative reading), so a skill
  // present on multiple days collapses to one current + one previous value.
  const [currRows, prevRows] = await Promise.all([
    SkillSnapshot.find({ date: { $gt: currStart, $lte: asOfDate } })
      .sort({ date: 1 })
      .select("skill date postingCount salaryMidpointMedian -_id")
      .lean(),
    SkillSnapshot.find({ date: { $gt: prevStart, $lte: currStart } })
      .sort({ date: 1 })
      .select("skill date postingCount salaryMidpointMedian -_id")
      .lean(),
  ]);

  // Collapse each window to one reading per skill (latest date wins because we
  // sorted ascending and overwrite).
  const collapse = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.skill, r);
    return m;
  };
  const currMap = collapse(currRows);
  const prevMap = collapse(prevRows);

  // Insufficient history: we need at least two comparable periods. If the prior
  // window has no rows at all, we cannot compute rising/falling — return current
  // demand with insufficientHistory:true and direction "new" (never throw).
  if (prevMap.size === 0) {
    const current = [...currMap.values()]
      .map((r) => ({
        skill: r.skill,
        current: r.postingCount ?? 0,
        previous: 0,
        deltaAbs: r.postingCount ?? 0,
        deltaPct: null,
        direction: "new",
        salaryDeltaPct: null,
      }))
      .sort((a, b) => b.current - a.current)
      .slice(0, lim);
    const result = {
      risers: current,
      fallers: [],
      asOf: asOfDate.toISOString(),
      insufficientHistory: true,
    };
    if (cacheable) MOMENTUM_CACHE.set(cacheKey, result);
    return result;
  }

  // Union of skills across both windows.
  const skills = new Set([...currMap.keys(), ...prevMap.keys()]);
  const items = [];
  for (const skill of skills) {
    const c = currMap.get(skill);
    const p = prevMap.get(skill);
    const current = c?.postingCount ?? 0;
    const previous = p?.postingCount ?? 0;
    const deltaAbs = current - previous;

    let direction;
    let deltaPct;
    if (previous === 0 && current > 0) {
      direction = "new";
      deltaPct = null;
    } else {
      deltaPct = pctDelta(current, previous);
      if (deltaPct === null) direction = "flat";
      else if (deltaPct > 0) direction = "rising";
      else if (deltaPct < 0) direction = "falling";
      else direction = "flat";
    }

    // salaryDeltaPct from disclosed INR medians only; null when either side
    // lacks a median (never fabricate a comparison).
    const salaryDeltaPct =
      c?.salaryMidpointMedian != null && p?.salaryMidpointMedian != null
        ? pctDelta(c.salaryMidpointMedian, p.salaryMidpointMedian)
        : null;

    items.push({
      skill,
      current,
      previous,
      deltaAbs,
      deltaPct,
      direction,
      salaryDeltaPct,
    });
  }

  // topRisers: rising + new, strongest gain first (new sorts by absolute gain).
  const risers = items
    .filter((i) => i.direction === "rising" || i.direction === "new")
    .sort((a, b) => {
      const ap = a.deltaPct ?? Number.POSITIVE_INFINITY; // "new" outranks finite gains
      const bp = b.deltaPct ?? Number.POSITIVE_INFINITY;
      if (bp !== ap) return bp - ap;
      return b.deltaAbs - a.deltaAbs;
    })
    .slice(0, lim);

  // topFallers: falling, steepest drop first.
  const fallers = items
    .filter((i) => i.direction === "falling")
    .sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0))
    .slice(0, lim);

  const result = {
    risers,
    fallers,
    asOf: asOfDate.toISOString(),
    insufficientHistory: false,
  };
  if (cacheable) MOMENTUM_CACHE.set(cacheKey, result);
  return result;
}
