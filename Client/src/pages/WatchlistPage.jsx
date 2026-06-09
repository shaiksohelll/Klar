import { useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { RankingList } from "../components/RankingList";

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
  } = ctx;

  const watched = useMemo(
    () => sorted.filter((s) => trackedSkills.includes(s.id)),
    [sorted, trackedSkills],
  );

  return (
    <main className="max-w-3xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-2xl mx-auto space-y-4">
        <div className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold">
          Your Watchlist
        </div>
        <h1 className="font-space font-bold text-4xl md:text-6xl leading-[1.05] tracking-tight text-white">
          Skills you're tracking.
        </h1>
        <p className="text-base md:text-lg text-[#9A9AA6] font-medium">
          The skills you starred, ranked by current market demand.
        </p>
      </section>

      {loading ? (
        <div className="text-center py-20 font-mono text-sm text-[#5C5C66] uppercase tracking-widest animate-pulse">
          Loading…
        </div>
      ) : watched.length === 0 && watchlistError ? (
        <div className="text-center py-20 font-mono text-sm text-[#9A9AA6] space-y-4">
          <p>{watchlistError}</p>
          <button
            onClick={retryWatchlist}
            className="underline hover:text-white transition-colors"
          >
            Try again
          </button>
        </div>
      ) : watched.length === 0 ? (
        <div className="text-center py-20 font-mono text-sm text-[#5C5C66] leading-relaxed">
          No tracked skills yet. Tap the star on any skill in the Demand report
          to add it here.
        </div>
      ) : (
        <RankingList
          skills={watched}
          maxCount={maxCount}
          onSelect={setSelectedSkill}
          onTrack={handleTrack}
          tracked={trackedSkills}
        />
      )}
    </main>
  );
}
