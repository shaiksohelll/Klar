import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Allowed month windows for this page's data. The active window drives every
// fetch and the per-skill cache key, and is persisted in the URL as ?w=.
const ALLOWED_WINDOWS = [3, 6, 12];
const DEFAULT_WINDOW = 12;

// Normalize an arbitrary value to a valid window, falling back to 12.
function normalizeWindow(value) {
  const n = Number(value);
  return ALLOWED_WINDOWS.includes(n) ? n : DEFAULT_WINDOW;
}

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

// ── Export helpers ────────────────────────────────────────────────────────────

// Map selected skill keys to flat row objects pulled from `data`, with safe
// defaults for skills that are still loading, errored or missing. Shared by
// both the CSV and PDF exporters so the two stay in sync.
function buildExportRows(selected, data) {
  return selected.map((key) => {
    const state = data[key] || {};
    const detail = state.detail || {};
    const salary = state.salary || {};
    const primary = salary.primary || {};
    return {
      key,
      name: displayName(key),
      demand: typeof detail.demand === "number" ? detail.demand : 0,
      share: typeof detail.share === "number" ? detail.share : 0,
      remoteShare: typeof detail.remoteShare === "number" ? detail.remoteShare : 0,
      currency: primary.currency || "",
      median: typeof primary.median === "number" ? primary.median : null,
      p25: typeof primary.p25 === "number" ? primary.p25 : null,
      p75: typeof primary.p75 === "number" ? primary.p75 : null,
      disclosedCount:
        typeof salary.disclosedCount === "number" ? salary.disclosedCount : 0,
      totalCount: typeof salary.totalCount === "number" ? salary.totalCount : 0,
      disclosureRate:
        typeof salary.disclosureRate === "number" ? salary.disclosureRate : 0,
    };
  });
}

// Escape a single CSV field per RFC 4180: wrap in quotes and double any inner
// quotes when the value contains a comma, quote or newline.
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Trigger a client-side file download from a string payload via a temporary
// anchor + object URL.
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Build the dash-joined skill-key slug used in export filenames.
function exportSlug(selected) {
  return selected.join("-") || "skills";
}

// PDF-safe currency label. jsPDF's Helvetica has no ₹ glyph, so the on-screen
// symbols from currencySymbol() can't be reused in the PDF export. Map each
// currency code to an ASCII-safe label instead.
function pdfCurrencyLabel(code) {
  switch (code) {
    case "INR":
      return "Rs ";
    case "USD":
      return "$";
    case "GBP":
      return "GBP ";
    case "EUR":
      return "EUR ";
    default:
      return code ? `${code} ` : "";
  }
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
        onClick={() => setOpen(true)}
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

  // Active month window (3 | 6 | 12). Persisted in the URL as ?w=.
  const [windowMonths, setWindowMonths] = useState(DEFAULT_WINDOW);

  // Per-skill { loading, error, detail, salary }, keyed by raw skill key.
  const [data, setData] = useState({});

  // Session cache keyed by `${skill}:12` so re-adding a skill is instant.
  const cacheRef = useRef(new Map());
  // Guards URL hydration so it only runs once, after the skill list loads.
  const hydratedRef = useRef(false);
  // Set true by hydration so the very next URL-sync pass is skipped
  // (selected hasn't updated yet in that commit — avoids wiping ?skills=).
  const skipNextSyncRef = useRef(false);

  // Fetch the valid skill list, refetching whenever the window changes.
  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API}/api/skills/all`, { params: { months: windowMonths } })
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
  }, [windowMonths]);

  // Hydrate selection from ?skills=react,node.js once the valid list is known.
  // Validate against the list and drop unknown keys.
  useEffect(() => {
    if (!allLoaded || hydratedRef.current) return;
    hydratedRef.current = true;

    // Window: validate ?w= against the allowed set, fall back to 12.
    const rawWindow = searchParams.get("w");
    if (rawWindow !== null) {
      const win = normalizeWindow(rawWindow);
      if (win !== windowMonths) {
        skipNextSyncRef.current = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWindowMonths(win);
      }
    }

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
      skipNextSyncRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(keys);
    }
  }, [allLoaded, allSkills, searchParams, windowMonths]);

  // Keep the ?skills= query param in sync with the selection so every
  // comparison is a shareable URL. Skip writing during the very first render
  // pass before hydration has had a chance to run.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selected.length) next.set("skills", selected.join(","));
        else next.delete("skills");
        // Only persist a non-default window so default URLs stay clean.
        if (windowMonths !== DEFAULT_WINDOW) next.set("w", String(windowMonths));
        else next.delete("w");
        return next;
      },
      { replace: true },
    );
  }, [selected, windowMonths, setSearchParams]);

  // Fetch detail + salary for each selected skill independently, caching by
  // `${skill}:${windowMonths}`. Each skill's loading/error state is isolated.
  // Changing the window changes the cache key, so any selected skill not yet
  // cached at the new window is refetched.
  useEffect(() => {
    let cancelled = false;

    for (const key of selected) {
      const cacheKey = `${key}:${windowMonths}`;
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        setData((d) => (d[key] === cached ? d : { ...d, [key]: cached }));
        continue;
      }
      // Show a loading state for this skill at the new window. Unlike the
      // previous guard we always reset to loading here because a window change
      // can leave stale (other-window) data in `data[key]`.
      setData((d) =>
        d[key] && d[key].loading ? d : { ...d, [key]: { loading: true } },
      );

      Promise.all([
        axios.get(`${API}/api/skill/${encodeURIComponent(key)}`, {
          params: { months: windowMonths },
        }),
        axios.get(`${API}/api/salary`, {
          params: { skill: key, months: windowMonths },
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
  }, [selected, windowMonths]);

  const addSkill = useCallback((key) => {
    setSelected((prev) => {
      if (prev.includes(key) || prev.length >= MAX_SKILLS) return prev;
      return [...prev, key];
    });
  }, []);

  const removeSkill = useCallback((key) => {
    setSelected((prev) => prev.filter((k) => k !== key));
  }, []);

  // ── Share + export ──────────────────────────────────────────────────────────

  // "Copied!" feedback flag + its reset timer (cleared on unmount).
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  // Every selected skill resolved (not loading)? Gates the CSV/PDF buttons.
  const allReady = useMemo(
    () => selected.length > 0 && selected.every((k) => data[k] && !data[k].loading),
    [selected, data],
  );

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — fail silently.
    }
  }, []);

  const handleExportCsv = useCallback(() => {
    const rows = buildExportRows(selected, data);
    const header = [
      "Skill",
      "Demand",
      "% of all jobs",
      "Remote %",
      "Salary currency",
      "Salary median",
      "Salary P25",
      "Salary P75",
      "Disclosed postings",
      "Total postings",
      "Disclosure %",
    ];
    const lines = [header.map(csvEscape).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.demand,
          r.share,
          r.remoteShare,
          r.currency,
          r.median ?? "",
          r.p25 ?? "",
          r.p75 ?? "",
          r.disclosedCount,
          r.totalCount,
          ratePct(r.disclosureRate),
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    downloadBlob(
      `klar-skill-comparison-${exportSlug(selected)}.csv`,
      lines.join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }, [selected, data]);

  const handleExportPdf = useCallback(async () => {
    try {
      const { jsPDF } = await import("jspdf");
      const rows = buildExportRows(selected, data);
      const doc = new jsPDF({ unit: "pt", format: "a4" });

      const marginX = 48;
      let y = 64;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text("Skill Comparison \u2014 Klar", marginX, y);

      y += 22;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text(
        `Exported ${new Date().toLocaleDateString()} \u00B7 Last ${windowMonths} months`,
        marginX,
        y,
      );
      doc.setTextColor(0);

      // Table header.
      y += 32;
      const cols = [
        { label: "Skill", x: marginX },
        { label: "Demand", x: marginX + 150 },
        { label: "% jobs", x: marginX + 220 },
        { label: "Remote %", x: marginX + 280 },
        { label: "Median salary", x: marginX + 360 },
      ];
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      for (const c of cols) doc.text(c.label, c.x, y);

      y += 6;
      doc.setDrawColor(180);
      doc.line(marginX, y, marginX + 470, y);

      // Table rows.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      for (const r of rows) {
        y += 22;
        const medianText =
          r.median == null
            ? "\u2014"
            : `${pdfCurrencyLabel(r.currency)}${fmtSalary(r.median, r.currency)}`;
        doc.text(String(r.name), cols[0].x, y);
        doc.text(r.demand.toLocaleString(), cols[1].x, y);
        doc.text(`${r.share}%`, cols[2].x, y);
        doc.text(`${r.remoteShare}%`, cols[3].x, y);
        doc.text(medianText, cols[4].x, y);
      }

      doc.save(`klar-skill-comparison-${exportSlug(selected)}.pdf`);
    } catch {
      // PDF generation failed (dependency missing / runtime error) — no-op.
    }
  }, [selected, data, windowMonths]);

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
          {/* Share + export toolbar */}
          <section className="flex flex-wrap items-center justify-end gap-2">
            {/* Month window toggle — mono pills matching the app's window switch */}
            <div
              className="flex bg-[#121216] border border-[#26262E] rounded-lg p-0.5"
              role="group"
              aria-label="Time window"
            >
              {ALLOWED_WINDOWS.map((m) => {
                const active = windowMonths === m;
                return (
                  <button
                    key={m}
                    onClick={() => setWindowMonths(m)}
                    aria-label={`Last ${m} months`}
                    aria-pressed={active}
                    className={`relative px-3 py-2 rounded-md font-mono text-xs uppercase tracking-wider transition-colors ${
                      active
                        ? "bg-[#EB0029] text-white"
                        : "text-[#5C5C66] hover:text-[#9A9AA6]"
                    }`}
                  >
                    {m}M
                  </button>
                );
              })}
            </div>
            <button
              onClick={handleCopyLink}
              aria-label="Copy shareable link to this comparison"
              className="font-mono text-xs bg-[#121216] border border-[#26262E] rounded-lg px-3 py-2 text-[#9A9AA6] hover:border-[#EB0029] hover:text-white transition-colors"
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
            <button
              onClick={handleExportCsv}
              disabled={!allReady}
              aria-label="Export comparison as CSV"
              className="font-mono text-xs bg-[#121216] border border-[#26262E] rounded-lg px-3 py-2 text-[#9A9AA6] hover:border-[#EB0029] hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export CSV
            </button>
            <button
              onClick={handleExportPdf}
              disabled={!allReady}
              aria-label="Export comparison as PDF"
              className="font-mono text-xs bg-[#121216] border border-[#26262E] rounded-lg px-3 py-2 text-[#9A9AA6] hover:border-[#EB0029] hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export PDF
            </button>
          </section>

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
