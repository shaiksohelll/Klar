import { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { useOutletContext } from "react-router-dom";
import useFacetFilters, { WINDOW_MONTHS } from "../hooks/useFacetFilters";
import FilterBar from "../components/FilterBar";
import FacetChips from "../components/FacetChips";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// Keyless dark basemap — no API token required.
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const MAP_CENTER = [79, 22];
const MAP_ZOOM = 3.5;

// Per-country currency symbol for the salary popup line.
const CURRENCY_SYMBOL = { in: "Rs", us: "$", gb: "\u00a3", ca: "$", au: "$" };

// Velocity → marker colour. >0 rising (red accent), null/0 flat (grey), <0 cooling.
function velocityColor(velocity) {
  if (velocity == null || velocity === 0) return "#9A9AA6";
  return velocity > 0 ? "#EB0029" : "#5C5C66";
}

// Marker radius grows with sqrt(count) so area ≈ demand. Clamped for sanity.
function markerRadius(count) {
  return Math.max(5, Math.min(34, Math.sqrt(count) * 2.4));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build the popup HTML for one city.
function popupHtml(c) {
  const sym = CURRENCY_SYMBOL[c.country] || "";
  const place = [c.city, c.admin1].filter(Boolean).join(", ");
  const salaryLine =
    c.avgSalary != null
      ? `${sym}${Number(c.avgSalary).toLocaleString()}`
      : "\u2014";
  const velLine =
    c.velocity == null ? "\u2014" : `${c.velocity > 0 ? "+" : ""}${c.velocity}%`;
  return `
    <div style="font-family:ui-monospace,monospace;min-width:170px">
      <div style="color:#F4F4F6;font-weight:700;font-size:13px;margin-bottom:6px">${escapeHtml(place)}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;color:#9A9AA6;font-size:11px;line-height:1.7">
        <span>Jobs</span><span style="color:#F4F4F6">${Number(c.count).toLocaleString()}</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;color:#9A9AA6;font-size:11px;line-height:1.7">
        <span>Avg salary</span><span style="color:#F4F4F6">${salaryLine}</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;color:#9A9AA6;font-size:11px;line-height:1.7">
        <span>Remote</span><span style="color:#F4F4F6">${Number(c.remoteCount || 0).toLocaleString()}</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;color:#9A9AA6;font-size:11px;line-height:1.7">
        <span>30d momentum</span><span style="color:${velocityColor(c.velocity)}">${velLine}</span>
      </div>
    </div>`;
}

export default function AtlasPage() {
  const { filters, setFilter, clearFilter, clearAll, activeChips } =
    useFacetFilters();
  const { role, window: win, remote, disclosed, country, salary } = filters;

  const [cities, setCities] = useState([]);
  const [totalCities, setTotalCities] = useState(0);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Countries list for the FilterBar dropdown — shared from App.jsx.
  const { countries } = useOutletContext();

  // Reset filters AND force a refetch — works even when filters are already
  // at defaults (where clearAll alone would be a no-op).
  const retryAtlas = useCallback(() => {
    clearAll();
    setRetryCount((c) => c + 1);
  }, [clearAll]);

  // ── Map lifecycle ──────────────────────────────────────────────
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false);
  const markersRef = useRef([]);

  // Create the map once on mount; tear it down on unmount.
  useEffect(() => {
    if (!mapContainerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      attributionControl: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      mapReadyRef.current = true;
    });
    mapRef.current = map;
    return () => {
      mapReadyRef.current = false;
      map.remove();
    };
  }, []);

  // ── Fetch atlas data whenever role / window changes ────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // setState lives INSIDE the async IIFE so the synchronous effect body
      // performs no state writes (satisfies react-hooks/set-state-in-effect).
      setLoading(true);
      setError(null);
      try {
        const months = WINDOW_MONTHS[win];
        const params = { months };
        if (role !== "All") params.role = role.toLowerCase();
        if (remote) params.remote = remote;
        if (disclosed) params.disclosed = "1";
        if (country) params.country = country;
        if (salary) params.salary = salary;
        const res = await axios.get(`${API}/api/atlas`, { params });
        if (cancelled) return;
        setCities(res.data.cities || []);
        setTotalCities(res.data.totalCities || 0);
        setTotalJobs(res.data.totalJobs || 0);
      } catch {
        if (!cancelled) setError("Couldn't load the Opportunity Map. Please try again shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [role, win, remote, disclosed, country, salary, retryCount]);

  // ── Render markers whenever cities change (and the map is ready) ─────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    const draw = () => {
      // Clear previous markers.
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];

      for (const c of cities) {
        if (typeof c.lng !== "number" || typeof c.lat !== "number") continue;
        const size = markerRadius(c.count) * 2;
        const el = document.createElement("div");
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.borderRadius = "9999px";
        el.style.background = velocityColor(c.velocity);
        el.style.opacity = "0.72";
        el.style.border = "1px solid rgba(244,244,246,0.35)";
        el.style.cursor = "pointer";
        el.style.boxShadow = "0 0 12px rgba(0,0,0,0.45)";

        const popup = new maplibregl.Popup({ offset: size / 2, closeButton: false }).setHTML(
          popupHtml(c),
        );
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([c.lng, c.lat])
          .setPopup(popup)
          .addTo(map);
        markersRef.current.push(marker);
      }
    };

    if (mapReadyRef.current) {
      draw();
    } else {
      map.once("load", draw);
    }

    return () => {
      map.off("load", draw);
    };
  }, [cities]);

  return (
    <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-3xl mx-auto space-y-6">
        <div className="font-mono text-[var(--accent)] text-xs uppercase tracking-[0.2em] font-bold">
          The Opportunity Map
        </div>
        <h1 className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-[var(--text)]">
          Where the work{" "}
          <span className="text-[var(--accent)] italic">actually</span> is.
        </h1>
        <p className="text-lg md:text-xl text-[var(--muted)] max-w-2xl mx-auto font-medium">
          Job demand, average disclosed salary, and 30-day momentum for every
          verified city. No hype, no predictions. Just the data.
        </p>
        <div className="font-mono text-[var(--muted-2)] text-sm uppercase tracking-widest pt-4 flex items-center justify-center gap-3">
          <div className="w-12 h-px bg-[var(--border)]" />
          <span aria-live="polite">
            {totalCities.toLocaleString()} cities · {totalJobs.toLocaleString()} jobs
          </span>
          <div className="w-12 h-px bg-[var(--border)]" />
        </div>
      </section>

      <FilterBar
        filters={filters}
        setFilter={setFilter}
        countries={countries}
        layoutPrefix="atlas"
      />

      <FacetChips chips={activeChips} clearFilter={clearFilter} clearAll={clearAll} />

      {/* Map card — always mounted so the map instance persists across fetches.
          Loading / error / empty states overlay the card. */}
      <section className="relative">
        <div
          ref={mapContainerRef}
          className="w-full h-[600px] rounded-2xl overflow-hidden border border-[var(--border)] bg-[var(--panel)]"
        />

        {error ? (
          /* ERROR — what happened, why, and how to recover. Not color-only. */
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl bg-[var(--bg)]/85 px-6 text-center"
          >
            <div>
              <h2 className="font-space text-lg font-bold text-[var(--text)]">
                The map couldn't load
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                We hit a snag fetching city demand. It's usually momentary.
              </p>
            </div>
            <button
              onClick={() => retryAtlas()}
              className="inline-flex h-11 items-center rounded-[var(--radius-md)] border border-[var(--border)] px-6 font-sans text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--muted)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
            >
              Reset the view
            </button>
          </div>
        ) : loading ? (
          /* LOADING — shimmer over the reserved map card; no layout shift. */
          <div className="skeleton absolute inset-0 rounded-2xl" aria-busy="true" aria-label="Loading the Opportunity Map" />
        ) : cities.length === 0 ? (
          /* EMPTY — onboarding: tell the user why and the single next action. */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl bg-[var(--bg)]/80 px-6 text-center">
            <div>
              <h2 className="font-space text-lg font-bold text-[var(--text)]">
                No cities in this slice yet
              </h2>
              <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">
                This role and window don't have enough verified postings to map.
                Widen the window or view every role.
              </p>
            </div>
            <button
              onClick={() => retryAtlas()}
              className="inline-flex h-11 items-center rounded-[var(--radius-md)] bg-[var(--accent)] px-6 font-sans text-sm font-medium text-white transition-[background-color,transform] duration-[120ms] [transition-timing-function:var(--ease-spring)] hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
            >
              Show all cities
            </button>
          </div>
        ) : null}

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: "#EB0029" }} /> Rising
          </span>
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: "#9A9AA6" }} /> Flat
          </span>
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ background: "#5C5C66" }} /> Cooling
          </span>
          <span className="ml-auto">Circle size ≈ job demand</span>
        </div>
      </section>
    </main>
  );
}
