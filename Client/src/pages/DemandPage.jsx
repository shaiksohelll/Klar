import { motion } from "framer-motion";
import { useOutletContext } from "react-router-dom";
import { useReducedMotion } from "framer-motion";
import { TiltCard } from "../components/TiltCard";
import { BarChart } from "../components/BarChart";
import { RankingList } from "../components/RankingList";
import { SkillSearch } from "../components/SkillSearch";
import { useCountUp } from "../hooks/useCountUp";

const ROLES = [
  "All",
  "Frontend",
  "Backend",
  "Fullstack",
  "DevOps",
  "Data",
  "Mobile",
];
const WINDOWS = ["3M", "6M", "12M"];
const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
const EASE = [0.16, 1, 0.3, 1];

// Sliding pill springs — stiffness 180, damping 22 (UI spring)
const pillSpring = { type: "spring", stiffness: 180, damping: 22 };

const heroEyebrowInit = { opacity: 0 };
const heroShow = { opacity: 1 };
const heroItemInit = { opacity: 0, y: 20 };
const heroH1Trans = { delay: 0.1, duration: 0.6, ease: EASE };
const heroPTrans = { delay: 0.2, duration: 0.6, ease: EASE };
const heroCountInit = { opacity: 0 };
const heroCountShow = { opacity: 1 };
const heroCountTrans = { delay: 0.4, duration: 0.6 };

export default function DemandPage() {
  const ctx = useOutletContext();
  const {
    sorted,
    maxCount,
    totalJobs,
    activeRole,
    setActiveRole,
    activeWindow,
    setActiveWindow,
    trackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    error,
    velocityReady,
    velocityBasisDays,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();

  // Count-up for the hero stat — re-triggers on totalJobs change (filter change)
  const animatedTotal = useCountUp(totalJobs, 700);

  const visibleSkills = sorted;

  return (
    <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 md:space-y-20 relative z-10">
      <section className="text-center max-w-3xl mx-auto space-y-6">
        <motion.div
          initial={heroEyebrowInit}
          animate={heroShow}
          className="font-mono text-[var(--accent)] text-xs uppercase tracking-[0.2em] font-bold"
        >
          The Demand Report
        </motion.div>
        <motion.h1
          initial={heroItemInit}
          animate={heroShow}
          transition={heroH1Trans}
          className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-[var(--text)]"
        >
          What developers{" "}
          <span className="text-[var(--accent)] italic">actually</span> get hired for.
        </motion.h1>
        <motion.p
          initial={heroItemInit}
          animate={heroShow}
          transition={heroPTrans}
          className="text-lg md:text-xl text-[var(--muted)] max-w-2xl mx-auto font-medium"
        >
          Real-time market analysis based on active job postings. No hype, no
          predictions. Just the data.
        </motion.p>
        <motion.div
          initial={heroCountInit}
          animate={heroCountShow}
          transition={heroCountTrans}
          className="font-mono text-[var(--muted-2)] text-sm uppercase tracking-widest pt-4 flex items-center justify-center gap-3"
        >
          <div className="w-12 h-px bg-[var(--border)]" />
          {/* Count-up number — key forces re-mount (re-animation) on filter change */}
          <span key={totalJobs} aria-live="polite" aria-atomic="true">
            {animatedTotal.toLocaleString()} jobs analyzed
          </span>
          <div className="w-12 h-px bg-[var(--border)]" />
        </motion.div>
      </section>

      <section className="flex flex-col md:flex-row items-center justify-between gap-6 border-b border-[var(--border)] pb-6">
        {/* Role segmented control — sliding red pill */}
        <div className="flex flex-wrap justify-center gap-2">
          {ROLES.map((role) => (
            <button
              key={role}
              onClick={() => setActiveRole(role)}
              className={`relative px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                activeRole === role
                  ? "text-white"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {activeRole === role && (
                <motion.div
                  layoutId="activeRole"
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {role}
            </button>
          ))}
        </div>

        {/* Window segmented control — sliding red pill (was grey, now red per spec) */}
        <div className="flex bg-[var(--panel)] border border-[var(--border)] rounded-full p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setActiveWindow(w)}
              className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                activeWindow === w
                  ? "text-white"
                  : "text-[var(--muted-2)] hover:text-[var(--muted)]"
              }`}
            >
              {activeWindow === w && (
                <motion.div
                  layoutId="activeWindow"
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {w}
            </button>
          ))}
        </div>
      </section>

      {error ? (
        <div className="text-center py-20 font-mono text-sm text-[var(--accent)]">
          {error}
        </div>
      ) : loading ? (
        // Skeleton — mirrors the chart+ranking 2-column layout
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
          {/* Chart skeleton */}
          <div className="lg:col-span-7 xl:col-span-8">
            <div
              className={`rounded-2xl bg-[var(--panel)] border border-[var(--border)] h-[420px] ${
                shouldReduceMotion ? "" : "animate-pulse"
              }`}
            />
          </div>
          {/* Ranking skeleton */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-1">
            <div className="h-3 w-28 rounded bg-[var(--border)] mb-4 ml-4" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
                  shouldReduceMotion ? "" : "animate-pulse"
                }`}
                style={shouldReduceMotion ? {} : { animationDelay: `${i * 50}ms` }}
              >
                <div className="w-8 h-3 rounded bg-[var(--border)] shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 rounded bg-[var(--surface-2)] w-3/4" />
                  <div className="h-1.5 rounded bg-[var(--surface-2)] w-full" />
                </div>
                <div className="w-12 h-3 rounded bg-[var(--border)] shrink-0" />
                <div className="w-6 h-6 rounded-full bg-[var(--border)] shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ) : visibleSkills.length === 0 ? (
        <div className="text-center py-20 font-mono text-sm text-[var(--muted-2)]">
          No skills found for this filter.
        </div>
      ) : (
        <div className="space-y-10">
          {/* ── Skill search / filter ── */}
          <div className="border border-[var(--border)] rounded-xl p-5 bg-[var(--panel)]">
            <div className="font-mono text-xs uppercase tracking-widest text-[var(--muted-2)] mb-4">
              Search &amp; Filter Skills
            </div>
            <SkillSearch
              onSelect={setSelectedSkill}
              months={WINDOW_MONTHS[activeWindow]}
            />
          </div>

          {/* ── Demand chart + ranking list ── */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            <div className="lg:col-span-7 xl:col-span-8">
              <TiltCard>
                {/*
                  key={activeRole + activeWindow} forces BarChart to re-mount
                  (and thus re-run entrance animations) on filter changes.
                */}
                <BarChart
                  key={`${activeRole}|${activeWindow}`}
                  skills={visibleSkills.slice(0, 12)}
                  maxCount={maxCount}
                  onSelect={setSelectedSkill}
                />
              </TiltCard>
            </div>

            <div className="lg:col-span-5 xl:col-span-4">
              <div className="font-mono text-xs uppercase tracking-widest text-[var(--muted-2)] mb-1 px-4">
                Detailed Ranking
              </div>
              <div className="font-mono text-[10px] text-[var(--muted-2)] mb-4 px-4 min-h-[1em]">
                {!velocityReady
                  ? "📊 Trend tracking just started — velocity unlocks in a few days."
                  : velocityBasisDays !== null
                    ? `Velocity vs ~${velocityBasisDays}d ago`
                    : null}
              </div>
              <RankingList
                skills={visibleSkills}
                maxCount={maxCount}
                onSelect={setSelectedSkill}
                onTrack={handleTrack}
                tracked={trackedSkills}
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
