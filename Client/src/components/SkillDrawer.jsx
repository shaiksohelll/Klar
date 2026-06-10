import { useState, useEffect } from "react";
import axios from "axios";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { StarIcon, XIcon } from "./icons";
import { displayName } from "../lib/displayName";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── Client-side session cache for skill detail ────────────────────────────────
// Module-level (not React state) so it persists for the browser session.
// Key: `${skillId}:${months}`. No TTL — stale data is fine for a session.
// Re-opening the same skill’s drawer is instant with zero refetch.
const DETAIL_CACHE = new Map();

// ── Client-side session cache for salary insights ─────────────────────────────
// Same pattern as DETAIL_CACHE. Key: `salary:${skillId}:${months}`.
const SALARY_CACHE = new Map();

// UI spring: stiffness 180, damping 22
const UI_SPRING = { type: "spring", stiffness: 180, damping: 22 };
// Snappy spring: stiffness 420, damping 34 (star pop)
const SNAPPY_SPRING = { type: "spring", stiffness: 420, damping: 34 };

const shareBarStyle = (pct) => ({ width: `${pct}%` });
const trendBarStyle = (pct) => ({ height: `${pct}%` });

// Map a currency code to its common symbol.
function currencySymbol(code) {
  if (code === "INR") return "₹";
  if (code === "USD") return "$";
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  return code ? `${code} ` : "";
}

// Format a salary number: e.g. 1500000 → "15L", 75000 → "75K"
function fmtSalary(n, currency) {
  if (n == null || !isFinite(n)) return "—";
  // INR: use lakhs
  if (currency === "INR") {
    const l = n / 100_000;
    return l >= 1 ? `${l % 1 === 0 ? l : l.toFixed(1)}L` : `${Math.round(n / 1000)}K`;
  }
  // USD / GBP / others: use K
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

function monthLabel(ym) {
  const parts = String(ym).split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  return d.toLocaleString("en", { month: "short" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function SkillDrawer({
  skill,
  isOpen,
  onClose,
  onTrack,
  tracked,
  months,
}) {
  const shouldReduceMotion = useReducedMotion();

  // activeSkill lets the drawer navigate to a related skill without closing.
  const [activeSkill, setActiveSkill] = useState(skill);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Salary insights: fetched separately so detail doesn't block salary UI.
  const [salary, setSalary] = useState(null);
  const [loadingSalary, setLoadingSalary] = useState(false);

  // Reset to the parent-selected skill whenever it changes (new open).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (skill) setActiveSkill(skill);
  }, [skill]);

  // Reset salary state when active skill changes so stale data never shows.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalary(null);
    setLoadingSalary(false);
  }, [activeSkill]);

  // Fetch enriched detail for the active skill.
  // Session cache: if the same skill+months combo was fetched before this
  // session, serve from memory without hitting the network.
  useEffect(() => {
    if (!isOpen || !activeSkill) return;
    const cacheKey = `${activeSkill.id}:${months || 12}`;
    if (DETAIL_CACHE.has(cacheKey)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail(DETAIL_CACHE.get(cacheKey));
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetail(null);
    axios
      .get(`${API}/api/skill/${encodeURIComponent(activeSkill.id)}`, {
        params: { months: months || 12 },
      })
      .then((res) => {
        if (!cancelled) {
          DETAIL_CACHE.set(cacheKey, res.data);
          setDetail(res.data);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeSkill, months]);

  // Fetch salary insights for the active skill (separate fetch, separate cache).
  useEffect(() => {
    if (!isOpen || !activeSkill) return;
    const cacheKey = `salary:${activeSkill.id}:${months || 12}`;
    if (SALARY_CACHE.has(cacheKey)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSalary(SALARY_CACHE.get(cacheKey));
      setLoadingSalary(false);
      return;
    }
    let cancelled = false;
    setLoadingSalary(true);
    setSalary(null);
    axios
      .get(`${API}/api/salary`, {
        params: { skill: activeSkill.id, months: months || 12 },
      })
      .then((res) => {
        if (!cancelled) {
          SALARY_CACHE.set(cacheKey, res.data);
          setSalary(res.data);
        }
      })
      .catch(() => {
        if (!cancelled) setSalary({ ok: false });
      })
      .finally(() => {
        if (!cancelled) setLoadingSalary(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeSkill, months]);

  if (!activeSkill && !skill) return null;

  const current = activeSkill || skill;
  const name = displayName(current.name || current.id);
  const isTracked = current ? tracked.includes(current.id) : false;

  const demandVal = detail ? detail.demand : (current.count ?? null);
  const remoteCountVal = detail
    ? detail.remoteCount
    : (current.remoteCount ?? null);
  const remoteShare =
    detail && typeof detail.remoteShare === "number"
      ? detail.remoteShare
      : current.count
        ? Math.round((current.remoteCount / current.count) * 100)
        : 0;
  const share =
    detail && typeof detail.share === "number"
      ? detail.share
      : (current.share ?? 0);
  const maxTrend =
    detail && detail.trend && detail.trend.length
      ? Math.max(...detail.trend.map((t) => t.count))
      : 1;

  const goToSkill = (skillName) => {
    setActiveSkill({ id: skillName, name: skillName, role: current.role });
  };

  // When reduced motion is preferred, use simple fade instead of slide
  const drawerInitial = shouldReduceMotion ? { opacity: 0 } : { x: "100%", opacity: 1 };
  const drawerAnimate = shouldReduceMotion ? { opacity: 1 } : { x: 0, opacity: 1 };
  const drawerExit = shouldReduceMotion ? { opacity: 0 } : { x: "100%", opacity: 1 };
  const drawerTransition = shouldReduceMotion
    ? { duration: 0.2 }
    : UI_SPRING;

  return (
    <AnimatePresence>
      {isOpen && current && (
        <>
          {/* Backdrop — blurred dark overlay, animates IN and OUT */}
          <motion.div
            key="skill-drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-[#08080A]/70 backdrop-blur-sm"
          />

          {/* Drawer — slides in from right using UI spring, slides out on close */}
          <motion.div
            key="skill-drawer-panel"
            initial={drawerInitial}
            animate={drawerAnimate}
            exit={drawerExit}
            transition={drawerTransition}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md z-50 bg-linear-to-b from-[#121216] to-[#1A1A20] border-l border-[#26262E] shadow-2xl flex flex-col"
          >
            {/* Header */}
            <div className="p-6 md:p-8 flex justify-between items-start border-b border-[#26262E]/50 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-[#FF2740] rounded-full blur-[120px] opacity-10 pointer-events-none" />
              <div className="relative z-10">
                <div className="font-mono text-xs tracking-widest text-[#9A9AA6] uppercase mb-2">
                  Skill Profile
                </div>
                <h2 className="font-space font-bold text-3xl text-white tracking-tight">
                  {name}
                </h2>
                <div className="flex items-center gap-2 mt-3">
                  <span className="px-2.5 py-1 rounded-full border border-[#26262E] bg-[#08080A] text-xs font-mono text-[#F4F4F6]">
                    {current.role}
                  </span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="relative z-10 p-2 text-[#9A9AA6] hover:text-white transition-colors bg-[#08080A]/50 rounded-full hover:bg-[#26262E]"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-8 relative z-10">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-[#08080A] border border-[#26262E]">
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-2">
                    Demand
                  </div>
                  <div className="font-mono text-2xl text-white">
                    {demandVal != null ? demandVal.toLocaleString() : "…"}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-[#08080A] border border-[#26262E]">
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-2">
                    Remote
                  </div>
                  <div className="font-mono text-2xl text-white">
                    {remoteShare}%
                    {remoteCountVal != null && (
                      <span className="text-sm text-[#5C5C66] ml-1">
                        ({remoteCountVal.toLocaleString()})
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-[#08080A] border border-[#26262E] col-span-2">
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-2">
                    Share of Jobs
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="font-mono text-2xl text-white">
                      {share}%
                    </div>
                    <div className="w-full bg-[#26262E] h-2 rounded-full overflow-hidden mb-1.5">
                      <div
                        className="h-full bg-linear-to-r from-[#FF2740] to-[#9E0019]"
                        style={shareBarStyle(share)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Postings over time */}
              {detail && detail.trend && detail.trend.length > 1 && (
                <div>
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-3">
                    Postings Over Time
                  </div>
                  <div className="flex items-end gap-1.5 h-24">
                    {detail.trend.map((t) => (
                      <div
                        key={t.month}
                        className="flex-1 flex flex-col items-center gap-2 h-full"
                      >
                        <div className="w-full bg-[#26262E] rounded-sm flex items-end h-full overflow-hidden">
                          <div
                            className="w-full bg-linear-to-t from-[#9E0019] to-[#FF2740] rounded-sm"
                            style={trendBarStyle(
                              Math.max(
                                6,
                                Math.round((t.count / maxTrend) * 100),
                              ),
                            )}
                          />
                        </div>
                        <div className="font-mono text-[10px] text-[#5C5C66]">
                          {monthLabel(t.month)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Top companies */}
              {detail &&
                detail.topCompanies &&
                detail.topCompanies.length > 0 && (
                  <div>
                    <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-3">
                      Top Companies Hiring
                    </div>
                    <div className="space-y-2">
                      {detail.topCompanies.map((c) => (
                        <div
                          key={c.company}
                          className="flex items-center justify-between p-3 rounded-lg bg-[#08080A] border border-[#26262E]"
                        >
                          <span className="text-sm text-[#F4F4F6] truncate pr-3">
                            {c.company}
                          </span>
                          <span className="font-mono text-xs text-[#9A9AA6] shrink-0">
                            {c.count} jobs
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* ── Salary · Disclosed ─────────────────────────────────── */}
              {/* Skeleton while loading */}
              {loadingSalary && !salary && (
                <div
                  aria-label="Loading salary data"
                  aria-busy="true"
                  className="p-4 rounded-xl bg-[#08080A] border border-[#26262E] space-y-3"
                >
                  <div className="h-2.5 w-28 rounded bg-[#26262E]" />
                  <div
                    className={`h-9 w-32 rounded bg-[#1E1E24] ${
                      shouldReduceMotion ? "" : "animate-pulse"
                    }`}
                  />
                  <div className="h-2 w-48 rounded bg-[#1A1A20]" />
                  <div className="h-2 w-40 rounded bg-[#1A1A20]" />
                </div>
              )}

              {/* Salary data resolved */}
              {salary && (
                <div>
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-3">
                    Salary · Disclosed
                  </div>

                  {salary.primary && salary.primary.count > 0 ? (
                    <div className="p-4 rounded-xl bg-[#08080A] border border-[#26262E] space-y-2">
                      {/* Median — large prominent number */}
                      <div className="font-mono text-3xl font-bold text-white">
                        {currencySymbol(salary.primary.currency)}
                        {fmtSalary(salary.primary.median, salary.primary.currency)}
                        <span className="text-sm text-[#9A9AA6] font-normal ml-2">median</span>
                      </div>

                      {/* p25–p75 range */}
                      <div className="font-mono text-sm text-[#9A9AA6]">
                        {currencySymbol(salary.primary.currency)}
                        {fmtSalary(salary.primary.p25, salary.primary.currency)}
                        {" – "}
                        {currencySymbol(salary.primary.currency)}
                        {fmtSalary(salary.primary.p75, salary.primary.currency)}
                        <span className="text-[#5C5C66] ml-1">typical range</span>
                      </div>

                      {/* Disclosure caption */}
                      <div className="font-mono text-[10px] text-[#5C5C66] leading-relaxed pt-1 border-t border-[#26262E]">
                        Disclosed by{" "}
                        <span className="text-[#9A9AA6]">{salary.disclosedCount.toLocaleString()}</span>
                        {" of "}
                        <span className="text-[#9A9AA6]">{salary.totalCount.toLocaleString()}</span>
                        {" postings ("}
                        {Math.round((salary.disclosureRate ?? 0) * 100)}%
                        {" disclosure rate). Employer-disclosed only — no estimates."}
                      </div>
                    </div>
                  ) : (
                    /* Empty state — calm, honest, never shows a zero or broken chart */
                    <div className="p-4 rounded-xl bg-[#08080A] border border-[#26262E]">
                      <p className="font-mono text-xs text-[#5C5C66] leading-relaxed">
                        No salaries disclosed yet for this skill.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Pairs Well With */}
              {detail &&
                detail.pairs &&
                detail.pairs.length > 0 && (
                  <div>
                    <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-1">
                      Pairs Well With
                    </div>
                    {detail.pairsBaseCount > 0 && (
                      <div className="font-mono text-[10px] text-[#5C5C66] mb-3 leading-relaxed">
                        Of {detail.pairsBaseCount.toLocaleString()} jobs requiring {name}, this share also asks for:
                      </div>
                    )}
                    <div className="space-y-2.5">
                      {detail.pairs.map((p) => (
                        <div key={p.skill}>
                          <div className="flex items-center justify-between mb-1">
                            <button
                              onClick={() => goToSkill(p.skill)}
                              className="font-mono text-xs text-[#F4F4F6] hover:text-white transition-colors cursor-pointer text-left"
                            >
                              {displayName(p.skill)}
                            </button>
                            <span className="font-mono text-xs text-[#9A9AA6] shrink-0 ml-3">
                              {p.percentage}%
                            </span>
                          </div>
                          <div className="h-1 rounded-full bg-[#26262E] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[#FF2740]"
                              style={{ width: `${p.percentage}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Recent postings (clickable when a source link exists) */}
              {detail && detail.recent && detail.recent.length > 0 && (
                <div>
                  <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-3">
                    Recent Postings
                  </div>
                  <div className="space-y-2">
                    {detail.recent.map((j, i) => {
                      const inner = (
                        <>
                          <div className="flex items-center gap-2">
                            <div className="text-sm text-[#F4F4F6] font-medium truncate">
                              {j.title}
                            </div>
                            {j.url && (
                              <span className="ml-auto shrink-0 font-mono text-xs text-[#9A9AA6] group-hover:text-[#FF2740]">
                                ↗
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 font-mono text-xs text-[#5C5C66]">
                            <span className="truncate">{j.company || "—"}</span>
                            {j.isRemote && (
                              <span className="px-1.5 py-0.5 rounded bg-[rgba(235,0,41,0.15)] text-[#FF2740]">
                                Remote
                              </span>
                            )}
                            <span className="ml-auto shrink-0">
                              {timeAgo(j.postedAt)}
                            </span>
                          </div>
                        </>
                      );
                      return j.url ? (
                        <a
                          key={i}
                          href={j.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group block p-3 rounded-lg bg-[#08080A] border border-[#26262E] hover:border-[#EB0029] transition-colors"
                        >
                          {inner}
                        </a>
                      ) : (
                        <div
                          key={i}
                          className="p-3 rounded-lg bg-[#08080A] border border-[#26262E]"
                        >
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Loading skeleton — shown while detail is in-flight */}
              {loadingDetail && !detail && (
                <div
                  aria-label="Loading skill detail"
                  aria-busy="true"
                  className="space-y-6"
                >
                  {/* Stat-card skeletons — 2-col then full-width */}
                  <div className="grid grid-cols-2 gap-4">
                    {[0, 1].map((i) => (
                      <div
                        key={i}
                        className={`p-4 rounded-xl bg-[#08080A] border border-[#26262E] ${
                          shouldReduceMotion ? "" : "animate-pulse"
                        }`}
                        style={shouldReduceMotion ? {} : { animationDelay: `${i * 80}ms` }}
                      >
                        <div className="h-2.5 w-12 rounded bg-[#26262E] mb-3" />
                        <div className="h-7 w-20 rounded bg-[#1E1E24]" />
                      </div>
                    ))}
                    <div
                      className={`p-4 rounded-xl bg-[#08080A] border border-[#26262E] col-span-2 ${
                        shouldReduceMotion ? "" : "animate-pulse"
                      }`}
                      style={shouldReduceMotion ? {} : { animationDelay: "160ms" }}
                    >
                      <div className="h-2.5 w-20 rounded bg-[#26262E] mb-3" />
                      <div className="h-2 w-full rounded bg-[#1A1A20]" />
                    </div>
                  </div>
                  {/* Section skeletons — chart + list rows */}
                  {[120, 90, 70].map((w, i) => (
                    <div key={i} className="space-y-2">
                      <div className="h-2.5 w-24 rounded bg-[#26262E]" />
                      <div
                        className={`h-${w === 120 ? "20" : "10"} rounded bg-[#0E0E12] ${
                          shouldReduceMotion ? "" : "animate-pulse"
                        }`}
                        style={shouldReduceMotion ? {} : { animationDelay: `${(i + 2) * 80}ms` }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* The Reality */}
              <div>
                <div className="font-mono text-xs text-[#5C5C66] uppercase tracking-wider mb-3">
                  The Reality
                </div>
                <p className="text-[#F4F4F6] leading-relaxed">
                  {`${name} shows ${
                    demandVal != null ? demandVal.toLocaleString() : "…"
                  } active postings in this window — about ${share}% of all jobs analyzed, ${remoteShare}% of them remote. A live read on current demand, not a forecast.`}
                </p>
              </div>
            </div>

            {/* Footer — track button with star pop animation */}
            <div className="p-6 md:p-8 border-t border-[#26262E]/50 bg-[#08080A]/50 relative z-10">
              <button
                onClick={() => onTrack(current.id)}
                className={`w-full py-4 px-6 rounded-xl font-mono text-sm uppercase tracking-widest font-medium transition-all duration-300 flex items-center justify-center gap-2 ${
                  isTracked
                    ? "bg-[#26262E] text-white hover:bg-[#32323C]"
                    : "bg-[#EB0029] text-white shadow-[0_0_20px_rgba(235,0,41,0.3)] hover:shadow-[0_0_30px_rgba(255,39,64,0.5)] hover:bg-[#FF2740] hover:-translate-y-0.5"
                }`}
              >
                {/* Star with snappy spring pop on track */}
                <motion.span
                  animate={
                    isTracked && !shouldReduceMotion
                      ? { scale: [1, 1.25, 1] }
                      : { scale: 1 }
                  }
                  transition={SNAPPY_SPRING}
                  className="flex items-center"
                >
                  <StarIcon filled={isTracked} className="w-4 h-4" />
                </motion.span>
                {isTracked ? "Tracking" : "Track Skill"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
