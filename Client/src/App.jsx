import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import axios from "axios";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
  useAuth,
  useClerk,
} from "@clerk/clerk-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { SkillDrawer } from "./components/SkillDrawer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import Brand from "./components/Brand";

// Lightweight fallback shown while a lazily-loaded route page is fetched.
const PageLoader = () => (
  <div className="min-h-[60vh] flex items-center justify-center">
    <div className="w-6 h-6 rounded-full border-2 border-[#26262E] border-t-[#EB0029] animate-spin" />
  </div>
);

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
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
async function fetchTrending(role, win) {
  const months = WINDOW_MONTHS[win];
  const params = { months, limit: 25 };
  if (role !== "All") params.role = role.toLowerCase();
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
  const [activeRole, setActiveRole] = useState("All");
  const [activeWindow, setActiveWindow] = useState("12M");
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

  // Build an axios config with a fresh Clerk JWT in the Authorization header.
  // Throws if the token is unavailable so callers never send "Bearer null".
  const authConfig = async () => {
    const token = await getToken();
    if (!token) throw new Error("Clerk token unavailable");
    return { headers: { Authorization: `Bearer ${token}` } };
  };

  useEffect(() => {
    const key = `${activeRole}|${activeWindow}`;
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
        const data = await fetchTrending(activeRole, activeWindow);
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
          const k = `${activeRole}|${win}`;
          if (!cacheRef.current.has(k)) {
            fetchTrending(activeRole, win)
              .then((d) => cacheRef.current.set(k, d))
              .catch(() => {});
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRole, activeWindow]);

  const sorted = useMemo(
    () => [...skills].sort((a, b) => b.count - a.count),
    [skills],
  );

  const maxCount = useMemo(
    () => (sorted.length ? Math.max(...sorted.map((s) => s.count)) : 1),
    [sorted],
  );

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
            setWatchlistError("Watchlist unavailable — retry");
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
          setWatchlistError("Watchlist unavailable — retry");
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

  const navClass = (state) =>
    state.isActive ? "text-white" : "hover:text-white transition-colors";

  const outletContext = {
    sorted,
    maxCount,
    totalJobs,
    activeRole,
    setActiveRole,
    activeWindow,
    setActiveWindow,
    trackedSkills: effectiveTrackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    error,
    velocityReady,
    velocityBasisDays,
    watchlistError,
    retryWatchlist: () => setWatchlistRetry((c) => c + 1),
    getToken,
  };

  return (
    <div className="min-h-screen bg-[#08080A] text-[#F4F4F6] font-sans selection:bg-[#EB0029]/30 selection:text-white pb-24 overflow-x-hidden">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-200 h-100 bg-[#EB0029] rounded-[100%] blur-[150px] opacity-[0.07] pointer-events-none" />

      <nav className="sticky top-0 z-40 bg-[#08080A]/70 backdrop-blur-xl border-b border-[#26262E]">
        <div className="relative max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <NavLink
            to="/"
            className="font-space font-bold text-xl tracking-tight text-white flex items-baseline"
          >
            Klar<span className="text-[#EB0029]">.</span>
          </NavLink>

          <div className="hidden md:flex items-center gap-8 font-mono text-xs uppercase tracking-widest text-[#9A9AA6] absolute left-1/2 -translate-x-1/2">
            <NavLink to="/" end className={navClass}>
              Demand
            </NavLink>
            <NavLink to="/atlas" className={navClass}>
              Atlas
            </NavLink>
            <NavLink to="/relocate" className={navClass}>
              Relocate
            </NavLink>
            <NavLink to="/compare" className={navClass}>
              Compare
            </NavLink>
            <NavLink to="/hiring" className={navClass}>
              Hiring
            </NavLink>
            <NavLink to="/watchlist" className={navClass}>
              Watchlist
            </NavLink>
            <NavLink to="/resume" className={navClass}>
              Resume Gap
            </NavLink>
            <NavLink to="/about" className={navClass}>
              About
            </NavLink>
          </div>

          <div className="flex items-center gap-4">
            {lastUpdated && (
              <span className="hidden sm:flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-[#5C5C66] mr-1 pr-4 border-r border-[#26262E]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#EB0029] animate-pulse" />
                Updated {timeAgo(lastUpdated)}
              </span>
            )}
            <SignedOut>
              <SignInButton mode="modal">
                <button className="bg-[#EB0029] hover:bg-[#FF2740] text-white px-5 py-2 rounded-full font-medium text-sm transition-all shadow-[0_0_20px_rgba(235,0,41,0.2)] hover:shadow-[0_0_30px_rgba(255,39,64,0.4)] hover:-translate-y-0.5">
                  Sign in
                </button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button
                onClick={() => signOut()}
                className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6] hover:text-white transition-colors"
              >
                Sign out
              </button>
              <UserButton afterSignOutUrl="/" />
            </SignedIn>
          </div>
        </div>
      </nav>

      <ErrorBoundary key={location.pathname}>
        <Suspense fallback={<PageLoader />}>
          <Outlet context={outletContext} />
        </Suspense>
      </ErrorBoundary>

      <footer className="max-w-6xl mx-auto px-6 mt-32 pt-8 border-t border-[#26262E] flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="font-space font-bold text-xl tracking-tight text-white flex items-baseline opacity-50">
          <Brand />
        </div>
        <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider text-center md:text-right">
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
