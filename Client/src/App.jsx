import { useState, useEffect, useMemo } from "react";
import axios from "axios";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
  useClerk,
} from "@clerk/clerk-react";
import { motion } from "framer-motion";
import { TiltCard } from "./components/TiltCard";
import { BarChart } from "./components/BarChart";
import { RankingList } from "./components/RankingList";
import { SkillDrawer } from "./components/SkillDrawer";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

const ROLES = ["All", "Frontend", "Backend", "Fullstack", "DevOps", "Data", "Mobile"];
const WINDOWS = ["3M", "6M", "12M"];
const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
const EASE = [0.16, 1, 0.3, 1];

// framer-motion prop objects pre-declared as consts (keeps JSX single-brace)
const heroEyebrowInit = { opacity: 0 };
const heroShow = { opacity: 1 };
const heroItemInit = { opacity: 0, y: 20 };
const heroH1Trans = { delay: 0.1, duration: 0.6, ease: EASE };
const heroPTrans = { delay: 0.2, duration: 0.6, ease: EASE };
const heroCountInit = { opacity: 0 };
const heroCountShow = { opacity: 1 };
const heroCountTrans = { delay: 0.4, duration: 0.6 };
const pillSpring = { type: "spring", stiffness: 380, damping: 30 };

export default function App() {
  const [skills, setSkills] = useState([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [activeRole, setActiveRole] = useState("All");
  const [activeWindow, setActiveWindow] = useState("12M");
  const [view, setView] = useState("demand"); // "demand" | "watchlist"
  const [trackedSkills, setTrackedSkills] = useState([]);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { user, isSignedIn } = useUser();
  const { openSignIn, signOut } = useClerk();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const months = WINDOW_MONTHS[activeWindow];
        const params = { months, limit: 25 };
        if (activeRole !== "All") params.role = activeRole.toLowerCase();
        const res = await axios.get(`${API}/api/skills/trending`, { params });
        if (cancelled) return;
        const total = res.data.totalJobs || 0;
        const mapped = (res.data.skills || []).map((s) => ({
          id: s.skill,
          name: s.skill,
          count: s.demand,
          remoteCount: s.remoteCount || 0,
          share: total ? Math.round((s.demand / total) * 100) : 0,
          role: activeRole === "All" ? "General" : activeRole,
        }));
        setSkills(mapped);
        setTotalJobs(total);
      } catch (err) {
        if (!cancelled)
          setError("Couldn't load demand data. Is the API running on :5000?");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [activeRole, activeWindow]);

  const sorted = useMemo(
    () => [...skills].sort((a, b) => b.count - a.count),
    [skills],
  );

  const visibleSkills = useMemo(() => {
    if (view === "watchlist")
      return sorted.filter((s) => trackedSkills.includes(s.id));
    return sorted;
  }, [sorted, view, trackedSkills]);

  const maxCount = useMemo(
    () => (sorted.length ? Math.max(...sorted.map((s) => s.count)) : 1),
    [sorted],
  );

  // Load this user's saved watchlist from MongoDB when they sign in
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
    // Must be signed in to track — open the Clerk sign-in modal otherwise
    if (!isSignedIn || !user) {
      openSignIn();
      return;
    }
    const wasTracked = trackedSkills.includes(id);
    // Optimistic update for instant feedback
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
      // Revert on failure
      setTrackedSkills((prev) =>
        wasTracked ? [...prev, id] : prev.filter((s) => s !== id),
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#08080A] text-[#F4F4F6] font-sans selection:bg-[#EB0029]/30 selection:text-white pb-24 overflow-x-hidden">
      {/* Top center red glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-[#EB0029] rounded-[100%] blur-[150px] opacity-[0.07] pointer-events-none" />

      {/* Sticky Nav */}
      <nav className="sticky top-0 z-40 bg-[#08080A]/70 backdrop-blur-xl border-b border-[#26262E]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="font-space font-bold text-xl tracking-tight text-white flex items-baseline">
            Klar<span className="text-[#EB0029]">.</span>
          </div>

          <div className="hidden md:flex items-center gap-8 font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">
            <button
              onClick={() => setView("demand")}
              className={view === "demand" ? "text-white" : "hover:text-white transition-colors"}
            >
              Demand
            </button>
            <button
              onClick={() => setView("watchlist")}
              className={view === "watchlist" ? "text-white" : "hover:text-white transition-colors"}
            >
              Watchlist
            </button>
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

      <main className="max-w-6xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 md:space-y-20 relative z-10">
        {/* Hero */}
        <section className="text-center max-w-3xl mx-auto space-y-6">
          <motion.div
            initial={heroEyebrowInit}
            animate={heroShow}
            className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold"
          >
            The Demand Report
          </motion.div>
          <motion.h1
            initial={heroItemInit}
            animate={heroShow}
            transition={heroH1Trans}
            className="font-space font-bold text-5xl md:text-7xl leading-[1.05] tracking-tight text-white"
          >
            What developers <span className="text-[#EB0029] italic">actually</span> get hired for.
          </motion.h1>
          <motion.p
            initial={heroItemInit}
            animate={heroShow}
            transition={heroPTrans}
            className="text-lg md:text-xl text-[#9A9AA6] max-w-2xl mx-auto font-medium"
          >
            Real-time market analysis based on active job postings. No hype, no predictions. Just the data.
          </motion.p>
          <motion.div
            initial={heroCountInit}
            animate={heroCountShow}
            transition={heroCountTrans}
            className="font-mono text-[#5C5C66] text-sm uppercase tracking-widest pt-4 flex items-center justify-center gap-3"
          >
            <div className="w-12 h-px bg-[#26262E]" />
            {totalJobs.toLocaleString()} jobs analyzed
            <div className="w-12 h-px bg-[#26262E]" />
          </motion.div>
        </section>

        {/* Filter Row */}
        <section className="flex flex-col md:flex-row items-center justify-between gap-6 border-b border-[#26262E] pb-6">
          <div className="flex flex-wrap justify-center gap-2">
            {ROLES.map((role) => (
              <button
                key={role}
                onClick={() => setActiveRole(role)}
                className={`relative px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                  activeRole === role ? "text-white" : "text-[#9A9AA6] hover:text-white"
                }`}
              >
                {activeRole === role && (
                  <motion.div
                    layoutId="activeRole"
                    className="absolute inset-0 bg-[#EB0029] rounded-full -z-10"
                    transition={pillSpring}
                  />
                )}
                {role}
              </button>
            ))}
          </div>

          <div className="flex bg-[#121216] border border-[#26262E] rounded-full p-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setActiveWindow(w)}
                className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                  activeWindow === w ? "text-white" : "text-[#5C5C66] hover:text-[#9A9AA6]"
                }`}
              >
                {activeWindow === w && (
                  <motion.div
                    layoutId="activeWindow"
                    className="absolute inset-0 bg-[#26262E] rounded-full -z-10"
                    transition={pillSpring}
                  />
                )}
                {w}
              </button>
            ))}
          </div>
        </section>

        {/* States + Content */}
        {error ? (
          <div className="text-center py-20 font-mono text-sm text-[#EB0029]">{error}</div>
        ) : loading ? (
          <div className="text-center py-20 font-mono text-sm text-[#5C5C66] uppercase tracking-widest animate-pulse">
            Loading demand data…
          </div>
        ) : visibleSkills.length === 0 ? (
          <div className="text-center py-20 font-mono text-sm text-[#5C5C66]">
            {view === "watchlist"
              ? "No tracked skills yet. Tap the star on any skill to add it here."
              : "No skills found for this filter."}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            {/* Chart */}
            <div className="lg:col-span-7 xl:col-span-8 h-[500px]">
              <TiltCard>
                <div className="absolute top-6 left-6 md:top-8 md:left-8 font-mono text-xs uppercase tracking-widest text-[#5C5C66] z-20">
                  Top Skills by Volume
                </div>
                <BarChart
                  skills={visibleSkills.slice(0, 12)}
                  maxCount={maxCount}
                  onSelect={setSelectedSkill}
                />
              </TiltCard>
            </div>

            {/* Ranking */}
            <div className="lg:col-span-5 xl:col-span-4">
              <div className="font-mono text-xs uppercase tracking-widest text-[#5C5C66] mb-6 px-4">
                Detailed Ranking
              </div>
              <RankingList
                skills={visibleSkills}
                maxCount={maxCount}
                onSelect={setSelectedSkill}
                onTrack={handleTrack}
                tracked={trackedSkills}
              />
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 mt-32 pt-8 border-t border-[#26262E] flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="font-space font-bold text-xl tracking-tight text-white flex items-baseline opacity-50">
          Klar<span className="text-[#EB0029]">.</span>
        </div>
        <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider text-center md:text-right">
          A snapshot of current demand, not a prediction.
        </div>
      </footer>

      {/* Drawer */}
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