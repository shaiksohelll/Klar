import { useState, useEffect, useMemo, useRef, Suspense, useCallback, Component } from "react";
import axios from "axios";
import {
  UserButton,
  useUser,
  useAuth,
  useClerk,
} from "@clerk/clerk-react";
import Silk from "./components/Silk";
import { Outlet, useLocation } from "react-router-dom";
import { SkillDrawer } from "./components/SkillDrawer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import Brand from "./components/Brand";
import ThemeToggle from "./components/ThemeToggle";
import Nav, { NavRoutes } from "./components/ui/Nav";
import Sheet from "./components/ui/Sheet";
import { getInitialTheme, applyTheme } from "./lib/theme";
import useFacetFilters, { WINDOW_MONTHS } from "./hooks/useFacetFilters";

// Lightweight fallback shown while a lazily-loaded route page is fetched.
const PageLoader = () => (
  <div className="min-h-[60vh] flex items-center justify-center">
    <div className="w-6 h-6 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
  </div>
);

// Tiny error boundary for the Silk WebGL background. If WebGL init fails
// (unsupported browser, disabled hardware accel, headless/test), the app just
// loses its background instead of crashing.
class SilkBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.warn("Silk background disabled:", err); }
  render() { return this.state.failed ? null : this.props.children; }
}

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const ALL_WINDOWS = ["3M", "6M", "12M"];


// Turn an ISO timestamp into a short "Xh ago" string.
function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Fetch + shape trending data for a role/window. Pure helper, reused for prefetch.
async function fetchTrending(role, win, remoteFilter, disclosedFilter, countryFilter, salaryFilter) {
  const months = WINDOW_MONTHS[win];
  const params = { months, limit: 25 };
  if (role !== "All") params.role = role.toLowerCase();
  if (remoteFilter) params.remote = remoteFilter;
  if (disclosedFilter) params.disclosed = "1";
  if (countryFilter) params.country = countryFilter;
  if (salaryFilter) params.salary = salaryFilter;
  const res = await axios.get(`${API}/api/skills/trending`, { params });
  const total = res.data.totalJobs || 0;
  const lastUpdated = res.data.lastUpdated || null;
  const velocityReady = res.data.velocityReady ?? false;
  const velocityBasisDays = res.data.velocityBasisDays ?? null;
  const skills = (res.data.skills || []).map((s) => ({
    id: s.skill,
    name: s.skill,
    count: s.demand,
    remoteCount: s.remoteCount || 0,
    share: total ? Math.round((s.demand / total) * 100) : 0,
    role: role === "All" ? "General" : role,
    velocity: s.velocity ?? null,
    trend: s.trend ?? "flat",
    avgSalary: s.avgSalary ?? null,
    salaryCurrency: s.salaryCurrency ?? null,
    disclosedCount: s.disclosedCount ?? 0,
    limitedData: s.limitedData ?? false,
  }));
  return {
    skills,
    totalJobs: total,
    lastUpdated,
    velocityReady,
    velocityBasisDays,
  };
}

export default function App() {
  const [skills, setSkills] = useState([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [velocityReady, setVelocityReady] = useState(false);
  const [velocityBasisDays, setVelocityBasisDays] = useState(null);
  // URL is the single source of truth for facet state.
  // useFacetFilters reads useSearchParams which is seeded from the current URL
  // on mount, so deep-linked pages get the correct cache key on first render.
  const { filters } = useFacetFilters();
  const { role: activeRole, window: activeWindow, remote, disclosed, country, salary } = filters;

  const [countries, setCountries] = useState([]);
  const [trackedSkills, setTrackedSkills] = useState([]);
  const [watchlistError, setWatchlistError] = useState(null);
  // Which userId the current trackedSkills were fetched for. null means the
  // data is stale/absent; effectiveTrackedSkills returns [] until it matches.
  const [trackedSkillsOwner, setTrackedSkillsOwner] = useState(null);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Incrementing this forces the watchlist effect to re-run (manual retry).
  const [watchlistRetry, setWatchlistRetry] = useState(0);
  
  // Forces a refetch of trending data.
  const [retryCount, setRetryCount] = useState(0);
  const retryDemand = useCallback(() => {
    setRetryCount((c) => c + 1);
  }, []);

  // Mobile nav glass sheet open state.
  const [menuOpen, setMenuOpen] = useState(false);

  // In-memory cache keyed by "role|window" so repeat switches are instant.
  const cacheRef = useRef(new Map());
  // Tracks the most recently seen signed-in user id so we can distinguish an
  // initial null → id transition (Clerk resolving on load) from a genuine
  // account switch between two different signed-in users.
  const prevUserIdRef = useRef(null);
  // Monotonically incrementing counter shared by the watchlist GET and every
  // track/untrack mutation. The operation that sets the highest number is the
  // most recent; any response that arrives with a lower number is stale and
  // is discarded before it can overwrite newer state.
  const watchlistSeqRef = useRef(0);

  const { isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const { openSignIn, signOut } = useClerk();
  const location = useLocation();

  // Resolve + apply the theme once on mount (the inline FOUC guard already set
  // the attribute before paint; this keeps localStorage + attribute in sync),
  // then enable the cross-fade transition AFTER the first paint so the initial
  // render never animates. All state writes live inside the effect body here
  // are DOM/class side effects only (no React setState), so the
  // react-hooks/set-state-in-effect rule is not triggered.
  useEffect(() => {
    applyTheme(getInitialTheme());
    const id = requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-ready");
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Build an axios config with a fresh Clerk JWT in the Authorization header.
  // Throws if the token is unavailable so callers never send "Bearer null".
  const authConfig = async () => {
    const token = await getToken();
    if (!token) throw new Error("Clerk token unavailable");
    return { headers: { Authorization: `Bearer ${token}` } };
  };

  useEffect(() => {
    const key = `${activeRole}|${activeWindow}|${remote || "any"}|${disclosed ? "yes" : "no"}|${country || "any"}|${salary || "any"}`;
    let cancelled = false;
    const cached = cacheRef.current.get(key);

    if (cached) {
      // Serve instantly from cache, no spinner.
      setSkills(cached.skills);
      setTotalJobs(cached.totalJobs);
      setLastUpdated(cached.lastUpdated);
      setVelocityReady(cached.velocityReady ?? false);
      setVelocityBasisDays(cached.velocityBasisDays ?? null);
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
    }

    (async () => {
      try {
        const data = await fetchTrending(activeRole, activeWindow, remote, disclosed, country, salary);
        if (cancelled) return;
        cacheRef.current.set(key, data);
        setSkills(data.skills);
        setTotalJobs(data.totalJobs);
        setLastUpdated(data.lastUpdated);
        setVelocityReady(data.velocityReady);
        setVelocityBasisDays(data.velocityBasisDays);
        setError(null);
      } catch {
        if (!cancelled && !cached)
          setError("Couldn't load demand data. Please try again shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Quietly prefetch the other windows for this role in the background.
      if (!cancelled) {
        for (const win of ALL_WINDOWS) {
          const k = `${activeRole}|${win}|${remote || "any"}|${disclosed ? "yes" : "no"}|${country || "any"}|${salary || "any"}`;
          if (!cacheRef.current.has(k)) {
            fetchTrending(activeRole, win, remote, disclosed, country, salary)
              .then((d) => cacheRef.current.set(k, d))
              .catch(() => {});
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRole, activeWindow, remote, disclosed, country, salary, retryCount]);

  const sorted = useMemo(
    () => [...skills].sort((a, b) => b.count - a.count),
    [skills],
  );

  const maxCount = useMemo(
    () => (sorted.length ? Math.max(...sorted.map((s) => s.count)) : 1),
    [sorted],
  );

  // Fetch distinct countries for the FilterBar dropdown (fire-and-forget, once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API}/api/places/countries`);
        if (!cancelled) setCountries(res.data.countries || []);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Derive what the UI should display. When the user is signed out (or Clerk
  // is still resolving), return a stable empty array so child components never
  // render a previous account's tracked skills. The raw `trackedSkills` state
  // keeps its value in memory so it is ready the instant the next fetch lands.
  // Return the loaded list only when the data was fetched for the currently
  // signed-in user. Comparing against user (not user?.id) matches the dep the
  // React Compiler infers. Returns [] when: signed out, mid-fetch, or the
  // owner doesn't match yet (e.g. right after an account switch or sign-in).
  const effectiveTrackedSkills = useMemo(
    () => (isSignedIn && trackedSkillsOwner === user?.id ? trackedSkills : []),
    [isSignedIn, user, trackedSkillsOwner, trackedSkills],
  );

  // Load the user's watchlist whenever they sign in, the account changes, or
  // the user manually retries after an error.
  useEffect(() => {
    const currentId = user?.id ?? null;
    const prevId = prevUserIdRef.current;

    if (!isSignedIn || !currentId) {
      // Signed out or Clerk still resolving — reset the id ref and invalidate
      // any in-flight fetch. effectiveTrackedSkills already returns [] when
      // isSignedIn is false, and the owner comparison guards the next sign-in,
      // so no setState is needed here.
      prevUserIdRef.current = null;
      ++watchlistSeqRef.current;
      return;
    }

    // Record the current id before the async work so the NEXT run can compare.
    prevUserIdRef.current = currentId;

    // Only wipe the in-memory list when genuinely switching between two
    // different signed-in accounts. The initial null → id transition (Clerk
    // resolving the session on page load) is NOT a switch — skipping the clear
    // there prevents a flash of the empty watchlist while getToken() runs.
    if (prevId !== null && prevId !== currentId) {
      // Clear the owner immediately so effectiveTrackedSkills returns [] for
      // this render, and bump the sequence to invalidate the previous
      // account's in-flight requests before the new fetch begins.
      setTrackedSkillsOwner(null);
      ++watchlistSeqRef.current;
      setTrackedSkills([]);
      setWatchlistError(null);
    }

    // Claim a sequence slot for this GET. Any handleTrack mutation that starts
    // while this request is in-flight will take a higher number; when this
    // response arrives it will see the higher number and self-discard.
    const seq = ++watchlistSeqRef.current;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) {
          // Clerk is still initialising; keep whatever list is in memory.
          if (!cancelled && watchlistSeqRef.current === seq)
            setWatchlistError("Watchlist unavailable. Retry.");
          return;
        }
        const res = await axios.get(`${API}/api/watchlist`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled && watchlistSeqRef.current === seq) {
          // Batch the owner update with the data update so effectiveTracked
          // Skills transitions from [] to the real list in a single render.
          setTrackedSkillsOwner(currentId);
          setTrackedSkills(res.data.skills || []);
          setWatchlistError(null);
        }
      } catch {
        // Network or auth error. Keep existing items; surface a retry prompt.
        if (!cancelled && watchlistSeqRef.current === seq)
          setWatchlistError("Watchlist unavailable. Retry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, user?.id, watchlistRetry, getToken]);

  const handleTrack = async (id) => {
    if (!isSignedIn) {
      openSignIn();
      return;
    }
    const wasTracked = trackedSkills.includes(id);
    // Optimistic update — roll back on failure.
    setTrackedSkills((prev) =>
      wasTracked ? prev.filter((s) => s !== id) : [...prev, id],
    );
    // Claim the sequence BEFORE any await so that an in-flight initial GET
    // will see a lower number and discard its (now stale) response.
    const seq = ++watchlistSeqRef.current;
    try {
      const config = await authConfig();
      const res = wasTracked
        ? await axios.delete(`${API}/api/watchlist`, {
            ...config,
            data: { skill: id },
          })
        : await axios.post(`${API}/api/watchlist`, { skill: id }, config);
      if (watchlistSeqRef.current === seq) {
        setTrackedSkills(res.data.skills || []);
      }
    } catch {
      // Roll back the optimistic update only if no newer request has since
      // taken ownership — a stale failed request must not undo newer state.
      if (watchlistSeqRef.current === seq) {
        setTrackedSkills((prev) =>
          wasTracked ? [...prev, id] : prev.filter((s) => s !== id),
        );
      }
    }
  };

  const outletContext = {
    sorted,
    maxCount,
    totalJobs,
    countries,
    trackedSkills: effectiveTrackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    error,
    velocityReady,
    velocityBasisDays,
    watchlistError,
    retryWatchlist: () => setWatchlistRetry((c) => c + 1),
    retryDemand,
    getToken,
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] font-sans selection:bg-[#EB0029]/30 selection:text-white pb-24 overflow-x-hidden">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-200 h-100 bg-[var(--accent)] rounded-[100%] blur-[150px] opacity-[0.07] pointer-events-none" />
      {/* Silk ambient background */}
      <SilkBoundary>
        <div className="fixed inset-0 pointer-events-none">
          <Silk color="#EB0029" speed={5} scale={1} noiseIntensity={1.5} rotation={0} />
          {/* keep this overlay so text stays readable */}
          <div className="absolute inset-0 bg-black/50" />
        </div>
      </SilkBoundary>

      <Nav
        freshness={lastUpdated ? timeAgo(lastUpdated) : null}
        signedIn={!!isSignedIn}
        onSignIn={() => openSignIn()}
        onSignOut={() => signOut()}
        onOpenMenu={() => setMenuOpen(true)}
        userButton={<UserButton afterSignOutUrl="/" />}
      />

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} label="Menu">
        <div className="flex h-full flex-col gap-6 p-6">
          <div className="flex items-center justify-between">
            <span className="font-space text-lg font-bold tracking-tight text-[var(--text)]">
              <Brand />
            </span>
            <ThemeToggle />
          </div>
          <nav className="flex flex-col gap-4">
            <NavRoutes onNavigate={() => setMenuOpen(false)} className="text-sm" />
          </nav>
          <div className="mt-auto border-t border-[var(--border)] pt-5">
            {isSignedIn ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  signOut();
                }}
                className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openSignIn();
                }}
                className="inline-flex h-11 w-full items-center justify-center rounded-[var(--radius-pill)] bg-[var(--accent)] px-5 font-sans text-sm font-medium text-white transition-[background-color,transform] duration-[120ms] [transition-timing-function:var(--ease-spring)] hover:bg-[var(--accent-hover)] active:scale-[0.98]"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </Sheet>

      <ErrorBoundary key={location.pathname}>
        <Suspense fallback={<PageLoader />}>
          <Outlet context={outletContext} />
        </Suspense>
      </ErrorBoundary>

      <footer className="max-w-6xl mx-auto px-6 mt-32 pt-8 border-t border-[var(--border)] flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="font-space font-bold text-xl tracking-tight text-[var(--text)] flex items-baseline opacity-50">
          <Brand />
        </div>
        <div className="font-mono text-xs text-[var(--muted-2)] uppercase tracking-wider text-center md:text-right">
          A snapshot of current demand, not a prediction.
        </div>
      </footer>

      <SkillDrawer
        skill={selectedSkill}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onTrack={handleTrack}
        tracked={effectiveTrackedSkills}
        months={WINDOW_MONTHS[activeWindow]}
      />
    </div>
  );
}
