// ── Percentile-based salary tone ─────────────────────────────────────────────
// The leaderboard encodes salary as a SECONDARY channel (color), ranked as a
// percentile across the currently-visible set — so it is currency-agnostic
// (we never compare absolute INR vs USD, only relative position within view).
//
// The ramp stays on-palette: it walks the accent-red hue from a dull, low-sat
// "cool" band (low pay) to a vivid, bright band (high pay). Absence of salary
// data is rendered as a neutral tone by the caller, and color is NEVER the
// only signal (the salary column shows the number or an em-dash too).

/**
 * Build a percentile lookup for a set of skills.
 * @param {Array<{id:string, avgSalary:number|null}>} skills
 * @returns {Map<string, number>} id → percentile in [0,1] (only for disclosed)
 */
export function buildSalaryPercentiles(skills) {
  const withSalary = skills
    .filter((s) => s.avgSalary != null && isFinite(s.avgSalary))
    .map((s) => ({ id: s.id, v: s.avgSalary }))
    .sort((a, b) => a.v - b.v);

  const map = new Map();
  const n = withSalary.length;
  if (n === 0) return map;
  if (n === 1) {
    map.set(withSalary[0].id, 1);
    return map;
  }
  withSalary.forEach((s, i) => map.set(s.id, i / (n - 1)));
  return map;
}

/**
 * Map a percentile [0,1] (or null for "no salary data") to CSS colors for the
 * demand bar: a fill and a brighter leading edge. Returns neutral tones when
 * pct is null so undisclosed skills are visually distinct but calm.
 * @param {number|null} pct
 */
export function salaryTone(pct) {
  if (pct == null) {
    return {
      fill: "rgba(120,120,132,0.16)",
      edge: "rgba(120,120,132,0.55)",
      dot: "var(--muted-2)",
    };
  }
  // Accent hue ≈ 350°. Ramp saturation 42→100 and lightness 40→56 with pct.
  const hue = 350;
  const sat = Math.round(42 + pct * 58);
  const light = Math.round(40 + pct * 16);
  const fillAlpha = (0.14 + pct * 0.24).toFixed(3);
  return {
    fill: `hsla(${hue}, ${sat}%, ${light}%, ${fillAlpha})`,
    edge: `hsl(${hue}, ${sat}%, ${light + 6}%)`,
    dot: `hsl(${hue}, ${sat}%, ${light + 6}%)`,
  };
}
