// No hooks needed from react itself — useFacetFilters and useOutletContext come from their own imports.
import { motion } from "framer-motion";
import { useOutletContext } from "react-router-dom";
import { TiltCard } from "../components/TiltCard";
import { BarChart } from "../components/BarChart";
import { RankingList } from "../components/RankingList";
import { SkillSearch } from "../components/SkillSearch";
import { useCountUp } from "../hooks/useCountUp";
import Num from "../components/ui/Num";
import useFacetFilters, { WINDOW_MONTHS } from "../hooks/useFacetFilters";
import FilterBar from "../components/FilterBar";
import FacetChips from "../components/FacetChips";

const EASE = [0.16, 1, 0.3, 1];

const heroEyebrowInit = { opacity: 0 };
const heroShow = { opacity: 1 };
const heroItemInit = { opacity: 0, y: 20 };
const heroH1Trans = { delay: 0.1, duration: 0.6, ease: EASE };
const heroPTrans = { delay: 0.2, duration: 0.6, ease: EASE };
const heroCountInit = { opacity: 0 };
const heroCountShow = { opacity: 1 };
const heroCountTrans = { delay: 0.4, duration: 0.6 };

export default function DemandPage() {
  const {
    sorted,
    maxCount,
    totalJobs,
    countries,
    trackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    error,
    velocityReady,
    velocityBasisDays,
    retryDemand,
  } = useOutletContext();

  // URL-backed filter state (shareable, refresh-safe).
  const { filters, setFilter, clearFilter, clearAll, activeChips } =
    useFacetFilters();
  const { role: activeRole, window: activeWindow, remote, disclosed, country, salary } = filters;


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
            <Num className="text-[var(--text)]">{animatedTotal.toLocaleString()}</Num>{" "}
            jobs analyzed
          </span>
          <div className="w-12 h-px bg-[var(--border)]" />
        </motion.div>

        {/* Trust signal near the number it backs: Demand is a live count, not a
            prediction, so we state how it's counted rather than a confidence %. */}
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
          How we count this: distinct active postings across sources in the
          selected role and window. Descriptive, not predictive.
        </p>
      </section>

      <FilterBar
        filters={filters}
        setFilter={setFilter}
        countries={countries}
        layoutPrefix="demand"
      />

      <FacetChips chips={activeChips} clearFilter={clearFilter} clearAll={clearAll} />

      {error ? (
        /* ERROR — adaptive recovery: what/why/next, retry not color-only. */
        <div
          role="alert"
          className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-6 text-center"
        >
          <h2 className="font-space text-lg font-bold text-[var(--text)]">
            We couldn't load the Demand report
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            The market feed didn't respond just now. It usually recovers within
            a few seconds.
          </p>
          <button
            onClick={retryDemand}
            className="mt-5 inline-flex h-11 items-center rounded-[var(--radius-md)] border border-[var(--border)] px-6 font-sans text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--muted)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        // Skeleton — mirrors the chart+ranking 2-column layout (shimmer; CSS
        // disables the sweep under prefers-reduced-motion).
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
          {/* Chart skeleton */}
          <div className="lg:col-span-7 xl:col-span-8">
            <div className="skeleton rounded-2xl h-[420px]" />
          </div>
          {/* Ranking skeleton */}
          <div className="lg:col-span-5 xl:col-span-4 space-y-1">
            <div className="skeleton h-3 w-28 mb-4 ml-4" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-3 rounded-lg"
              >
                <div className="skeleton w-8 h-3 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 w-3/4" />
                  <div className="skeleton h-1.5 w-full" />
                </div>
                <div className="skeleton w-12 h-3 shrink-0" />
                <div className="skeleton w-6 h-6 rounded-full shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ) : visibleSkills.length === 0 ? (
        /* EMPTY — onboarding: why it's empty + one next action. */
        <div className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <h2 className="font-space text-xl font-bold text-[var(--text)]">
            No skills in this slice
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            This role and window don't have enough postings to rank yet. Widen
            the window or view every role.
          </p>
        <button
            onClick={() => clearAll()}
            className="mt-6 inline-flex h-11 items-center rounded-[var(--radius-md)] bg-[var(--accent)] px-6 font-sans text-sm font-medium text-white transition-[background-color,transform] duration-[120ms] [transition-timing-function:var(--ease-spring)] hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
          >
            Show all skills
          </button>
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
                  key={`${activeRole}|${activeWindow}|${remote}|${disclosed}|${country}|${salary}`}
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
                  ? "📊 Trend tracking just started. Velocity unlocks in a few days."
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
