import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { motion } from "framer-motion";
import useFacetFilters, { HORIZONS, HORIZON_MONTHS, ROLES } from "../hooks/useFacetFilters";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── Trajectory presentation ──────────────────────────────────────
// Glyph + colour together — never colour-only — so the signal survives colour
// blindness / greyscale. Colours use the Klar accent family for up-signals and
// a muted cool grey for down-signals.
const TRAJECTORY = {
  accelerating: { glyph: "\u25b2", label: "Accelerating", color: "#EB0029" },
  rising: { glyph: "\u25b2", label: "Rising", color: "#FF2740" },
  plateauing: { glyph: "\u25ac", label: "Plateauing", color: "#9A9AA6" },
  declining: { glyph: "\u25bc", label: "Declining", color: "#7C7C88" },
};

function changeLabel(pct) {
  if (pct == null) return "\u2014";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

// Confidence as a 0..100 whole number for the meter + label.
function confidencePct(c) {
  const n = Math.round((c ?? 0) * 100);
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

/**
 * ForecastMiniChart — a compact SVG built ONLY from real API scalars:
 *   - a SOLID segment from the current level (left) toward the projection,
 *   - a DASHED segment to the projected point (right),
 *   - a shaded band spanning [low, high] around the projection.
 * No intermediate history points are invented; this is a faithful 2-anchor
 * visual (now → horizon), matching the honest-data constraint.
 */
function ForecastMiniChart({ current, forecast, low, high, up }) {
  const W = 220;
  const H = 64;
  const padX = 8;
  const padY = 10;
  const maxV = Math.max(current, forecast, high, 1);
  const x0 = padX;
  const x1 = W - padX;
  const y = (v) => H - padY - (v / maxV) * (H - padY * 2);
  const stroke = up ? "#FF2740" : "#7C7C88";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-16"
      role="img"
      aria-label={`Projected demand from ${current} to ${forecast}`}
      preserveAspectRatio="none"
    >
      {/* Confidence band: shaded quad between low and high at the horizon end. */}
      <polygon
        points={`${x0},${y(current)} ${x1},${y(high)} ${x1},${y(low)}`}
        fill={stroke}
        opacity="0.12"
      />
      {/* Solid current anchor tick. */}
      <line x1={x0} y1={y(current)} x2={x0 + 2} y2={y(current)} stroke={stroke} strokeWidth="3" />
      {/* Dashed projection line current → forecast. */}
      <line
        x1={x0}
        y1={y(current)}
        x2={x1}
        y2={y(forecast)}
        stroke={stroke}
        strokeWidth="2"
        strokeDasharray="5 4"
        strokeLinecap="round"
      />
      {/* Endpoint dot at the projection. */}
      <circle cx={x1} cy={y(forecast)} r="3" fill={stroke} />
    </svg>
  );
}

function ForecastCard({ item, index }) {
  const t = TRAJECTORY[item.trajectory] || TRAJECTORY.plateauing;
  const up = item.trajectory === "rising" || item.trajectory === "accelerating";
  const conf = confidencePct(item.confidence);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="border border-[var(--border)] rounded-2xl bg-[var(--panel)] p-5 flex flex-col gap-3"
    >
      {/* Header: rank + name + trajectory badge */}
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-[var(--muted-2)] w-6 text-right shrink-0">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="flex-1 font-space font-bold text-[var(--text)] truncate">
          {displayName(item.skill)}
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          style={{ color: t.color, borderColor: t.color }}
        >
          <span aria-hidden="true">{t.glyph}</span>
          {t.label}
        </span>
      </div>

      {/* Current → projected demand */}
      <div className="flex items-baseline gap-2 font-mono text-sm">
        <span className="text-[var(--muted)]">{Number(item.current).toLocaleString()}</span>
        <span className="text-[var(--muted-2)]" aria-hidden="true">→</span>
        <span className="text-[var(--text)] font-bold">{Number(item.forecast).toLocaleString()}</span>
        <span
          className="ml-1"
          style={{ color: up ? "#FF2740" : "#9A9AA6" }}
        >
          {changeLabel(item.changePct)}
        </span>
      </div>

      <ForecastMiniChart
        current={item.current}
        forecast={item.forecast}
        low={item.low}
        high={item.high}
        up={up}
      />

      {/* Confidence meter + basis */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">Conf</span>
        <div
          className="flex-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden"
          role="meter"
          aria-valuenow={conf}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Forecast confidence for ${displayName(item.skill)}`}
        >
          <div className="h-full rounded-full bg-gradient-to-r from-[#FF2740] to-[#C70022]" style={{ width: `${conf}%` }} />
        </div>
        <span className="font-mono text-[10px] tabular-nums text-[var(--muted)]">{conf}%</span>
        <span className="font-mono text-[10px] text-[var(--muted-2)]">· {item.basisPoints} pts</span>
      </div>
    </motion.div>
  );
}

export default function ForecastPage() {
  const { filters, setFilter } = useFacetFilters();
  const { horizon, role: activeRole } = filters;

  const [forecasts, setForecasts] = useState([]);
  const [asOf, setAsOf] = useState(null);
  const [insufficientHistory, setInsufficientHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = { horizon: HORIZON_MONTHS[horizon], limit: 20 };
        if (activeRole && activeRole !== "All") params.role = activeRole.toLowerCase();
        const res = await axios.get(`${API}/api/skills/forecast`, { params });
        if (cancelled) return;
        setForecasts(res.data.forecasts || []);
        setAsOf(res.data.asOf || null);
        setInsufficientHistory(!!res.data.insufficientHistory);
      } catch {
        if (!cancelled) setError("Couldn't load Foresight. Please try again shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [horizon, activeRole, retryCount]);

  return (
    <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-3xl mx-auto space-y-6">
        <div className="font-mono text-[var(--accent)] text-xs uppercase tracking-[0.2em] font-bold">
          Foresight
        </div>
        <h1 className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-[var(--text)]">
          Where demand is{" "}
          <span className="text-[var(--accent)] italic">heading</span>.
        </h1>
        <p className="text-lg md:text-xl text-[var(--muted)] max-w-2xl mx-auto font-medium">
          A transparent least-squares trend over the demand history we bank every
          day, projected forward. A model you can audit — not a black box.
        </p>
        {asOf && !insufficientHistory && (
          <div className="font-mono text-[var(--muted-2)] text-xs uppercase tracking-widest pt-2">
            As of {new Date(asOf).toLocaleDateString()}
          </div>
        )}
      </section>

      {/* Controls: horizon + role */}
      <section className="flex flex-wrap justify-center gap-3 border-b border-[var(--border)] pb-6">
        <div className="flex bg-[var(--panel)] border border-[var(--border)] rounded-full p-1" role="group" aria-label="Forecast horizon">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setFilter("horizon", h)}
              aria-pressed={horizon === h}
              className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                horizon === h ? "text-white" : "text-[var(--muted-2)] hover:text-[var(--muted)]"
              }`}
            >
              {horizon === h && (
                <motion.div
                  layoutId="forecastActiveHorizon"
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={{ type: "spring", stiffness: 180, damping: 22 }}
                />
              )}
              {h}
            </button>
          ))}
        </div>

        <select
          value={activeRole}
          onChange={(e) => setFilter("role", e.target.value)}
          aria-label="Filter forecast by role"
          className="h-9 rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg)] px-3 font-mono text-[11px] uppercase tracking-wider text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] cursor-pointer"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{r === "All" ? "All roles" : r}</option>
          ))}
        </select>
      </section>

      {error ? (
        <div
          role="alert"
          className="mx-auto max-w-md rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-6 text-center"
        >
          <h2 className="font-space text-lg font-bold text-[var(--text)]">We couldn't load Foresight</h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            The market feed didn't respond just now. It usually recovers within a few seconds.
          </p>
          <button
            onClick={retry}
            className="mt-5 inline-flex h-11 items-center rounded-[var(--radius-md)] border border-[var(--border)] px-6 font-sans text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--muted)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="border border-[var(--border)] rounded-2xl bg-[var(--panel)] p-5 space-y-3">
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-2 w-full" />
            </div>
          ))}
        </div>
      ) : insufficientHistory ? (
        /* COLD START — friendly, NOT an error. Nothing is fabricated. */
        <div className="mx-auto max-w-lg rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] p-10 text-center">
          <div className="text-3xl" aria-hidden="true">🔮</div>
          <h2 className="mt-3 font-space text-xl font-bold text-[var(--text)]">Banking history</h2>
          <p className="mt-2 text-sm text-[var(--muted)] leading-relaxed">
            Forecasts sharpen as data accrues. We're recording the market every
            day — check back as history builds and projections will appear here.
          </p>
        </div>
      ) : forecasts.length === 0 ? (
        <div className="py-10 text-center font-mono text-xs text-[var(--muted-2)]">
          No forecasts for this slice yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {forecasts.map((item, i) => (
            <ForecastCard key={item.skill} item={item} index={i} />
          ))}
        </div>
      )}

      <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)] text-center">
        A least-squares projection of banked demand history. Confidence reflects
        goodness of fit and how much history backs it — not a guarantee.
      </p>
    </main>
  );
}
