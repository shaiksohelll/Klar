import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { motion } from "framer-motion";
import useFacetFilters, { WINDOWS, WINDOW_MONTHS } from "../hooks/useFacetFilters";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Format a signed delta % for display. null renders as an em dash (no baseline).
function deltaLabel(pct) {
  if (pct == null) return "\u2014";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

// One momentum row: skill name, delta % (colour-coded), current posting count.
// `rising` picks the accent-red up styling; falling uses a muted cool grey so
// the signal is not colour-only (the ▲/▼ glyph carries it too).
function MomentumRow({ item, rising, index }) {
  const glyph = item.direction === "new" ? "NEW" : rising ? "\u25b2" : "\u25bc";
  const deltaColor = rising ? "text-[#FF2740]" : "text-[#9A9AA6]";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-3 px-4 py-3 rounded-lg border-b border-[var(--border)] last:border-b-0"
    >
      <div className="w-8 font-mono text-xs text-[var(--muted-2)]">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="flex-1 font-sans font-medium text-[var(--text)] truncate">
        {displayName(item.skill)}
      </div>
      <div className={`w-20 text-right font-mono text-sm font-medium ${deltaColor}`}>
        <span aria-hidden="true" className="mr-1">{glyph}</span>
        {item.direction === "new" ? "" : deltaLabel(item.deltaPct)}
      </div>
      <div className="w-16 text-right font-mono text-xs text-[var(--muted)]">
        {Number(item.current || 0).toLocaleString()}
      </div>
    </motion.div>
  );
}

// A single column (Rising or Falling) with its own empty state.
function MomentumColumn({ title, emoji, items, rising, emptyLabel }) {
  return (
    <div className="border border-[var(--border)] rounded-2xl bg-[var(--panel)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-4 border-b border-[var(--border)]">
        <span aria-hidden="true">{emoji}</span>
        <span className="font-space font-bold text-[var(--text)]">{title}</span>
      </div>
      {/* Column header labels */}
      <div className="flex items-center gap-3 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)] border-b border-[var(--border)]">
        <div className="w-8">#</div>
        <div className="flex-1">Skill</div>
        <div className="w-20 text-right">Change</div>
        <div className="w-16 text-right">Jobs</div>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-[var(--muted)]">
          {emptyLabel}
        </div>
      ) : (
        <div>
          {items.map((item, i) => (
            <MomentumRow key={item.skill} item={item} rising={rising} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrendsPage() {
  // The momentum series is GLOBAL today (no per-role/remote/disclosed/country/
  // salary dimension in the snapshots yet), so only the time window changes the
  // results. We therefore expose a window-only control here and ignore the other
  // facets. FUTURE EXTENSION: once snapshots are recorded per facet, restore the
  // shared FilterBar and pass the extra params through to /api/skills/momentum.
  const { filters, setFilter } = useFacetFilters();
  const { window: win } = filters;

  const [risers, setRisers] = useState([]);
  const [fallers, setFallers] = useState([]);
  const [asOf, setAsOf] = useState(null);
  const [insufficientHistory, setInsufficientHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  const retryTrends = useCallback(() => setRetryCount((c) => c + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // setState inside the async IIFE keeps the synchronous effect body free of
      // state writes (matches AtlasPage's react-hooks/set-state-in-effect fix).
      setLoading(true);
      setError(null);
      try {
        // Window is the only dimension the momentum series supports today.
        const params = { window: WINDOW_MONTHS[win], limit: 20 };
        const res = await axios.get(`${API}/api/skills/momentum`, { params });
        if (cancelled) return;
        setRisers(res.data.risers || []);
        setFallers(res.data.fallers || []);
        setAsOf(res.data.asOf || null);
        setInsufficientHistory(!!res.data.insufficientHistory);
      } catch {
        if (!cancelled) setError("Couldn't load Trends. Please try again shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Window is the only input that affects momentum results today.
  }, [win, retryCount]);

  return (
    <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-3xl mx-auto space-y-6">
        <div className="font-mono text-[var(--accent)] text-xs uppercase tracking-[0.2em] font-bold">
          The Momentum Report
        </div>
        <h1 className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-[var(--text)]">
          Which skills are{" "}
          <span className="text-[var(--accent)] italic">rising</span>.
        </h1>
        <p className="text-lg md:text-xl text-[var(--muted)] max-w-2xl mx-auto font-medium">
          Trend over time, not just a snapshot. We compare the latest window to
          the one before it to show what's heating up and what's cooling down.
        </p>
        {asOf && !insufficientHistory && (
          <div className="font-mono text-[var(--muted-2)] text-xs uppercase tracking-widest pt-2">
            As of {new Date(asOf).toLocaleDateString()}
          </div>
        )}
      </section>

      {/* Window-only control. Momentum is global today, so no role/remote/etc
          filters here — showing controls that do nothing would mislead. */}
      <section className="flex justify-center border-b border-[var(--border)] pb-6">
        <div
          className="flex bg-[var(--panel)] border border-[var(--border)] rounded-full p-1"
          role="group"
          aria-label="Time window"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setFilter("window", w)}
              aria-pressed={win === w}
              className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                win === w
                  ? "text-white"
                  : "text-[var(--muted-2)] hover:text-[var(--muted)]"
              }`}
            >
              {win === w && (
                <motion.div
                  layoutId="trendsActiveWindow"
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={{ type: "spring", stiffness: 180, damping: 22 }}
                />
              )}
              {w}
            </button>
          ))}
        </div>
      </section>

      {error ? (
        /* ERROR — what/why/next; retry is not colour-only. */
        <div
          role="alert"
          className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-6 text-center"
        >
          <h2 className="font-space text-lg font-bold text-[var(--text)]">
            We couldn't load Trends
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            The market feed didn't respond just now. It usually recovers within
            a few seconds.
          </p>
          <button
            onClick={retryTrends}
            className="mt-5 inline-flex h-11 items-center rounded-[var(--radius-md)] border border-[var(--border)] px-6 font-sans text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--muted)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        /* LOADING — two-column skeleton mirroring the final layout. */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[0, 1].map((col) => (
            <div key={col} className="border border-[var(--border)] rounded-2xl bg-[var(--panel)] p-4 space-y-3">
              <div className="skeleton h-4 w-28" />
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton h-6 w-full" />
              ))}
            </div>
          ))}
        </div>
      ) : insufficientHistory ? (
        /* COLD START — friendly empty state, NOT an error. History accrues from
           the daily cron; nothing is fabricated. */
        <div className="mx-auto max-w-lg rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-10 text-center">
          <div className="text-3xl" aria-hidden="true">📈</div>
          <h2 className="mt-3 font-space text-xl font-bold text-[var(--text)]">
            Banking trend data
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            Trends compare two windows of history. We're recording the market
            every day — check back as history builds and rising vs falling
            skills will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <MomentumColumn
            title="Rising"
            emoji="🔼"
            items={risers}
            rising
            emptyLabel="No rising skills in this slice yet."
          />
          <MomentumColumn
            title="Falling"
            emoji="🔽"
            items={fallers}
            rising={false}
            emptyLabel="No falling skills in this slice yet."
          />
        </div>
      )}

      <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)] text-center">
        Momentum compares the most recent window against the prior window of
        equal length. Descriptive, not predictive.
      </p>
    </main>
  );
}
