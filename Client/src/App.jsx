import { useState, useEffect, useMemo, useRef } from "react";
import axios from "axios";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
  useClerk,
} from "@clerk/clerk-react";
import { NavLink, Outlet } from "react-router-dom";
import { SkillDrawer } from "./components/SkillDrawer";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
const ALL_WINDOWS = ["3M", "6M", "12M"];

// Fetch + shape trending data for a role/window. Pure helper, reused for prefetch.
async function fetchTrending(role, win) {
  const months = WINDOW_MONTHS[win];
  const params = { months, limit: 25 };
  if (role !== "All") params.role = role.toLowerCase();
  const res = await axios.get(`${API}/api/skills/trending`, { params });
  const total = res.data.totalJobs || 0;
  const skills = (res.data.skills || []).map((s) => ({
    id: s.skill,
    name: s.skill,
    count: s.demand,
    remoteCount: s.remoteCount || 0,
    share: total ? Math.round((s.demand / total) * 100) : 0,
    role: role === "All" ? "General" : role,
  }));
  return { skills, totalJobs: total };
}

export default function App() {
  const [skills, setSkills] = useState([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [activeRole, setActiveRole] = useState("All");
  const [activeWindow, setActiveWindow] = useState("12M");
  const [trackedSkills, setTrackedSkills] = useState([]);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // In-memory cache keyed by "role|window" so repeat switches are instant.
  const cacheRef = useRef(new Map());

  const { user, isSignedIn } = useUser();
  const { openSignIn, signOut } = useClerk();

  useEffect(() => {
    const key = `${activeRole}|${activeWindow}`;
    let cancelled = false;
    const cached = cacheRef.current.get(key);

    if (cached) {
      // Serve instantly from cache, no spinner.
      setSkills(cached.skills);
      setTotalJobs(cached.totalJobs);
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

  useEffect(() => {
    if (!isSignedIn || !user) {
      setTrackedSkills([]);
      return;
    }
    let cancelled = false;
    axios
      .get(`${API}/api/watchlist`, { params: { userId: user.id } })
      .then((res) => {
        if (!cancelled) setTrackedSkills(res.data.skills || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, user]);

  const handleTrack = async (id) => {
    if (!isSignedIn || !user) {
      openSignIn();
      return;
    }
    const wasTracked = trackedSkills.includes(id);
    setTrackedSkills((prev) =>
      wasTracked ? prev.filter((s) => s !== id) : [...prev, id],
    );
    try {
      const res = wasTracked
        ? await axios.delete(`${API}/api/watchlist`, {
            data: { userId: user.id, skill: id },
          })
        : await axios.post(`${API}/api/watchlist`, {
            userId: user.id,
            skill: id,
          });
      setTrackedSkills(res.data.skills || []);
    } catch (e) {
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
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <NavLink
            to="/"
            className="font-space font-bold text-xl tracking-tight text-white flex items-baseline"
          >
            Klar<span className="text-[#EB0029]">.</span>
          </NavLink>

          <div className="hidden md:flex items-center gap-8 font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">
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