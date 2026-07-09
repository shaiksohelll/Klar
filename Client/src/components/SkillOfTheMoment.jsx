import { motion, useReducedMotion } from "framer-motion";
import { displayName } from "../lib/displayName";
import { fmtMoney } from "../utils/format";
import Num from "./ui/Num";

// ── Skill of the Moment ───────────────────────────────────────────────────
// A STRIP above the leaderboard (never the whole screen). It surfaces the
// single most momentous skill — the fastest riser if velocity is ready,
// otherwise the #1 by demand — using the same data-as-object vocabulary:
// a horizontal demand bar, mono numerals, and a subtle red glow.
export default function SkillOfTheMoment({ skill, maxCount, onSelect }) {
  const reduce = useReducedMotion();
  if (!skill) return null;

  const name = displayName(skill.name || skill.id);
  const widthPct = Math.max((skill.count / (maxCount || 1)) * 100, 6);
  const money = fmtMoney(skill.avgSalary, skill.salaryCurrency);
  const rising = skill.trend === "up" && skill.velocity != null;
  const isNew = skill.trend === "new";

  const label = rising ? "Fastest riser" : isNew ? "New entrant" : "Most in demand";

  return (
    <button
      type="button"
      onClick={() => onSelect(skill)}
      className="group relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--panel)] px-4 py-3.5 text-left transition-colors hover:border-[var(--accent)]/60 focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] md:px-5"
      aria-label={`${label}: ${name}. Open profile.`}
    >
      {/* Demand bar — the object. Grows from 0 on mount, glows red. */}
      <motion.div
        initial={reduce ? false : { width: 0 }}
        animate={{ width: `${widthPct}%` }}
        transition={reduce ? { duration: 0 } : { duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="klar-bar-lead pointer-events-none absolute inset-y-0 left-0 -z-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(235,0,41,0.22) 0%, rgba(235,0,41,0.10) 100%)",
        }}
        aria-hidden="true"
      />
      <div className="relative z-10 flex items-center gap-4">
        <span className="klar-pulse hidden h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent)]">
            {label}
          </div>
          <div className="flex items-baseline gap-3">
            <span className="truncate font-space text-xl font-bold tracking-tight text-[var(--text)] md:text-2xl">
              {name}
            </span>
            {rising && (
              <span className="shrink-0 font-mono text-xs font-medium text-[var(--pos)]">
                ▲ +{skill.velocity}%
              </span>
            )}
            {isNew && (
              <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--accent)]">
                NEW
              </span>
            )}
          </div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
            Demand
          </div>
          <Num className="text-lg text-[var(--text)]">{skill.count.toLocaleString()}</Num>
        </div>
        {money && (
          <div className="hidden shrink-0 border-l border-[var(--border)] pl-4 text-right md:block">
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)]">
              Avg pay
            </div>
            <Num className="text-lg text-[var(--text)]">{money}</Num>
          </div>
        )}
        <span
          className="hidden shrink-0 font-mono text-xs text-[var(--muted-2)] transition-colors group-hover:text-[var(--accent)] lg:block"
          aria-hidden="true"
        >
          View →
        </span>
      </div>
    </button>
  );
}
