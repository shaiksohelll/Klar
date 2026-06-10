import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Remote % as a formatted string.
function pct(share) {
  return `${Math.round((share ?? 0) * 100)}%`;
}

/**
 * SkillGap — "What to learn next" advisor.
 *
 * Fetches GET /api/skill-gap (auth-gated) and renders a ranked list of skills
 * that co-occur most often with the user's watchlist but that they don't track.
 *
 * Props:
 *   getToken  — Clerk getToken() from useOutletContext (never null when signed in)
 *   trackedSkills — the user's current watchlist (string[]) — used as a
 *                   re-fetch trigger: when the user adds/removes a skill the
 *                   advisor recalculates.
 *   onSelect(skillObj) — opens the existing SkillDrawer (same pattern as SkillSearch)
 *   months    — active time window (number, default 12)
 */
export function SkillGap({ getToken, trackedSkills, onSelect, months = 12 }) {
  const shouldReduceMotion = useReducedMotion();

  const [state, setState] = useState("idle"); // idle | loading | error | done
  const [gaps, setGaps] = useState([]);
  const [empty, setEmpty] = useState(false);

  // Re-fetch whenever the watchlist or time window changes.
  const fetchGap = useCallback(async () => {
    setState("loading");
    try {
      const token = await getToken();
      if (!token) {
        setState("error");
        return;
      }
      const res = await axios.get(`${API}/api/skill-gap`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { months },
      });
      setGaps(res.data.gaps || []);
      setEmpty(res.data.empty ?? false);
      setState("done");
    } catch {
      setState("error");
    }
  }, [getToken, months]);

  // Run on mount and whenever trackedSkills array length changes (add/remove)
  // or the month window changes. Using length as dep is fine — the server
  // re-reads the authoritative watchlist from DB on every request.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchGap();
  }, [fetchGap, trackedSkills?.length]);

  // Row hover — reuse the same style as RankingList / SkillSearch.
  const rowHover = shouldReduceMotion
    ? { backgroundColor: "rgba(235,0,41,0.08)" }
    : { x: 7, backgroundColor: "rgba(235,0,41,0.08)" };
  const rowTransition = { type: "spring", stiffness: 420, damping: 34 };

  return (
    <section
      aria-label="Skill-gap advisor"
      className="border border-[#26262E] rounded-xl bg-[#0A0A0E] overflow-hidden"
    >
      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 border-b border-[#26262E]">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#EB0029] font-bold mb-1">
          What to Learn Next
        </div>
        <p className="font-mono text-[11px] text-[#5C5C66] leading-relaxed">
          Skills that show up most often alongside what you track — ranked by
          co-occurrence, with current demand.
        </p>
      </div>

      {/* ── Body ── */}
      <div className="px-5 pb-5 pt-4">
        {/* Loading */}
        {state === "loading" && (
          <div
            className="py-8 text-center font-mono text-xs uppercase tracking-widest text-[#5C5C66] animate-pulse"
            aria-live="polite"
          >
            Calculating…
          </div>
        )}

        {/* Error */}
        {state === "error" && (
          <div className="py-6 text-center space-y-3">
            <p className="font-mono text-xs text-[#EB0029]" role="alert">
              Couldn't load recommendations right now.
            </p>
            <button
              onClick={fetchGap}
              className="font-mono text-xs text-[#9A9AA6] hover:text-white underline transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Empty watchlist */}
        {state === "done" && empty && (
          <div
            className="py-8 text-center font-mono text-xs text-[#5C5C66] leading-relaxed"
            aria-live="polite"
          >
            Track a few skills first and we'll show you what pairs with them.
          </div>
        )}

        {/* No gaps found (all pairs already tracked) */}
        {state === "done" && !empty && gaps.length === 0 && (
          <div className="py-8 text-center font-mono text-xs text-[#5C5C66]">
            You're already tracking all the top co-occurring skills. Nice work.
          </div>
        )}

        {/* Results */}
        {state === "done" && gaps.length > 0 && (
          <div className="space-y-0.5">
            {gaps.map((gap, i) => (
              <motion.button
                key={gap.skill}
                onClick={() =>
                  onSelect({
                    id: gap.skill,
                    name: gap.skill,
                    count: gap.demand,
                    remoteCount: Math.round(gap.demand * gap.remoteShare),
                    role: "General",
                  })
                }
                whileHover={rowHover}
                transition={rowTransition}
                className="w-full text-left flex flex-col gap-1.5 px-3 py-3 rounded-lg group"
              >
                {/* Top row: rank + name + demand + remote */}
                <div className="flex items-center gap-3">
                  {/* Rank badge */}
                  <span className="font-mono text-xs text-[#5C5C66] group-hover:text-white transition-colors shrink-0 w-5 text-right">
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  {/* Skill name */}
                  <span className="flex-1 font-sans font-medium text-sm text-[#F4F4F6] group-hover:text-white transition-colors truncate">
                    {displayName(gap.skill)}
                  </span>

                  {/* Demand */}
                  <span className="font-mono text-xs tabular-nums text-[#9A9AA6] shrink-0">
                    {gap.demand.toLocaleString()}
                    <span className="text-[#5C5C66] ml-0.5">jobs</span>
                  </span>

                  {/* Remote % */}
                  <span className="font-mono text-xs tabular-nums text-[#9A9AA6] shrink-0 w-12 text-right">
                    {pct(gap.remoteShare)}
                    <span className="text-[#5C5C66] ml-0.5">remote</span>
                  </span>
                </div>

                {/* Reason line: "Pairs with React, Node.js" */}
                {gap.pairedWith && gap.pairedWith.length > 0 && (
                  <div className="pl-8 font-mono text-[10px] text-[#5C5C66] group-hover:text-[#9A9AA6] transition-colors truncate">
                    Pairs with{" "}
                    {gap.pairedWith.map(displayName).join(", ")}
                  </div>
                )}
              </motion.button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
