import { motion, useReducedMotion } from "framer-motion";
import { StarIcon } from "./icons";
import { VelocityBadge } from "./VelocityBadge";
import { displayName } from "../lib/displayName";
import { fmtMoney } from "../utils/format";

// Snappy spring: stiffness 420, damping 34
const SNAPPY_SPRING = { type: "spring", stiffness: 420, damping: 34 };

// Bar entrance
const barInit = { width: 0 };

export function RankingList({ skills, maxCount, onSelect, onTrack, tracked }) {
  const shouldReduceMotion = useReducedMotion();

  // Row hover target — x:7 slide + faint red wash (#EB0029 @ 8%)
  const rowHover = shouldReduceMotion
    ? { backgroundColor: "rgba(235,0,41,0.08)" }
    : { x: 7, backgroundColor: "rgba(235,0,41,0.08)" };

  const rowTransition = {
    type: "spring",
    stiffness: 420,
    damping: 34,
  };

  return (
    <div className="w-full">
      {/* Header row — same flex + gap + column widths as the data rows so they align */}
      <div className="flex items-center gap-x-3 px-4 py-3 border-b border-[var(--border)] text-xs font-mono text-[var(--muted-2)] uppercase tracking-wider mb-2">
        <div className="w-10 shrink-0">Rank</div>
        <div className="flex-1 min-w-0">Skill</div>
        <div className="w-28 shrink-0 hidden md:block text-right">
          Avg Salary
        </div>
        <div className="w-16 shrink-0 hidden md:block text-right">Remote</div>
        <div className="w-12 shrink-0 text-center">Track</div>
      </div>

      <div className="space-y-1">
        {skills.map((skill, index) => {
          const isTracked = tracked.includes(skill.id);
          const widthPct = Math.max((skill.count / maxCount) * 100, 2);

          const barAnim = { width: `${widthPct}%` };
          const barTrans = shouldReduceMotion
            ? { duration: 0.3, delay: index * 0.03 }
            : {
                type: "spring",
                stiffness: 150,
                damping: 18,
                delay: index * 0.03,
              };

          return (
            <motion.div
              key={skill.id}
              onClick={() => onSelect(skill)}
              whileHover={rowHover}
              transition={rowTransition}
              className="flex items-center gap-x-3 px-4 py-3 rounded-lg cursor-pointer group relative"
            >
              <div className="w-10 shrink-0 font-mono text-[var(--muted-2)] group-hover:text-[var(--text)] transition-colors">
                {String(index + 1).padStart(2, "0")}
              </div>

              <div className="flex-1 min-w-0 relative">
                <div className="flex items-center gap-2">
                  <span className="font-sans font-medium text-[var(--text)] transition-colors">
                    {displayName(skill.name)}
                  </span>
                  <VelocityBadge
                    velocity={skill.velocity}
                    trend={skill.trend}
                  />
                  <div className="font-mono text-xs text-[var(--muted-2)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {skill.count.toLocaleString()}
                  </div>
                </div>
                {/* Demand bar — brightens on row hover via group class */}
                <div className="mt-2 w-full h-1 bg-[var(--border)] rounded-full overflow-hidden">
                  <motion.div
                    initial={barInit}
                    animate={barAnim}
                    transition={barTrans}
                    className="h-full rounded-full bg-linear-to-r from-[#FF2740] to-[#9E0019] group-hover:brightness-125 transition-[filter] duration-200"
                  />
                </div>
              </div>

              {/* Avg Salary — disclosed only, currency-aware via fmtMoney.
                  null → "—" (0 qualifying postings);
                  limitedData → same money value, muted + "~" prefix + tooltip. */}
              <div className="w-28 shrink-0 hidden md:block font-mono text-sm text-right">
                {(() => {
                  const money = fmtMoney(skill.avgSalary, skill.salaryCurrency);
                  return money == null ? (
                    <span className="text-[var(--muted-2)]">—</span>
                  ) : (
                    <span
                      className={`whitespace-nowrap ${skill.limitedData ? "text-[var(--muted-2)]" : "text-[var(--muted)]"}`}
                      title={
                        skill.limitedData
                          ? `Avg of ${skill.disclosedCount} disclosed postings`
                          : undefined
                      }
                    >
                      {skill.limitedData ? "~" : ""}
                      {money}
                    </span>
                  );
                })()}
              </div>

              <div className="w-16 shrink-0 hidden md:block font-mono text-sm text-[var(--muted)] text-right">
                {skill.remoteCount.toLocaleString()}
              </div>

              <div className="w-12 shrink-0 flex justify-center">
                {/* Star pop — scales 1.2x with snappy spring on track */}
                <motion.button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrack(skill.id);
                  }}
                  animate={
                    isTracked && !shouldReduceMotion
                      ? { scale: [1, 1.2, 1] }
                      : { scale: 1 }
                  }
                  transition={SNAPPY_SPRING}
                  className={`p-2 rounded-full transition-colors ${
                    isTracked
                      ? "text-[var(--accent)] bg-[#EB0029]/10"
                      : "text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
                  }`}
                >
                  <StarIcon filled={isTracked} className="w-4 h-4" />
                </motion.button>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
