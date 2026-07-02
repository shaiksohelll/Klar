import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";
import { displayName } from "../lib/displayName";
import useFacetFilters, { ROLES } from "../hooks/useFacetFilters";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// How many recommendations the user can ask for.
const LIMIT_OPTIONS = [6, 12, 20];

// Clamp a 0..1 ROI score to a whole-number percentage for the bar/label.
function roiPct(score) {
  const n = Math.round((score ?? 0) * 100);
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

/**
 * SkillGap — the "Learn Next" ROI advisor.
 *
 * Fetches GET /api/skill-gap (auth-gated) and renders a ranked list of skills
 * to learn next, each scored by a transparent blend of demand + momentum +
 * disclosed-INR salary lift + co-occurrence affinity. The WHY badges come
 * straight from the server's `reasons[]` (no client-side fabrication).
 *
 * Props:
 *   getToken      — Clerk getToken() (never null when signed in)
 *   trackedSkills — the user's watchlist (string[]); re-fetch trigger
 *   onSelect(skillObj) — opens the existing SkillDrawer
 *   months        — active time window (number, default 12)
 */
export function SkillGap({ getToken, trackedSkills, onSelect, months = 12 }) {
  const shouldReduceMotion = useReducedMotion();

  // Role comes from the shared URL-backed facet state (same control vocabulary
  // as the rest of the app). limit is a local control specific to this view.
  const { filters, setFilter } = useFacetFilters();
  const activeRole = filters.role; // "All" | "Frontend" | ...
  const [limit, setLimit] = useState(12);

  const [state, setState] = useState("idle"); // idle | loading | error | done
  const [recommendations, setRecommendations] = useState([]);
  const [insufficientData, setInsufficientData] = useState(false);
  const [basedOn, setBasedOn] = useState({ knownSkillCount: 0, role: null });

  const fetchGap = useCallback(async () => {
    setState("loading");
    try {
      const token = await getToken();
      if (!token) {
        setState("error");
        return;
      }
      const params = { months, limit };
      if (activeRole && activeRole !== "All") params.role = activeRole.toLowerCase();
      const res = await axios.get(`${API}/api/skill-gap`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
      });
      setRecommendations(res.data.recommendations || []);
      setInsufficientData(!!res.data.insufficientData);
      setBasedOn(res.data.basedOn || { knownSkillCount: 0, role: null });
      setState("done");
    } catch {
      setState("error");
    }
  }, [getToken, months, limit, activeRole]);

  // Re-fetch on mount and whenever the watchlist size, window, role, or limit
  // changes. The server always re-reads the authoritative watchlist from DB.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchGap();
  }, [fetchGap, trackedSkills?.length]);

  const rowHover = shouldReduceMotion
    ? { backgroundColor: "rgba(235,0,41,0.08)" }
    : { x: 6, backgroundColor: "rgba(235,0,41,0.08)" };
  const rowTransition = { type: "spring", stiffness: 420, damping: 34 };

  return (
    <section
      aria-label="Learn Next advisor"
      className="border border-[var(--border)] rounded-xl bg-[var(--panel)] overflow-hidden"
    >
      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent)] font-bold mb-1">
          Learn Next
        </div>
        <p className="font-mono text-[11px] text-[var(--muted-2)] leading-relaxed">
          Ranked by real market ROI — demand, momentum, salary lift, and how well
          each skill pairs with what you already know.
        </p>

        {/* Controls: role + count */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={activeRole}
            onChange={(e) => setFilter("role", e.target.value)}
            aria-label="Filter recommendations by role"
            className="h-8 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg)] px-3 font-mono text-[11px] uppercase tracking-wider text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] cursor-pointer"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r === "All" ? "All roles" : r}</option>
            ))}
          </select>

          <div className="flex rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg)] p-0.5" role="group" aria-label="Number of recommendations">
            {LIMIT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLimit(n)}
                aria-pressed={limit === n}
                className={`px-2.5 py-1 rounded-[var(--radius-pill)] font-mono text-[11px] tabular-nums transition-colors ${
                  limit === n
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--muted-2)] hover:text-[var(--muted)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="px-5 pb-5 pt-4">
        {/* Loading */}
        {state === "loading" && (
          <div className="space-y-2" aria-label="Loading recommendations" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`flex flex-col gap-2 px-3 py-3 rounded-lg ${shouldReduceMotion ? "" : "animate-pulse"}`}
                style={shouldReduceMotion ? {} : { animationDelay: `${i * 60}ms` }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-3 rounded bg-[var(--border)] shrink-0" />
                  <div className="flex-1 h-3.5 rounded bg-[var(--surface-2)]" />
                  <div className="w-10 h-3 rounded bg-[var(--border)] shrink-0" />
                </div>
                <div className="h-1.5 w-full rounded bg-[var(--border)]" />
                <div className="h-2.5 w-3/5 rounded bg-[var(--surface-2)]" />
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {state === "error" && (
          <div className="py-6 text-center space-y-3">
            <p className="font-mono text-xs text-[var(--accent)]" role="alert">
              Couldn't load recommendations right now.
            </p>
            <button
              onClick={fetchGap}
              className="font-mono text-xs text-[var(--muted)] hover:text-[var(--text)] underline transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Cold start / insufficient data — friendly, NOT an error */}
        {state === "done" && insufficientData && (
          <div className="py-8 text-center font-mono text-xs text-[var(--muted-2)] leading-relaxed" aria-live="polite">
            {basedOn.knownSkillCount === 0
              ? "Track a few skills first — we'll rank what to learn next by market ROI."
              : "Building your recommendations as market data banks. Check back soon."}
          </div>
        )}

        {/* Results */}
        {state === "done" && !insufficientData && recommendations.length > 0 && (
          <div className="space-y-1">
            {recommendations.map((rec, i) => {
              const pct = roiPct(rec.roiScore);
              return (
                <motion.button
                  key={rec.skill}
                  onClick={() =>
                    onSelect({
                      id: rec.skill,
                      name: rec.skill,
                      count: rec.demand,
                      role: "General",
                    })
                  }
                  whileHover={rowHover}
                  transition={rowTransition}
                  className="w-full text-left flex flex-col gap-2 px-3 py-3 rounded-lg group"
                >
                  {/* Top row: rank + name + ROI score */}
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-[var(--muted-2)] group-hover:text-[var(--text)] transition-colors shrink-0 w-5 text-right">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="flex-1 font-sans font-medium text-sm text-[var(--text)] truncate">
                      {displayName(rec.skill)}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-[var(--muted)] shrink-0">
                      ROI <span className="text-[var(--text)] font-bold">{pct}</span>
                    </span>
                  </div>

                  {/* ROI bar */}
                  <div
                    className="h-1.5 w-full rounded-full bg-[var(--border)] overflow-hidden"
                    role="meter"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`ROI score for ${displayName(rec.skill)}`}
                  >
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-[#FF2740] to-[#C70022] group-hover:brightness-110 transition-[filter]"
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={shouldReduceMotion ? { duration: 0.2 } : { type: "spring", stiffness: 150, damping: 20, delay: i * 0.03 }}
                    />
                  </div>

                  {/* WHY badges — straight from the server's reasons[] */}
                  {rec.reasons && rec.reasons.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pl-8">
                      {rec.reasons.map((reason) => (
                        <span
                          key={reason}
                          className="inline-flex items-center rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--muted)]"
                        >
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}
                </motion.button>
              );
            })}
          </div>
        )}

        {/* Done but nothing to show (defensive; insufficientData usually covers this) */}
        {state === "done" && !insufficientData && recommendations.length === 0 && (
          <div className="py-8 text-center font-mono text-xs text-[var(--muted-2)]">
            No recommendations for this slice yet.
          </div>
        )}
      </div>
    </section>
  );
}
