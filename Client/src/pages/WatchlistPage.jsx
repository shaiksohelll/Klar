import { useMemo } from "react";
import { Link, useOutletContext } from "react-router-dom";
import useFacetFilters from "../hooks/useFacetFilters";
import { RankingList } from "../components/RankingList";
import { SkillGap } from "../components/SkillGap";
import Button from "../components/ui/Button";

// Loading skeleton — mirrors the ranking-list rows so the layout doesn't
// shift when the real list arrives.
function WatchlistSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading your watchlist">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--panel)]"
        >
          <div className="skeleton h-3.5 w-7 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3.5 w-3/4" />
            <div className="skeleton h-1.5 w-full" />
          </div>
          <div className="skeleton h-3 w-12 shrink-0" />
          <div className="skeleton h-6 w-6 rounded-full shrink-0" />
        </div>
      ))}
    </div>
  );
}

const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };

export default function WatchlistPage() {
  const ctx = useOutletContext();
  const {
    sorted,
    maxCount,
    trackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    watchlistError,
    retryWatchlist,
    getToken,
  } = ctx;

  const { filters } = useFacetFilters();
  const months = WINDOW_MONTHS[filters.window] ?? 12;

  const watched = useMemo(
    () => sorted.filter((s) => trackedSkills.includes(s.id)),
    [sorted, trackedSkills],
  );

  return (
    <main className="max-w-3xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-2xl mx-auto space-y-4">
        <div className="font-mono text-[var(--accent)] text-xs uppercase tracking-[0.2em] font-bold">
          Your Watchlist
        </div>
        <h1 className="font-space font-bold text-4xl md:text-6xl leading-[1.05] tracking-tight text-[var(--text)]">
          Skills you're tracking.
        </h1>
        <p className="text-base md:text-lg text-[var(--muted)] font-medium">
          The skills you starred, ranked by current market demand.
        </p>
      </section>

      {loading ? (
        <WatchlistSkeleton />
      ) : watched.length === 0 && watchlistError ? (
        /* ERROR — what happened, why, and the next step. Not color-only. */
        <div
          role="alert"
          className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-6 text-center"
        >
          <h2 className="font-space text-lg font-bold text-[var(--text)]">
            We couldn't load your watchlist
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            The connection dropped before your tracked skills came back. Your
            saved skills are safe — this is just a display hiccup.
          </p>
          <div className="mt-5 flex justify-center">
            <Button variant="secondary" onClick={retryWatchlist}>
              Try again
            </Button>
          </div>
        </div>
      ) : watched.length === 0 ? (
        /* EMPTY — onboarding: one-line value prop + a single next action. */
        <div className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <h2 className="font-space text-xl font-bold text-[var(--text)]">
            Track the skills that matter to you
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            Star any skill and Klar keeps its live demand right here, so you can
            watch where the market is heading at a glance.
          </p>
          <div className="mt-6 flex justify-center">
            <Link to="/">
              <Button variant="primary">Browse the Demand report</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-10">
          <RankingList
            skills={watched}
            maxCount={maxCount}
            onSelect={setSelectedSkill}
            onTrack={handleTrack}
            tracked={trackedSkills}
          />

          {/* Skill-Gap Advisor — only shown when there's a watchlist to reason from */}
          {getToken && (
            <SkillGap
              getToken={getToken}
              trackedSkills={trackedSkills}
              onSelect={setSelectedSkill}
              months={months}
            />
          )}
        </div>
      )}
    </main>
  );
}

