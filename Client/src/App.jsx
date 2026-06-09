import { useState, useEffect, useMemo, useRef } from "react";
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
import { NavLink, Outlet } from "react-router-dom";
import { SkillDrawer } from "./components/SkillDrawer";

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
  const skills = (res.data.skills || []).map((s) => ({
    id: s.skill,
    name: s.skill,
    count: s.demand,
    remoteCount: s.remoteCount || 0,
    share: total ? Math.round((s.demand / total) * 100) : 0,
    role: role === "All" ? "General" : role,
  }));
  return { skills, totalJobs: total, lastUpdated };
}

export default function App() {
  const [skills, setSkills] = useState([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeRole, setActiveRole] = useState("All");
  const [activeWindow, setActiveWindow] = useState("12M");
  const [trackedSkills, setTrackedSkills] = useState([]);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // In-memory cache keyed by "role|window" so repeat switches are instant.
  const cacheRef = useRef(new Map());

  const { isSignedIn, user } = useUser();
  const { getToken } = useAuth();
  const { openSignIn, signOut } = useClerk();

  // Build an axios config with a fresh Clerk JWT in the Authorization header.
  // The server verifies this token — the userId is never trusted from the client.
  const authConfig = async () => {
    const token = await getToken();
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
        setError(null);
      } catch (err) {
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

  // Load the user's watchlist from the server whenever they sign in or the
  // active account changes. Clear immediately on any identity change so the
  // previous account's list is never shown to the new account, even briefly.
  useEffect(() => {
    if (!isSignedIn || !user) {
      setTrackedSkills([]);
      return;
    }
    setTrackedSkills([]);
    let cancelled = false;
    (async () => {
      try {
        const config = await authConfig();
        const res = await axios.get(`${API}/api/watchlist`, config);
        if (!cancelled) setTrackedSkills(res.data.skills || []);
      } catch {
        // Non-critical: watchlist just stays empty if the fetch fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, user?.id]);

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
    try {
      const config = await authConfig();
      const res = wasTracked
        ? await axios.delete(`${API}/api/watchlist`, {
            ...config,
            data: { skill: id },
          })
        : await axios.post(`${API}/api/watchlist`, { skill: id }, config);
      setTrackedSkills(res.data.skills || []);
    } catch {
      // Roll back the optimistic update.
      setTrackedSkills((prev) =>
        wasTracked ? [...prev, id] : prev.filter((s) => s !== id),
      );
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
    trackedSkills,
    handleTrack,
    setSelectedSkill,
    loading,
    error,
  };

  return (
    <div className="min-h-screen bg-[#08080A] text-[#F4F4F6] font-sans selection:bg-[#EB0029]/30 selection:text-white pb-24 overflow-x-hidden">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-[#EB0029] rounded-[100%] blur-[150px] opacity-[0.07] pointer-events-none" />

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
            <NavLink to="/watchlist" className={navClass}>
              Watchlist
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

      <Outlet context={outletContext} />

      <footer className="max-w-6xl mx-auto px-6 mt-32 pt-8 border-t border-[#26262E] flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="font-space font-bold text-xl tracking-tight text-white flex items-baseline opacity-50">
          Klar<span className="text-[#EB0029]">.</span>
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
        tracked={trackedSkills}
        months={WINDOW_MONTHS[activeWindow]}
      />
    </div>
  );
}
