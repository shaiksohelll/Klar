import { useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { StarIcon } from "./icons";
import { displayName } from "../lib/displayName";
import { fmtMoney } from "../utils/format";
import { buildSalaryPercentiles, salaryTone } from "../utils/salaryTone";
import Num from "./ui/Num";

const EASE = [0.22, 1, 0.36, 1];

// The five sorts. Order is fixed; each physically reflows the rows (FLIP).
const SORTS = [
  { key: "demand", label: "Demand" },
  { key: "salary", label: "Salary" },
  { key: "velocity", label: "Velocity" },
  { key: "name", label: "Name" },
  { key: "remote", label: "Most Remote" },
];

// Signed score used only for the Velocity sort.
function velocityScore(s) {
  if (s.trend === "up" && s.velocity != null) return s.velocity;
  if (s.trend === "down" && s.velocity != null) return -Math.abs(s.velocity);
  if (s.trend === "new") return 0.5;
  return 0;
}

// Small velocity marker — the "delta" channel. Rising pulses subtly.
function VelocityDelta({ velocity, trend }) {
  if (trend === "up" && velocity != null) {
    return (
      <span className="klar-pulse shrink-0 font-mono text-[11px] font-medium text-[var(--pos)]">
        ▲ +{velocity}%
      </span>
    );
  }
  if (trend === "down" && velocity != null) {
    return (
      <span className="shrink-0 font-mono text-[11px] font-medium text-[var(--muted)]">
        ▼ {Math.abs(velocity)}%
      </span>
    );
  }
  if (trend === "new") {
    return (
      <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--accent)]">
        NEW
      </span>
    );
  }
  return null;
}

export default function SkillLeaderboard({
  skills,
  onSelect,
  onTrack,
  tracked,
  velocityReady,
  velocityBasisDays,
  resetKey,
}) {
  const reduce = useReducedMotion();
  const [sortKey, setSortKey] = useState("demand");
  const [expandedId, setExpandedId] = useState(null);

  const maxCount = useMemo(
    () => (skills.length ? Math.max(...skills.map((s) => s.count)) : 1),
    [skills],
  );
  const leadId = useMemo(() => {
    let top = null;
    for (const s of skills) if (!top || s.count > top.count) top = s;
    return top?.id ?? null;
  }, [skills]);

  const percentiles = useMemo(() => buildSalaryPercentiles(skills), [skills]);

  const sorted = useMemo(() => {
    const arr = [...skills];
    switch (sortKey) {
      case "salary":
        arr.sort((a, b) => (b.avgSalary ?? -1) - (a.avgSalary ?? -1));
        break;
      case "velocity":
        arr.sort((a, b) => velocityScore(b) - velocityScore(a));
        break;
      case "name":
        arr.sort((a, b) =>
          displayName(a.name).localeCompare(displayName(b.name)),
        );
        break;
      case "remote":
        arr.sort((a, b) => (b.remoteCount ?? 0) - (a.remoteCount ?? 0));
        break;
      default:
        arr.sort((a, b) => b.count - a.count);
    }
    return arr;
  }, [skills, sortKey]);

  const layoutTransition = reduce
    ? { duration: 0 }
    : { duration: 0.5, ease: EASE };

  return (
    <div className="flex h-full flex-col">
      {/* ── Sort controls + velocity basis note ── */}
      <div className="flex shrink-0 flex-col gap-2 pb-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sort skills">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
            Sort
          </span>
          {SORTS.map((s) => {
            const active = sortKey === s.key;
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={active}
                onClick={() => setSortKey(s.key)}
                className={`relative rounded-[var(--radius-pill)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  active
                    ? "text-white"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="klar-sort-pill"
                    className="absolute inset-0 -z-10 rounded-[var(--radius-pill)] bg-[var(--accent)]"
                    transition={{ type: "spring", stiffness: 320, damping: 30 }}
                  />
                )}
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
          {!velocityReady
            ? "Velocity unlocks in a few days"
            : velocityBasisDays != null
              ? `Velocity vs ~${velocityBasisDays}d ago`
              : ""}
        </div>
      </div>

      {/* ── Column header ── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-3 pb-2 font-mono text-[10px] uppercase tracking-wider text-[var(--muted-2)]">
        <div className="w-8 shrink-0">#</div>
        <div className="flex-1">Skill · demand</div>
        <div className="hidden w-24 shrink-0 text-right sm:block">Avg pay</div>
        <div className="hidden w-14 shrink-0 text-right md:block">Remote</div>
        <div className="w-10 shrink-0 text-center">Track</div>
      </div>

      {/* ── The board: each row IS the datum ── */}
      <div className="klar-scroll klar-board -mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1">
        <div className="flex flex-col gap-0.5 py-1">
          {sorted.map((skill, index) => {
            const isTracked = tracked.includes(skill.id);
            const isExpanded = expandedId === skill.id;
            const widthPct = Math.max((skill.count / maxCount) * 100, 3);
            const tone = salaryTone(percentiles.get(skill.id) ?? null);
            const money = fmtMoney(skill.avgSalary, skill.salaryCurrency);
            const isLead = skill.id === leadId;
            const remoteShare = skill.count
              ? Math.round((skill.remoteCount / skill.count) * 100)
              : 0;

            const toggle = () =>
              setExpandedId((cur) => (cur === skill.id ? null : skill.id));

            return (
              <motion.div
                key={skill.id}
                layout={reduce ? false : "position"}
                transition={layoutTransition}
                data-expanded={isExpanded}
                className="klar-row relative overflow-hidden rounded-[var(--radius-md)]"
              >
                {/* Demand bar — the object itself. Length = demand, color =
                    salary percentile, red glow reserved for the #1 bar. */}
                <motion.div
                  key={`${skill.id}-${resetKey}`}
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${widthPct}%` }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.7, ease: EASE, delay: Math.min(index * 0.02, 0.3) }
                  }
                  className={`pointer-events-none absolute inset-y-0 left-0 z-0 rounded-[var(--radius-md)] ${
                    isLead ? "klar-bar-lead" : ""
                  }`}
                  style={{ background: tone.fill }}
                  aria-hidden="true"
                >
                  <span
                    className="absolute inset-y-0 right-0 w-[2px]"
                    style={{ background: tone.edge }}
                  />
                </motion.div>

                {/* Row header — role=button clickable region + a SIBLING track
                    button (never nested, so no button-inside-button). */}
                <div className="relative z-10 flex items-stretch">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    aria-label={`${displayName(skill.name)}, rank ${index + 1}, ${skill.count.toLocaleString()} postings. Toggle details.`}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                    className="group flex flex-1 cursor-pointer items-center gap-3 rounded-l-[var(--radius-md)] px-3 py-3"
                  >
                    <div className="w-8 shrink-0 font-mono text-sm text-[var(--muted-2)]">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate font-sans font-medium text-[var(--text)]">
                        {displayName(skill.name)}
                      </span>
                      <VelocityDelta velocity={skill.velocity} trend={skill.trend} />
                      <Num className="shrink-0 text-xs text-[var(--muted-2)] opacity-0 transition-opacity group-hover:opacity-100">
                        {skill.count.toLocaleString()}
                      </Num>
                    </div>

                    {/* Avg pay — mono, right-aligned; reveals disclosure on hover */}
                    <div className="hidden w-24 shrink-0 text-right sm:block">
                      {money == null ? (
                        <span className="font-mono text-sm text-[var(--muted-2)]">—</span>
                      ) : (
                        <>
                          <Num
                            className={`block text-sm ${skill.limitedData ? "text-[var(--muted-2)]" : "text-[var(--muted)]"}`}
                          >
                            {skill.limitedData ? "~" : ""}
                            {money}
                          </Num>
                          <span className="block font-mono text-[9px] uppercase tracking-wider text-[var(--muted-2)] opacity-0 transition-opacity group-hover:opacity-100">
                            {skill.disclosedCount} disclosed
                          </span>
                        </>
                      )}
                    </div>

                    <div className="hidden w-14 shrink-0 text-right md:block">
                      <Num className="text-sm text-[var(--muted)]">
                        {skill.remoteCount.toLocaleString()}
                      </Num>
                    </div>
                  </div>

                  {/* Track star — sibling real button */}
                  <div className="flex w-10 shrink-0 items-center justify-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTrack(skill.id);
                      }}
                      aria-pressed={isTracked}
                      aria-label={isTracked ? `Untrack ${displayName(skill.name)}` : `Track ${displayName(skill.name)}`}
                      className={`rounded-full p-2 transition-colors ${
                        isTracked
                          ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                          : "text-[var(--muted-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                      }`}
                    >
                      <StarIcon filled={isTracked} className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* ── Inline accordion — no scene change ── */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      key="panel"
                      initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={reduce ? { duration: 0.15 } : { duration: 0.32, ease: EASE }}
                      className="relative z-10 overflow-hidden"
                    >
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--border)] px-3 pb-4 pt-4 md:grid-cols-4">
                        <Metric label="Demand" value={skill.count.toLocaleString()} />
                        <MetricBar label="Share of jobs" pct={skill.share} suffix={`${skill.share}%`} tone={tone.edge} />
                        <MetricBar label="Remote share" pct={remoteShare} suffix={`${remoteShare}%`} tone="var(--muted)" />
                        <Metric
                          label="Avg pay · disclosed"
                          value={money == null ? "—" : `${skill.limitedData ? "~" : ""}${money}`}
                          sub={money == null ? "none disclosed" : `${skill.disclosedCount} postings`}
                        />
                      </div>
                      <div className="flex items-center justify-between px-3 pb-4">
                        <p className="max-w-md font-mono text-[10px] leading-relaxed text-[var(--muted-2)]">
                          The reality: a live count of active postings, not a
                          prediction. Salary is employer-disclosed only.
                        </p>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelect(skill);
                          }}
                          className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--border)] px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]"
                        >
                          Full profile →
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Small expanded-panel primitives (same data-as-object vocabulary) ─────────
function Metric({ label, value, sub }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
        {label}
      </div>
      <Num className="text-lg text-[var(--text)]">{value}</Num>
      {sub && (
        <div className="font-mono text-[10px] text-[var(--muted-2)]">{sub}</div>
      )}
    </div>
  );
}

function MetricBar({ label, pct, suffix, tone }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(Math.max(pct, 2), 100)}%`, background: tone }}
          />
        </div>
        <Num className="shrink-0 text-xs text-[var(--muted)]">{suffix}</Num>
      </div>
    </div>
  );
}
