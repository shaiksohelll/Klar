import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Window for every fetch on this page. Kept constant so the cache key
// (`${skill}:12`) and the API params stay in sync.
const MONTHS = 12;

// Maximum number of skills that can be compared at once. Minimum to render
// the comparison is 2.
const MAX_SKILLS = 3;

// Fixed palette — index N is assigned to the Nth selected skill and reused
// for its chip, column accent and trend line.
const PALETTE = ["#EB0029", "#3B82F6", "#10B981"];

// ── Salary formatting (mirrors SkillDrawer.jsx) ───────────────────────────────
function currencySymbol(code) {
  if (code === "INR") return "\u20B9";
  if (code === "USD") return "$";
  if (code === "GBP") return "\u00A3";
  if (code === "EUR") return "\u20AC";
  return code ? `${code} ` : "";
}

function fmtSalary(n, currency) {
  if (n == null || !isFinite(n)) return "\u2014";
  if (currency === "INR") {
    const l = n / 100000;
    return l >= 1
      ? `${l % 1 === 0 ? l : l.toFixed(1)}L`
      : `${Math.round(n / 1000)}K`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

// Turn a "YYYY-MM" key into a short month label, e.g. "2024-03" -> "Mar".
function monthLabel(ym) {
  const parts = String(ym).split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  return d.toLocaleString("en", { month: "short" });
}

// Round a 0..1 rate (or already-percent value) to a whole percent. The salary
// endpoint returns disclosureRate as a 0..1 fraction (see SkillDrawer.jsx).
function ratePct(rate) {
  return Math.round((rate ?? 0) * 100);
}

// ── Chart geometry ────────────────────────────────────────────────────────────
const CHART_W = 720; // viewBox width — SVG scales to its container via width=100%
const CHART_H = 220; // viewBox height
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 26; // room for month labels
const GRID_LINES = 4;

/**
 * MultiTrendChart — single inline SVG overlaying one polyline per skill.
 * Reuses the visual language of "Postings Over Time" in SkillDrawer.jsx:
 * subtle #26262E gridlines, font-mono text-[10px] text-[#5C5C66] labels.
 * No charting library.
 *
 * Props:
 *   series — [{ key, color, points: [{ month, count }] }] (already filtered to
 *            trend.length > 1)
 *   months — sorted union of all month keys (shared x-axis)
 */
function MultiTrendChart({ series, months }) {
  const shouldReduceMotion = useReducedMotion();

  const maxCount = useMemo(() => {
    let m = 0;
    for (const s of series) {
      for (const p of s.points) if (p.count > m) m = p.count;
    }
    return m || 1;
  }, [series]);

  const plotW = CHART_W - PAD_L - PAD_R;
  const plotH = CHART_H - PAD_T - PAD_B;

  // x position for a month index. Guard the single-point case (months.length
  // could be 1 even though each series has >1 point if they don't overlap).
  const xFor = useCallback(
    (i) =>
      PAD_L + (months.length <= 1 ? plotW / 2 : (i / (months.length - 1)) * plotW),
    [months.length, plotW],
  );
  // y position for a count value (0 at bottom, maxCount at top).
  const yFor = useCallback(
    (count) => PAD_T + plotH - (count / maxCount) * plotH,
    [maxCount, plotH],
  );

  // Build a polyline points string for one series, treating a missing month
  // as 0 so every line spans the full shared x-axis.
  const lineFor = useCallback(
    (points) => {
      const byMonth = new Map(points.map((p) => [p.month, p.count]));
      return months
        .map((m, i) => `${xFor(i).toFixed(1)},${yFor(byMonth.get(m) ?? 0).toFixed(1)}`)
        .join(" ");
    },
    [months, xFor, yFor],
  );

  const gridYs = useMemo(
    () =>
      Array.from({ length: GRID_LINES + 1 }, (_, i) => PAD_T + (i / GRID_LINES) * plotH),
    [plotH],
  );

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      className="block"
      role="img"
      aria-label="Postings over time, one line per selected skill"
      preserveAspectRatio="none"
    >
      {/* Horizontal gridlines */}
      {gridYs.map((y, i) => (
        <line
          key={`g${i}`}
          x1={PAD_L}
          x2={CHART_W - PAD_R}
          y1={y}
          y2={y}
          stroke="#26262E"
          strokeWidth={1}
        />
      ))}

      {/* One polyline per skill, animated draw-in (respects reduced motion) */}
      {series.map((s) => {
        const pts = lineFor(s.points);
        return (
          <motion.polyline
            key={s.key}
            points={pts}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            initial={shouldReduceMotion ? { opacity: 0 } : { pathLength: 0 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { pathLength: 1 }}
            transition={{ duration: shouldReduceMotion ? 0.2 : 0.7, ease: "easeOut" }}
          />
        );
      })}

      {/* Month labels — show a subset to avoid crowding */}
      {months.map((m, i) => {
        const step = Math.ceil(months.length / 6);
        if (i % step !== 0 && i !== months.length - 1) return null;
        return (
          <text
            key={`l${m}`}
            x={xFor(i)}
            y={CHART_H - 8}
            textAnchor="middle"
            className="font-mono"
            fontSize={10}
            fill="#5C5C66"
          >
            {monthLabel(m)}
          </text>
        );
      })}
    </svg>
  );
}

// ── Skill picker dropdown ─────────────────────────────────────────────────────
function SkillPicker({ allSkills, selected, onAdd, disabled }) {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  // Debounce ~200ms — same pattern as SkillSearch.jsx.
  const debounceRef = useRef(null);
  function handleQueryChange(e) {
    const v = e.target.value;
    setRawQuery(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(v), 200);
  }
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allSkills
      .filter((s) => !selected.includes(s.skill))
      .filter(
        (s) =>
          !q ||
          s.skill.toLowerCase().includes(q) ||
          displayName(s.skill).toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [allSkills, selected, query]);

  function pick(key) {
    onAdd(key);
    setRawQuery("");
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative max-w-md">
      <input
        type="search"
        value={rawQuery}
        disabled={disabled}
        onChange={handleQueryChange}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={
          disabled ? `Maximum ${MAX_SKILLS} skills` : "Add a skill to compare\u2026"
        }
        aria-label="Add a skill to compare"
        className="w-full bg-[#0E0E12] border border-[#26262E] rounded-lg px-4 py-2.5 font-mono text-sm text-[#F4F4F6] placeholder-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      />

      {open && !disabled && matches.length > 0 && (
        <div className="absolute z-30 mt-2 w-full max-h-72 overflow-y-auto bg-[#121216] border border-[#26262E] rounded-lg shadow-2xl py-1">
          {matches.map((s) => (
            <button
              key={s.skill}
              // onMouseDown fires before the input blur, so the click registers.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s.skill);
              }}
              className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-[#EB0029]/10 transition-colors"
            >
              <span className="font-sans text-sm text-[#F4F4F6]">
                {displayName(s.skill)}
              </span>
              <span className="font-mono text-xs tabular-nums text-[#9A9AA6]">
                {(s.demand ?? 0).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Per-skill column ──────────────────────────────────────────────────────────
function SkillColumn({ skillKey, color, state }) {
  const name = displayName(skillKey);

  if (state?.error) {
    return (
      <div className="flex-1 min-w-0 rounded-xl bg-[#121216] border border-[#26262E] p-5">
        <div
          className="font-space font-bold text-xl tracking-tight mb-3 truncate"
          style={{ color }}
        >
          {name}
        </div>
        <p className="font-mono text-xs text-[#9A9AA6]" role="status">
          Couldn&#39;t load {name}
        </p>
      </div>
    );
  }

  if (!state || state.loading) {
    return (
      <div className="flex-1 min-w-0 rounded-xl bg-[#121216] border border-[#26262E] p-5">
        <div
          className="font-space font-bold text-xl tracking-tight mb-4 truncate"
          style={{ color }}
        >
          {name}
        </div>
        <div className="space-y-3 animate-pulse">
          <div className="h-8 w-24 rounded bg-[#1E1E24]" />
          <div className="h-2.5 w-32 rounded bg-[#1A1A20]" />
          <div className="h-2.5 w-28 rounded bg-[#1A1A20]" />
        </div>
      </div>
    );
  }

  const { detail, salary } = state;
  const demand = detail?.demand ?? 0;
  const share = typeof detail?.share === "number" ? detail.share : 0;
  const remoteShare = typeof detail?.remoteShare === "number" ? detail.remoteShare : 0;
  const primary = salary?.primary;
  const hasSalary = primary && primary.count > 0;

  return (
    <div
      className="flex-1 min-w-0 rounded-xl bg-[#121216] border border-[#26262E] p-5 border-t-2"
      style={{ borderTopColor: color }}
    >
      {/* Column header */}
      <div
        className="font-space font-bold text-xl tracking-tight mb-5 truncate"
        style={{ color }}
      >
        {name}
      </div>

      {/* Demand */}
      <div className="mb-5">
        <div className="font-mono text-[10px] text-[#5C5C66] uppercase tracking-widest mb-1">
          Demand
        </div>
        <div className="font-mono text-2xl text-white tabular-nums">
          {demand.toLocaleString()}
        </div>
        <div className="font-mono text-xs text-[#9A9AA6] mt-0.5">
          {share}% of all jobs
        </div>
      </div>

      {/* Remote */}
      <div className="mb-5">
        <div className="font-mono text-[10px] text-[#5C5C66] uppercase tracking-widest mb-1">
          Remote
        </div>
        <div className="font-mono text-xl text-white tabular-nums">{remoteShare}%</div>
      </div>

      {/* Salary */}
      <div>
        <div className="font-mono text-[10px] text-[#5C5C66] uppercase tracking-widest mb-1">
          Salary · Disclosed
        </div>
        {hasSalary ? (
          <>
            <div className="font-mono text-2xl font-bold text-white">
              {currencySymbol(primary.currency)}
              {fmtSalary(primary.median, primary.currency)}
              <span className="text-xs text-[#9A9AA6] font-normal ml-1.5">median</span>
            </div>
            <div className="font-mono text-xs text-[#9A9AA6] mt-0.5">
              {currencySymbol(primary.currency)}
              {fmtSalary(primary.p25, primary.currency)}
              {" \u2013 "}
              {currencySymbol(primary.currency)}
              {fmtSalary(primary.p75, primary.currency)}
            </div>
          </>
        ) : (
          <p className="font-mono text-xs text-[#5C5C66] leading-relaxed">
            Not enough disclosed salary data
          </p>
        )}
        {salary && (
          <div className="font-mono text-[10px] text-[#5C5C66] leading-relaxed mt-2 pt-2 border-t border-[#26262E]">
            {(salary.disclosedCount ?? 0).toLocaleString()} of{" "}
            {(salary.totalCount ?? 0).toLocaleString()} postings disclosed pay (
            {ratePct(salary.disclosureRate)}%)
          </div>
        )}
      </div>
    </div>
  );
}

export default function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Valid skill universe (powers the picker + URL validation).
  const [allSkills, setAllSkills] = useState([]);
  const [allLoaded, setAllLoaded] = useState(false);

  // Selected raw skill keys (order matters — drives palette assignment).
  const [selected, setSelected] = useState([]);

  // Per-skill { loading, error, detail, salary }, keyed by raw skill key.
  const [data, setData] = useState({});

  // Session cache keyed by `${skill}:12` so re-adding a skill is instant.
  const cacheRef = useRef(new Map());
  // Guards URL hydration so it only runs once, after the skill list loads.
  const hydratedRef = useRef(false);

  // Fetch the valid skill list on mount.
  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API}/api/skills/all`, { params: { months: MONTHS } })
      .then((res) => {
        if (cancelled) return;
        setAllSkills(res.data.skills || []);
        setAllLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setAllLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate selection from ?skills=react,node.js once the valid list is known.
  // Validate against the list and drop unknown keys.
  useEffect(() => {
    if (!allLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    const raw = searchParams.get("skills");
    if (!raw) return;
    const valid = new Set(allSkills.map((s) => s.skill));
    const keys = [];
    for (const part of raw.split(",")) {
      const k = part.trim().toLowerCase();
      if (k && valid.has(k) && !keys.includes(k) && keys.length < MAX_SKILLS) {
        keys.push(k);
      }
    }
    if (keys.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(keys);
    }
  }, [allLoaded, allSkills, searchParams]);

  // Keep the ?skills= query param in sync with the selection so every
  // comparison is a shareable URL. Skip writing during the very first render
  // pass before hydration has had a chance to run.
  useEffect(() => {
    if (!hydratedRef.current) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selected.length) next.set("skills", selected.join(","));
        else next.delete("skills");
        return next;
      },
      { replace: true },
    );
  }, [selected, setSearchParams]);

  // Fetch detail + salary for each selected skill independently, caching by
  // `${skill}:12`. Each skill's loading/error state is isolated.
  useEffect(() => {
    let cancelled = false;

    for (const key of selected) {
      const cacheKey = `${key}:${MONTHS}`;
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        setData((d) => (d[key] === cached ? d : { ...d, [key]: cached }));
        continue;
      }
      // Skip if already in-flight or resolved for this key this pass.
      setData((d) => (d[key] ? d : { ...d, [key]: { loading: true } }));

      Promise.all([
        axios.get(`${API}/api/skill/${encodeURIComponent(key)}`, {
          params: { months: MONTHS },
        }),
        axios.get(`${API}/api/salary`, {
          params: { skill: key, months: MONTHS },
        }),
      ])
        .then(([detailRes, salaryRes]) => {
          const resolved = {
            loading: false,
            error: false,
            detail: detailRes.data,
            salary: salaryRes.data,
          };
          cacheRef.current.set(cacheKey, resolved);
          if (!cancelled) setData((d) => ({ ...d, [key]: resolved }));
        })
        .catch(() => {
          if (!cancelled)
            setData((d) => ({ ...d, [key]: { loading: false, error: true } }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const addSkill = useCallback((key) => {
    setSelected((prev) => {
      if (prev.includes(key) || prev.length >= MAX_SKILLS) return prev;
      return [...prev, key];
    });
  }, []);

  const removeSkill = useCallback((key) => {
    setSelected((prev) => prev.filter((k) => k !== key));
  }, []);

  // Build the multi-series trend chart input: shared sorted month axis +
  // one series per skill that has trend.length > 1.
  const chart = useMemo(() => {
    const series = [];
    const monthSet = new Set();
    selected.forEach((key, i) => {
      const trend = data[key]?.detail?.trend;
      if (!Array.isArray(trend) || trend.length <= 1) return;
      const points = trend.map((t) => ({ month: t.month, count: t.count }));
      for (const p of points) monthSet.add(p.month);
      series.push({ key, color: PALETTE[i], points });
    });
    const months = Array.from(monthSet).sort();
    return { series, months };
  }, [selected, data]);

  const canCompare = selected.length >= 2;

  return (
    <main className="max-w-6xl mx-auto px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      {/* Header */}
      <section className="max-w-2xl space-y-4">
        <div className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold">
          Compare
        </div>
        <h1 className="font-space font-bold text-4xl md:text-6xl leading-[1.05] tracking-tight text-white">
          Skills, side by side.
        </h1>
        <p className="text-base md:text-lg text-[#9A9AA6] font-medium">
          Pick 2–3 skills to compare demand, salary and how postings have
          trended over the last 12 months.
        </p>
      </section>

      {/* Picker + chips */}
      <section className="space-y-4">
        <SkillPicker
          allSkills={allSkills}
          selected={selected}
          onAdd={addSkill}
          disabled={selected.length >= MAX_SKILLS}
        />

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((key, i) => {
              const color = PALETTE[i];
              const name = displayName(key);
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full border bg-[#121216]"
                  style={{ borderColor: color }}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="font-mono text-xs text-[#F4F4F6]">{name}</span>
                  <button
                    onClick={() => removeSkill(key)}
                    aria-label={`Remove ${name}`}
                    className="w-5 h-5 flex items-center justify-center rounded-full text-[#9A9AA6] hover:text-white hover:bg-[#26262E] transition-colors"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </section>

      {!canCompare ? (
        <div className="text-center py-24 font-mono text-sm text-[#5C5C66] uppercase tracking-widest">
          Pick at least 2 skills to compare.
        </div>
      ) : (
        <>
          {/* Columns */}
          <section className="flex flex-col md:flex-row gap-4">
            {selected.map((key, i) => (
              <SkillColumn
                key={key}
                skillKey={key}
                color={PALETTE[i]}
                state={data[key]}
              />
            ))}
          </section>

          {/* Multi-series trend chart */}
          <section className="rounded-xl bg-[#121216] border border-[#26262E] p-5">
            <div className="font-mono text-[10px] text-[#5C5C66] uppercase tracking-widest mb-4">
              Postings Over Time
            </div>

            {chart.series.length > 0 ? (
              <>
                <MultiTrendChart series={chart.series} months={chart.months} />

                {/* Legend */}
                <div className="flex flex-wrap gap-4 mt-4">
                  {chart.series.map((s) => (
                    <div key={s.key} className="flex items-center gap-2">
                      <span
                        className="w-3 h-0.5 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="font-mono text-xs text-[#9A9AA6]">
                        {displayName(s.key)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="font-mono text-xs text-[#5C5C66]">
                Not enough trend data to chart yet.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
