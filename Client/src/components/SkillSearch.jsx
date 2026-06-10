import { useState, useEffect, useMemo, useRef } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── Display name formatter (mirrors BarChart's formatter) ───────────────────
const KNOWN_NAMES = {
  html: "HTML",
  css: "CSS",
  aws: "AWS",
  "ci/cd": "CI/CD",
  sql: "SQL",
  api: "API",
  typescript: "TypeScript",
  javascript: "JavaScript",
  node: "Node.js",
  nodejs: "Node.js",
  "node.js": "Node.js",
  php: "PHP",
};

function displayName(raw) {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (KNOWN_NAMES[lower]) return KNOWN_NAMES[lower];
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Sort keys
const SORT_OPTIONS = [
  { key: "demand", label: "Demand" },
  { key: "name", label: "Name (A–Z)" },
  { key: "remote", label: "Most Remote" },
];

function pct(share) {
  return `${Math.round(share * 100)}%`;
}

/**
 * SkillSearch — standalone search + filter widget.
 *
 * Props:
 *   onSelect(skillObj)  — called when a row is clicked; pass setSelectedSkill
 *                         from the outlet context so the existing SkillDrawer opens.
 *   months              — passed to /api/skills/all (default 12)
 */
export function SkillSearch({ onSelect, months = 12 }) {
  const shouldReduceMotion = useReducedMotion();

  // ── Remote data ──────────────────────────────────────────────────────────
  const [allSkills, setAllSkills] = useState([]);
  const [fetchState, setFetchState] = useState("idle"); // idle | loading | error | done

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetchState("loading");
    axios
      .get(`${API}/api/skills/all`, { params: { months } })
      .then((res) => {
        if (cancelled) return;
        setAllSkills(res.data.skills || []);
        setFetchState("done");
      })
      .catch(() => {
        if (!cancelled) setFetchState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [months]);

  // ── Local filter state ───────────────────────────────────────────────────
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [sort, setSort] = useState("demand");

  // Debounce: update `query` ~200ms after the user stops typing
  const debounceRef = useRef(null);
  function handleQueryChange(e) {
    const v = e.target.value;
    setRawQuery(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(v), 200);
  }
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // ── Derived list ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allSkills;

    // Text search (case-insensitive, matches raw skill key OR display name)
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.skill.toLowerCase().includes(q) ||
          displayName(s.skill).toLowerCase().includes(q),
      );
    }

    // Remote-only: keep skills with remoteShare > 0
    if (remoteOnly) {
      list = list.filter((s) => s.remoteShare > 0);
    }

    // Sort
    list = [...list].sort((a, b) => {
      if (sort === "demand") return b.demand - a.demand;
      if (sort === "name")
        return displayName(a.skill).localeCompare(displayName(b.skill));
      if (sort === "remote") return b.remoteShare - a.remoteShare;
      return 0;
    });

    return list;
  }, [allSkills, query, remoteOnly, sort]);

  // ── Hover style ──────────────────────────────────────────────────────────
  const rowHover = shouldReduceMotion
    ? { backgroundColor: "rgba(235,0,41,0.08)" }
    : { x: 7, backgroundColor: "rgba(235,0,41,0.08)" };
  const rowTransition = { type: "spring", stiffness: 420, damping: 34 };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section aria-label="Skill search and filter">
      {/* ── Controls row ── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        {/* Search input — reuses the mono/border style found throughout the app */}
        <div className="relative flex-1 min-w-0">
          {/* Magnifier icon */}
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5C5C66] pointer-events-none"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
          <input
            id="skill-search-input"
            type="search"
            value={rawQuery}
            onChange={handleQueryChange}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="w-full bg-[#0E0E12] border border-[#26262E] rounded-lg pl-9 pr-4 py-2.5 font-mono text-sm text-[#F4F4F6] placeholder-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors"
          />
        </div>

        {/* Remote-only toggle */}
        <button
          id="skill-search-remote-toggle"
          onClick={() => setRemoteOnly((v) => !v)}
          aria-pressed={remoteOnly}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-mono text-xs uppercase tracking-wider transition-colors shrink-0 ${
            remoteOnly
              ? "border-[#EB0029] bg-[#EB0029]/10 text-[#FF2740]"
              : "border-[#26262E] bg-[#0E0E12] text-[#9A9AA6] hover:border-[#5C5C66] hover:text-[#F4F4F6]"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${remoteOnly ? "bg-[#EB0029]" : "bg-[#5C5C66]"}`}
          />
          Remote
        </button>

        {/* Sort segmented control */}
        <div
          className="flex bg-[#0E0E12] border border-[#26262E] rounded-lg p-0.5 shrink-0"
          role="group"
          aria-label="Sort order"
        >
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              id={`skill-sort-${opt.key}`}
              onClick={() => setSort(opt.key)}
              aria-pressed={sort === opt.key}
              className={`relative px-3 py-2 rounded-md font-mono text-xs uppercase tracking-wider transition-colors ${
                sort === opt.key
                  ? "bg-[#EB0029] text-white"
                  : "text-[#5C5C66] hover:text-[#9A9AA6]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Result count line ── */}
      <div className="font-mono text-[10px] uppercase tracking-widest text-[#5C5C66] mb-3 px-1">
        {fetchState === "done"
          ? `${filtered.length.toLocaleString()} skill${filtered.length !== 1 ? "s" : ""}${
              query.trim() || remoteOnly ? " matched" : " total"
            }`
          : null}
      </div>

      {/* ── States ── */}
      {fetchState === "loading" && (
        <div
          className="py-8 text-center font-mono text-xs uppercase tracking-widest text-[#5C5C66] animate-pulse"
          aria-live="polite"
        >
          Loading skills…
        </div>
      )}

      {fetchState === "error" && (
        <div className="py-8 text-center font-mono text-xs text-[#EB0029]" role="alert">
          Couldn't load skill list. Please try again shortly.
        </div>
      )}

      {fetchState === "done" && filtered.length === 0 && (
        <div
          className="py-8 text-center font-mono text-xs text-[#5C5C66] uppercase tracking-widest"
          aria-live="polite"
        >
          No skills match
        </div>
      )}

      {/* ── Result list ── */}
      {fetchState === "done" && filtered.length > 0 && (
        <div className="space-y-0.5">
          {/* Header */}
          <div className="flex items-center px-4 py-2 text-[10px] font-mono text-[#5C5C66] uppercase tracking-wider border-b border-[#26262E] mb-1">
            <div className="w-10">Rank</div>
            <div className="flex-1">Skill</div>
            <div className="w-24 text-right">Demand</div>
            <div className="w-16 text-right">Remote</div>
          </div>

          {filtered.slice(0, 100).map((s, i) => (
            <motion.button
              key={s.skill}
              onClick={() =>
                onSelect({
                  id: s.skill,
                  name: s.skill,
                  count: s.demand,
                  remoteCount: s.remoteCount,
                  role: "General",
                })
              }
              whileHover={rowHover}
              transition={rowTransition}
              className="w-full flex items-center px-4 py-2.5 rounded-lg cursor-pointer group text-left"
            >
              {/* Rank */}
              <div className="w-10 font-mono text-xs text-[#5C5C66] group-hover:text-white transition-colors shrink-0">
                {String(i + 1).padStart(2, "0")}
              </div>

              {/* Name */}
              <div className="flex-1 font-sans text-sm font-medium text-[#F4F4F6] group-hover:text-white transition-colors truncate pr-3">
                {displayName(s.skill)}
              </div>

              {/* Demand */}
              <div className="w-24 font-mono text-sm tabular-nums text-[#9A9AA6] text-right shrink-0">
                {s.demand.toLocaleString()}
              </div>

              {/* Remote % */}
              <div className="w-16 font-mono text-xs tabular-nums text-[#9A9AA6] text-right shrink-0">
                {pct(s.remoteShare)}
              </div>
            </motion.button>
          ))}

          {filtered.length > 100 && (
            <div className="px-4 py-3 font-mono text-[10px] text-[#5C5C66] uppercase tracking-wider text-center">
              Showing 100 of {filtered.length.toLocaleString()} — refine your search to see more
            </div>
          )}
        </div>
      )}
    </section>
  );
}
