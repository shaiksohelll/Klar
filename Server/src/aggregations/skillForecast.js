import SkillSnapshot from "../models/SkillSnapshot.js";
import { getAllSkills } from "./trendingSkills.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { resolveRole } from "../lib/validate.js";

// ══ Skill-demand Forecast ("Foresight") ═════════════════════════════════════
// Descriptive Klar aggregations answer "what rose/fell" (momentum) and "what to
// learn now" (skill-gap ROI). This module is PREDICTIVE: for each candidate
// skill it fits a DETERMINISTIC ordinary-least-squares linear trend over its
// day-bucketed postingCount history (dayIndex -> postingCount) and projects
// demand `horizonMonths` into the future.
//
// It is intentionally a simple, fully-auditable statistical model — NOT a
// black-box "AI". Every input is real banked history; nothing is fabricated.
// The module reads shared inputs (getAllSkills for the candidate universe +
// current demand, SkillSnapshot for the series) but NEVER mutates their
// signatures or the snapshot schema. It never throws.

// ── History reading window ───────────────────────────────────────────────
const HISTORY_LOOKBACK_MONTHS = 12; // how far back we read the day-bucketed series to fit the trend
const DAYS_PER_MONTH = 30; // fixed day/month conversion for projecting the horizon (auditable, calendar-agnostic)

// ── Guards ──────────────────────────────────────────────────────
const MIN_POINTS_FOR_FORECAST = 4; // a skill with fewer distinct dated points is skipped (can't fit an honest line)
const CANDIDATE_POOL = 60; // how many top-demand skills to attempt a forecast for

// ── Trajectory thresholds (slope expressed as a fraction of current level/day) ─
// We normalise the daily slope by the current demand level so the label is
// scale-free: a +2 jobs/day slope means very different things at level 20 vs
// 2000. `dailyGrowth = slope / current`.
const RISING_DAILY_GROWTH = 0.001; // >= +0.1%/day of current level counts as rising
const ACCELERATING_DAILY_GROWTH = 0.004; // >= +0.4%/day is strong enough to call "accelerating"
const DECLINING_DAILY_GROWTH = -0.001; // <= -0.1%/day counts as declining; between the two = plateauing

// ── Confidence model (0..1) ─────────────────────────────────────────
// confidence = R² (goodness of fit) scaled by a points factor that ramps from 0
// at MIN_POINTS_FOR_FORECAST up to 1.0 once we have plenty of history — few
// points can fit a line perfectly (R²=1) yet mean little, so they are damped.
const CONFIDENCE_FULL_POINTS = 12; // at/above this many points the points-factor is 1.0
const BAND_Z = 1.0; // confidence-band half-width = BAND_Z * residual standard error (≈ 68% band)

// ── Cache ────────────────────────────────────────────────────
const FORECAST_TTL_MS = 6 * 60 * 60 * 1000; // 6h — same discipline as the other read caches
const FORECAST_CACHE = createTtlCache({ ttlMs: FORECAST_TTL_MS, maxEntries: 500 });

/** Clear the forecast cache. Exported for test isolation + future ingest hook. */
export function clearSkillForecastCache() {
  FORECAST_CACHE.clear();
}

// Clamp helper (kept local; never throws on junk input).
function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Ordinary least-squares fit of y = intercept + slope * x.
 * Returns { slope, intercept, r2, stdErr, n }.
 *   - r2     goodness of fit in [0,1] (0 when y has no variance).
 *   - stdErr residual standard error (sample std-dev of residuals); 0 for n<3.
 * Pure, deterministic, no external deps. Assumes xs.length === ys.length >= 2.
 */
export function linearFit(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // Degenerate x (all same day) — no trend is estimable.
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  // R² = explained / total variance. When y is constant (syy === 0) the line
  // fits perfectly by definition — report r2 = 1 for a flat series.
  let r2;
  if (syy === 0) {
    r2 = 1;
  } else {
    const ssRes = ys.reduce((acc, y, i) => {
      const pred = intercept + slope * xs[i];
      return acc + (y - pred) * (y - pred);
    }, 0);
    r2 = clamp(1 - ssRes / syy, 0, 1);
  }

  // Residual standard error: sqrt( SSres / (n - 2) ). Needs >= 3 points for a
  // meaningful denominator; below that we report 0 (band collapses to point).
  let stdErr = 0;
  if (n >= 3) {
    const ssRes = ys.reduce((acc, y, i) => {
      const pred = intercept + slope * xs[i];
      return acc + (y - pred) * (y - pred);
    }, 0);
    stdErr = Math.sqrt(ssRes / (n - 2));
  }

  return { slope, intercept, r2, stdErr, n };
}

// Classify a fitted trend into a trajectory label using named thresholds.
// `dailyGrowth` = slope / current (scale-free). current<=0 falls back to slope
// sign only (declining/plateauing/rising) since a growth ratio is undefined.
function classifyTrajectory(slope, current) {
  const dailyGrowth = current > 0 ? slope / current : (slope > 0 ? RISING_DAILY_GROWTH : slope < 0 ? DECLINING_DAILY_GROWTH : 0);
  if (dailyGrowth >= ACCELERATING_DAILY_GROWTH) return "accelerating";
  if (dailyGrowth >= RISING_DAILY_GROWTH) return "rising";
  if (dailyGrowth <= DECLINING_DAILY_GROWTH) return "declining";
  return "plateauing";
}

// Confidence in [0,1]: R² damped by how much history backs the fit.
function computeConfidence(r2, n) {
  const span = CONFIDENCE_FULL_POINTS - MIN_POINTS_FOR_FORECAST;
  const pointsFactor = span <= 0 ? 1 : clamp((n - MIN_POINTS_FOR_FORECAST) / span, 0, 1);
  return Math.round(clamp(r2 * pointsFactor, 0, 1) * 100) / 100;
}

/**
 * Compute demand forecasts for the top-demand candidate skills.
 *
 * @param {{ role?: string|null, horizonMonths?: number, limit?: number }} opts
 * @returns {Promise<{
 *   forecasts: Array<{
 *     skill, current, forecast, changePct, trajectory, confidence,
 *     low, high, basisPoints, horizonMonths
 *   }>,
 *   asOf: string|null,
 *   horizonMonths: number,
 *   insufficientHistory: boolean
 * }>}
 *   Always resolves; never throws.
 */
export async function computeSkillForecast({
  role = null,
  horizonMonths = 6,
  limit = 20,
} = {}) {
  const horizon = clamp(Math.round(Number(horizonMonths) || 6), 1, 24);
  const lim = clamp(Math.round(Number(limit) || 20), 1, 50);
  const normalizedRole = role ? resolveRole(role) : null;

  // Only cache KNOWN inputs (role known-or-null), same discipline as the other
  // read caches. An unknown role is computed but never cached.
  const roleKnownOrBlank = !role || normalizedRole !== null;
  const cacheKey = `${normalizedRole || "all"}:${horizon}:${lim}`;
  if (roleKnownOrBlank) {
    const hit = FORECAST_CACHE.get(cacheKey);
    if (hit) return hit;
  }

  const emptyResult = {
    forecasts: [],
    asOf: null,
    horizonMonths: horizon,
    insufficientHistory: true,
  };

  try {
    // Candidate universe + current demand come from the shared, cached
    // getAllSkills aggregation (items are { skill, demand, ... }, demand-desc).
    const allSkills = await getAllSkills({ months: HISTORY_LOOKBACK_MONTHS });
    const candidates = (allSkills || []).slice(0, CANDIDATE_POOL);
    if (candidates.length === 0) return emptyResult;
    const candidateSet = new Set(candidates.map((s) => s.skill));

    // Read the day-bucketed postingCount series for these skills over the
    // lookback window. Same snapshot-reading idiom as computeSkillMomentum
    // (filter on `date`, sort ascending, lean select) — shared code untouched.
    const since = new Date();
    since.setMonth(since.getMonth() - HISTORY_LOOKBACK_MONTHS);
    const rows = await SkillSnapshot.find({ date: { $gte: since } })
      .sort({ date: 1 })
      .select("skill date postingCount -_id")
      .lean();

    // Group into per-skill series of { t: dayIndex, y: postingCount }. dayIndex
    // is measured in whole days from the earliest observed date across the set,
    // so x is a small, well-conditioned integer axis shared by every skill.
    let earliestMs = Infinity;
    let latestMs = -Infinity;
    const rowsBySkill = new Map();
    for (const r of rows) {
      if (!candidateSet.has(r.skill)) continue;
      if (r.date == null || typeof r.postingCount !== "number") continue;
      const ms = r.date.getTime();
      if (ms < earliestMs) earliestMs = ms;
      if (ms > latestMs) latestMs = ms;
      if (!rowsBySkill.has(r.skill)) rowsBySkill.set(r.skill, []);
      rowsBySkill.get(r.skill).push({ ms, y: r.postingCount });
    }

    if (!Number.isFinite(earliestMs)) return emptyResult;
    const asOf = new Date(latestMs).toISOString();
    const MS_PER_DAY = 86_400_000;
    const dayIndex = (ms) => Math.round((ms - earliestMs) / MS_PER_DAY);
    const horizonDays = horizon * DAYS_PER_MONTH;
    const projectAtDay = dayIndex(latestMs) + horizonDays;

    const forecasts = [];
    for (const [skill, series] of rowsBySkill) {
      // Collapse to one reading per day (latest wins) so repeated same-day rows
      // don't over-weight a single day; then require MIN_POINTS distinct days.
      const byDay = new Map();
      for (const p of series) byDay.set(dayIndex(p.ms), p.y);
      if (byDay.size < MIN_POINTS_FOR_FORECAST) continue; // guard: too thin to forecast

      // Sort day indices ascending so the LAST reading is the most recent.
      const xs = [...byDay.keys()].sort((a, b) => a - b);
      const ys = xs.map((x) => byDay.get(x));
      const { slope, intercept, r2, stdErr, n } = linearFit(xs, ys);

      // `current` is the latest OBSERVED series level, so forecast / changePct /
      // trajectory all share one basis (getAllSkills demand only picks + orders
      // the candidate universe; it is NOT the forecast baseline).
      const current = ys[ys.length - 1];
      const rawForecast = intercept + slope * projectAtDay;
      const forecast = Math.max(0, Math.round(rawForecast)); // demand can't go negative

      // Confidence band from residual std error, clamped to >= 0.
      const halfBand = BAND_Z * stdErr;
      const low = Math.max(0, Math.round(rawForecast - halfBand));
      const high = Math.max(0, Math.round(rawForecast + halfBand));

      const changePct = current > 0 ? Math.round(((forecast - current) / current) * 100) : null;
      const trajectory = classifyTrajectory(slope, current);
      const confidence = computeConfidence(r2, n);

      forecasts.push({
        skill,
        current,
        forecast,
        changePct,
        trajectory,
        confidence,
        low,
        high,
        basisPoints: n,
        horizonMonths: horizon,
      });
    }

    if (forecasts.length === 0) return emptyResult;

    // Default sort: projected demand desc, tiebreak on confidence desc.
    forecasts.sort((a, b) => (b.forecast - a.forecast) || (b.confidence - a.confidence));
    const result = {
      forecasts: forecasts.slice(0, lim),
      asOf,
      horizonMonths: horizon,
      insufficientHistory: false,
    };
    if (roleKnownOrBlank) FORECAST_CACHE.set(cacheKey, result);
    return result;
  } catch (err) {
    // Never throw out of the forecaster; log and return the cold-start shape.
    console.warn("computeSkillForecast failed:", err?.message);
    return emptyResult;
  }
}
