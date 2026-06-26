import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { motion, useReducedMotion } from "framer-motion";
import { useOutletContext } from "react-router-dom";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

const ROLES = ["All", "Frontend", "Backend", "Fullstack", "DevOps", "Data", "Mobile"];
const WINDOWS = ["3M", "6M", "12M"];
const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };

const pillSpring = { type: "spring", stiffness: 180, damping: 22 };

function pct(share) {
  return `${Math.round((share ?? 0) * 100)}%`;
}

// ── Skeleton ───────────────────────────────────────────────────────────────
function SkeletonRows({ count = 12, shouldReduceMotion }) {
  return (
    <div className="space-y-2" aria-label="Loading companies" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`flex items-center gap-4 px-5 py-4 rounded-xl bg-[#0A0A0E] border border-[#26262E] ${
            shouldReduceMotion ? "" : "animate-pulse"
          }`}
          style={shouldReduceMotion ? {} : { animationDelay: `${i * 45}ms` }}
        >
          {/* Rank */}
          <div className="w-7 h-3.5 rounded bg-[#26262E] shrink-0" />
          {/* Company name */}
          <div className="flex-1 h-4 rounded bg-[#1E1E24]" />
          {/* Openings */}
          <div className="w-16 h-3 rounded bg-[#26262E] shrink-0" />
          {/* Remote */}
          <div className="w-12 h-3 rounded bg-[#26262E] shrink-0" />
          {/* Skill chips */}
          <div className="hidden sm:flex gap-1.5 shrink-0">
            {[48, 36, 44].map((w, j) => (
              <div key={j} className={`h-5 rounded-full bg-[#1A1A20]`} style={{ width: w }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function HiringPage() {
  const { setSelectedSkill } = useOutletContext();
  const shouldReduceMotion = useReducedMotion();

  const [activeRole, setActiveRole] = useState("All");
  const [activeWindow, setActiveWindow] = useState("12M");
  const [state, setState] = useState("loading"); // loading | done | error
  const [companies, setCompanies] = useState([]);

  const rowHover = shouldReduceMotion
    ? { backgroundColor: "rgba(235,0,41,0.06)" }
    : { x: 4, backgroundColor: "rgba(235,0,41,0.06)" };
  const rowTransition = { type: "spring", stiffness: 420, damping: 34 };

  const fetchCompanies = useCallback(async () => {
    setState("loading");
    try {
      const params = { months: WINDOW_MONTHS[activeWindow] };
      if (activeRole !== "All") params.role = activeRole.toLowerCase();
      const res = await axios.get(`${API}/api/companies`, { params });
      setCompanies(res.data.companies || []);
      setState("done");
    } catch {
      setState("error");
    }
  }, [activeRole, activeWindow]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCompanies();
  }, [fetchCompanies]);

  const openSkill = (skillKey) =>
    setSelectedSkill({
      id: skillKey,
      name: skillKey,
      role: activeRole === "All" ? "General" : activeRole,
    });

  return (
    <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-10 relative z-10">
      {/* ── Hero ── */}
      <section className="text-center max-w-3xl mx-auto space-y-5">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold"
        >
          Who's Hiring
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-white"
        >
          The companies{" "}
          <span className="text-[#EB0029] italic">actually</span> posting.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="text-lg text-[#9A9AA6] max-w-2xl mx-auto font-medium"
        >
          Top hiring companies ranked by active postings, with the skills each
          one asks for most. Pure counts from real listings. No predictions.
        </motion.p>
      </section>

      {/* ── Controls ── */}
      <section className="flex flex-col md:flex-row items-center justify-between gap-4 border-b border-[#26262E] pb-6">
        {/* Role filter */}
        <div className="flex flex-wrap justify-center gap-2">
          {ROLES.map((role) => (
            <button
              key={role}
              onClick={() => setActiveRole(role)}
              className={`relative px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                activeRole === role ? "text-white" : "text-[#9A9AA6] hover:text-white"
              }`}
            >
              {activeRole === role && (
                <motion.div
                  layoutId="hiringActiveRole"
                  className="absolute inset-0 bg-[#EB0029] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {role}
            </button>
          ))}
        </div>

        {/* Window filter */}
        <div className="flex bg-[#121216] border border-[#26262E] rounded-full p-1 shrink-0">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setActiveWindow(w)}
              className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                activeWindow === w ? "text-white" : "text-[#5C5C66] hover:text-[#9A9AA6]"
              }`}
            >
              {activeWindow === w && (
                <motion.div
                  layoutId="hiringActiveWindow"
                  className="absolute inset-0 bg-[#EB0029] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {w}
            </button>
          ))}
        </div>
      </section>

      {/* ── Body ── */}
      {state === "error" ? (
        <div className="text-center py-20 space-y-4">
          <p className="font-mono text-sm text-[#EB0029]" role="alert">
            Couldn't load hiring data right now.
          </p>
          <button
            onClick={fetchCompanies}
            className="font-mono text-xs text-[#9A9AA6] hover:text-white underline transition-colors"
          >
            Try again
          </button>
        </div>
      ) : state === "loading" ? (
        <SkeletonRows count={12} shouldReduceMotion={shouldReduceMotion} />
      ) : companies.length === 0 ? (
        <div className="text-center py-20 font-mono text-sm text-[#5C5C66]">
          No companies found for this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {companies.map((co, i) => (
            <motion.div
              key={co.company}
              whileHover={rowHover}
              transition={rowTransition}
              className="flex flex-wrap md:flex-nowrap items-center gap-3 md:gap-4 px-5 py-4 rounded-xl bg-[#0A0A0E] border border-[#26262E] group cursor-default"
            >
              {/* Rank */}
              <span className="font-mono text-sm text-[#5C5C66] group-hover:text-[#9A9AA6] transition-colors shrink-0 w-7 text-right tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>

              {/* Company name */}
              <span className="flex-1 font-sans font-semibold text-base text-[#F4F4F6] group-hover:text-white transition-colors truncate min-w-0">
                {co.company}
              </span>

              {/* Openings */}
              <span className="font-mono text-sm tabular-nums text-white shrink-0">
                {co.openings.toLocaleString()}
                <span className="text-[#5C5C66] ml-1 text-xs">openings</span>
              </span>

              {/* Remote % */}
              <span className="font-mono text-xs tabular-nums text-[#9A9AA6] shrink-0 w-16 text-right">
                {pct(co.remoteShare)}
                <span className="text-[#5C5C66] ml-0.5">remote</span>
              </span>

              {/* Top-skill chips — clicking opens the SkillDrawer */}
              {co.topSkills && co.topSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 w-full md:w-auto">
                  {co.topSkills.map(({ skill }) => (
                    <button
                      key={skill}
                      onClick={() => openSkill(skill)}
                      className="px-2.5 py-0.5 rounded-full border border-[#26262E] bg-[#121216] hover:border-[#EB0029] hover:text-white font-mono text-[10px] text-[#9A9AA6] transition-colors"
                    >
                      {displayName(skill)}
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </main>
  );
}
