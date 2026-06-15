import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { RankingList } from "../components/RankingList";
import { SkillGap } from "../components/SkillGap";

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
    activeWindow,
  } = ctx;

  const months = WINDOW_MONTHS[activeWindow] ?? 12;

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
        <div className="text-center py-20 font-mono text-sm text-[var(--muted-2)] uppercase tracking-widest animate-pulse">
          Loading…
        </div>
      ) : watched.length === 0 && watchlistError ? (
        <div className="text-center py-20 font-mono text-sm text-[var(--muted)] space-y-4">
          <p>{watchlistError}</p>
          <button
            onClick={retryWatchlist}
            className="underline hover:text-[var(--text)] transition-colors"
          >
            Try again
          </button>
        </div>
      ) : watched.length === 0 ? (
        <div className="text-center py-20 font-mono text-sm text-[var(--muted-2)] leading-relaxed">
          No tracked skills yet. Tap the star on any skill in the Demand report
          to add it here.
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

