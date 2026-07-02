import { getAllSkills } from "./trendingSkills.js";
import { getSkillPairs } from "./skillPairs.js";
import { getSalaryInsights } from "./salaryInsights.js";
import { computeSkillMomentum } from "./skillMomentum.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { resolveSkill, resolveRole } from "../lib/validate.js";
import { SKILL_ALIASES } from "../lib/skills.js";

// ══ Skill-Gap ROI scoring (the "Learn Next" brain) ═══════════════════════════
// Fuses three EXISTING Klar assets — live momentum, disclosed-INR salary lift,
// and skill co-occurrence — into one transparent, explainable score per candidate
// skill the user does not already know. This module ONLY reads those shared
// aggregations; it never mutates their signatures or response shapes.
//
// The score is a simple weighted SUM of four normalized (0..1) factors. Every
// weight and cap is a NAMED constant below with a one-line comment so the
// ranking is auditable and tunable — there are no magic numbers inline.

// ── Scoring weights (must sum to 1.0 for an interpretable 0..1 roiScore) ─────
const W_DEMAND = 0.30; // how many jobs want the skill right now (raw market size)
const W_MOMENTUM = 0.25; // is the skill rising? (future-proofing the choice)
const W_SALARY = 0.25; // how much more it pays vs the user's current baseline
const W_AFFINITY = 0.20; // how adjacent it is to what they know (learnability/payoff speed)

// ── Normalization caps (values at/above the cap map to a normalized 1.0) ─────
const MOMENTUM_CAP_PCT = 50; // +50% growth (or more) is treated as maximal momentum
const SALARY_LIFT_CAP_PCT = 60; // +60% median lift (or more) is treated as maximal lift

// ── Badge thresholds (below these, the factor is real but not worth a badge) ──
const MOMENTUM_BADGE_MIN_PCT = 5; // only badge momentum once it is clearly rising
const SALARY_BADGE_MIN_PCT = 3; // only badge salary lift once it is clearly positive
const AFFINITY_BADGE_MIN = 1; // only badge affinity once there is any real co-occurrence

// ── Operational limits ───────────────────────────────────────────────
const MOMENTUM_WINDOW_MONTHS = 3; // window handed to computeSkillMomentum for deltaPct
const MOMENTUM_FETCH_LIMIT = 50; // top risers+fallers to pull for the momentum lookup map
const PAIRS_PER_SKILL = 12; // co-occurring partners to pull per known skill
const CANDIDATE_POOL = 60; // how many top-demand skills to consider as candidates

// ── Cache ────────────────────────────────────────────────────
const ROI_TTL_MS = 6 * 60 * 60 * 1000; // 6h — same as the other read caches
const ROI_CACHE = createTtlCache({ ttlMs: ROI_TTL_MS, maxEntries: 500 });

/** Clear the ROI cache. Exported for test isolation + future ingest hook. */
export function clearSkillGapRoiCache() {
  ROI_CACHE.clear();
}

// Reverse alias map: canonical -> [alias, ...]. Built once. Used so that when a
// user knows a canonical skill we also exclude every alias that resolves to it
// (and vice-versa) from the candidate set.
const ALIASES_BY_CANONICAL = (() => {
  const m = new Map();
  for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
    if (!m.has(canonical)) m.set(canonical, []);
    m.get(canonical).push(alias);
  }
  return m;
})();

// Expand a canonical skill to itself + all of its aliases (for exclusion).
function withAliases(canonical) {
  return [canonical, ...(ALIASES_BY_CANONICAL.get(canonical) || [])];
}

// Clamp a value into [0, 1].
function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Median of a numeric array (linear interpolation). null for empty input.
function median(nums) {
  const s = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = (s.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return lo === hi ? s[lo] : (s[lo] + s[hi]) / 2;
}

// Disclosed-INR median for a skill from getSalaryInsights, or null if none.
// Salary rules are owned by getSalaryInsights; we only READ the INR bucket.
async function inrMedianForSkill(skill, months) {
  const data = await getSalaryInsights({ skill, months });
  const inr = (data.byCurrency || []).find((b) => b.currency === "INR");
  return inr && inr.count > 0 ? inr.median : null;
}

// Format an INR amount as a compact "₹X.YL" (lakhs) string for a badge.
function formatInrLakh(amount) {
  const lakh = amount / 100000;
  const rounded = lakh >= 10 ? Math.round(lakh) : Math.round(lakh * 10) / 10;
  return `₹${rounded}L`;
}

/**
 * Compute ranked "Learn Next" recommendations for a user.
 *
 * @param {{ knownSkills?: string[], role?: string|null, limit?: number, months?: number }} opts
 * @returns {Promise<{
 *   recommendations: Array<{
 *     skill, roiScore, demand, momentumPct, salaryLiftPct, affinity, reasons: string[]
 *   }>,
 *   asOf: string|null,
 *   basedOn: { knownSkillCount: number, role: string|null },
 *   insufficientData: boolean
 * }>}
 *   Always resolves; never throws.
 */
export async function computeSkillGapRoi({
  knownSkills = [],
  role = null,
  limit = 12,
  months = 12,
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const normalizedRole = role ? resolveRole(role) : null;

  // Resolve + dedupe the user's known skills to canonical taxonomy form; drop
  // anything unrecognised (we never 500 on junk input).
  const knownCanonical = [
    ...new Set(
      (Array.isArray(knownSkills) ? knownSkills : [])
        .map((s) => resolveSkill(s))
        .filter(Boolean),
    ),
  ];

  const emptyResult = {
    recommendations: [],
    asOf: null,
    basedOn: { knownSkillCount: knownCanonical.length, role: normalizedRole },
    insufficientData: true,
  };

  // Cache only KNOWN inputs (all known skills canonical + role known-or-null),
  // same discipline as the trending/salary/pairs caches. The key is a STABLE
  // hash: sorted canonical skills + role + limit.
  const roleKnownOrBlank = !role || normalizedRole !== null;
  const cacheable = roleKnownOrBlank; // knownCanonical is already all-canonical
  const cacheKey = `${[...knownCanonical].sort().join(",")}|${normalizedRole || "all"}|${lim}|${months}`;
  if (cacheable) {
    const hit = ROI_CACHE.get(cacheKey);
    if (hit) return hit;
  }

  try {
    const knownSet = new Set(knownCanonical.flatMap(withAliases));

    // ── Pull every input in parallel (all are independently cached) ─────────
    const [allSkills, momentum, pairResults, baselineMedians] = await Promise.all([
      getAllSkills({ months }),
      computeSkillMomentum({ windowMonths: MOMENTUM_WINDOW_MONTHS, role: normalizedRole, limit: MOMENTUM_FETCH_LIMIT }),
      Promise.all(knownCanonical.map((s) => getSkillPairs(s, { limit: PAIRS_PER_SKILL }))),
      // User's salary baseline = median of the disclosed-INR medians of the
      // skills they already know (only skills that HAVE an INR median count).
      Promise.all(knownCanonical.map((s) => inrMedianForSkill(s, months))),
    ]);

    // momentum deltaPct lookup: merge risers + fallers (both carry deltaPct).
    const momentumPctBySkill = new Map();
    for (const it of [...(momentum.risers || []), ...(momentum.fallers || [])]) {
      if (typeof it.deltaPct === "number") momentumPctBySkill.set(it.skill, it.deltaPct);
    }

    // affinity: sum co-occurrence PERCENTAGE across the user's known skills, and
    // remember which known skill drove the strongest pairing (for the badge).
    const affinityBySkill = new Map(); // candidate -> total percentage
    const topPartnerBySkill = new Map(); // candidate -> { known, percentage }
    for (let i = 0; i < pairResults.length; i++) {
      const known = knownCanonical[i];
      for (const p of pairResults[i].pairs || []) {
        if (knownSet.has(p.skill)) continue; // never recommend something they know
        affinityBySkill.set(p.skill, (affinityBySkill.get(p.skill) || 0) + p.percentage);
        const best = topPartnerBySkill.get(p.skill);
        if (!best || p.percentage > best.percentage) {
          topPartnerBySkill.set(p.skill, { known, percentage: p.percentage });
        }
      }
    }

    // Baseline salary: median of the user's known-skill INR medians (skills with
    // no disclosed INR data are simply absent). null when we have no baseline.
    const baseline = median((baselineMedians || []).filter((n) => typeof n === "number"));

    // ── Candidate set: top-demand skills the user does NOT already know ──────
    const candidatePool = (allSkills || [])
      .filter((s) => !knownSet.has(s.skill))
      .slice(0, CANDIDATE_POOL);

    if (candidatePool.length === 0) {
      const result = { ...emptyResult, asOf: momentum.asOf ?? null };
      if (cacheable) ROI_CACHE.set(cacheKey, result);
      return result;
    }

    // Demand normalization base: the largest demand in the candidate pool.
    const maxDemand = Math.max(...candidatePool.map((s) => s.demand || 0), 1);
    // Affinity normalization base: the largest accumulated percentage seen.
    const maxAffinity = Math.max(0, ...[...affinityBySkill.values()]);

    // Salary-lift lookup for candidates is another parallel batch (INR medians).
    const candidateMedians = await Promise.all(
      candidatePool.map((s) => inrMedianForSkill(s.skill, months)),
    );

    // ── Score each candidate ────────────────────────────────────────
    const scored = candidatePool.map((s, idx) => {
      const demand = s.demand || 0;
      const demandNorm = clamp01(demand / maxDemand);

      // momentum — only positive growth contributes to ROI; missing => 0.
      const momentumPct = momentumPctBySkill.has(s.skill)
        ? momentumPctBySkill.get(s.skill)
        : null;
      const momentumNorm = momentumPct != null
        ? clamp01(momentumPct / MOMENTUM_CAP_PCT)
        : 0;

      // salaryLift — candidate INR median vs the user's INR baseline; missing
      // median or missing baseline => 0 (never fabricated).
      const candMedian = candidateMedians[idx];
      let salaryLiftPct = null;
      if (candMedian != null && baseline != null && baseline > 0) {
        salaryLiftPct = Math.round(((candMedian - baseline) / baseline) * 100);
      }
      const salaryNorm = salaryLiftPct != null
        ? clamp01(salaryLiftPct / SALARY_LIFT_CAP_PCT)
        : 0;

      // affinity — accumulated co-occurrence percentage, normalized to the pool.
      const affinity = affinityBySkill.get(s.skill) || 0;
      const affinityNorm = maxAffinity > 0 ? clamp01(affinity / maxAffinity) : 0;

      const roiScore =
        W_DEMAND * demandNorm +
        W_MOMENTUM * momentumNorm +
        W_SALARY * salaryNorm +
        W_AFFINITY * affinityNorm;

      // ── reasons[] — human-readable WHY badges; omit any factor that is absent
      //    or below its badge threshold (so we never show a hollow/fake badge).
      const reasons = [];
      if (momentumPct != null && momentumPct >= MOMENTUM_BADGE_MIN_PCT) {
        reasons.push(`📈 rising ${momentumPct}%`);
      }
      if (salaryLiftPct != null && salaryLiftPct >= SALARY_BADGE_MIN_PCT && candMedian != null && baseline != null) {
        reasons.push(`💰 +${formatInrLakh(candMedian - baseline)} median`);
      }
      const partner = topPartnerBySkill.get(s.skill);
      if (partner && partner.percentage >= AFFINITY_BADGE_MIN) {
        reasons.push(`🔗 pairs with your ${partner.known}`);
      }

      return {
        skill: s.skill,
        roiScore: Math.round(roiScore * 1000) / 1000, // 3-dp, stable + comparable
        demand,
        momentumPct, // real value (may be null); UI decides how to render
        salaryLiftPct, // real value (may be null)
        affinity, // accumulated co-occurrence percentage (0 when none)
        reasons,
      };
    });

    // Sort by roiScore desc, tiebreak on demand desc for stability.
    scored.sort((a, b) => (b.roiScore - a.roiScore) || (b.demand - a.demand));
    const recommendations = scored.slice(0, lim);

    // insufficientData only when there is genuinely nothing to recommend.
    const insufficientData = recommendations.length === 0;

    const result = {
      recommendations,
      asOf: momentum.asOf ?? null,
      basedOn: { knownSkillCount: knownCanonical.length, role: normalizedRole },
      insufficientData,
    };
    if (cacheable) ROI_CACHE.set(cacheKey, result);
    return result;
  } catch (err) {
    // Never throw out of the recommender; log and return the cold-start shape.
    console.warn("computeSkillGapRoi failed:", err?.message);
    return emptyResult;
  }
}
