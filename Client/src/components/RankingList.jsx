import { motion, useReducedMotion } from "framer-motion";
import { StarIcon } from "./icons";
import { VelocityBadge } from "./VelocityBadge";
import { displayName } from "../lib/displayName";

// Format an INR midpoint (stored in full rupees) into a compact lakh/K string.
// Matches the convention used in SkillDrawer: 1500000 → "15L", 75000 → "75K".
function fmtINR(n) {
  if (n == null || !isFinite(n)) return null;
  const l = n / 100_000;
  return l >= 1
    ? `${l % 1 === 0 ? l : l.toFixed(1)}L`
    : `${Math.round(n / 1000)}K`;
}

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
      {/* Header row */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--border)] text-xs font-mono text-[var(--muted-2)] uppercase tracking-wider mb-2">
        <div className="w-12">Rank</div>
        <div className="flex-1">Skill</div>
        <div className="w-28 hidden md:block text-right">Avg Salary</div>
        <div className="w-32 hidden md:block text-right">Remote</div>
        <div className="w-12 text-center ml-4">Track</div>
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
              className="flex items-center px-4 py-3 rounded-lg cursor-pointer group relative overflow-hidden"
            >
              <div className="w-12 font-mono text-[var(--muted-2)] group-hover:text-[var(--text)] transition-colors">
                {String(index + 1).padStart(2, "0")}
              </div>

              <div className="flex-1 pr-4 relative">
                <div className="flex items-center gap-2">
                  <span className="font-sans font-medium text-[var(--text)] group-hover:text-[var(--text)] transition-colors">
                    {displayName(skill.name)}
                  </span>
                  <VelocityBadge
                    velocity={skill.velocity}
                    trend={skill.trend}
                  />
                  <div className="font-mono text-xs text-[var(--muted-2)] opacity-0 group-hover:opacity-100 transition-opacity">
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

              {/* Avg Salary — INR disclosed only.
                  Ordering: null → "—" (0 qualifying postings);
                  limitedData → chip (1–4 postings);
                  else → ₹value (≥ 5 postings). */}
              <div className="w-28 hidden md:block font-mono text-sm text-right shrink-0">
                {skill.avgSalary == null ? (
                  <span className="text-[var(--muted-2)]">—</span>
                ) : skill.limitedData ? (
                  <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono rounded border border-[var(--border)] text-[var(--muted-2)] leading-none">
                    limited data
                  </span>
                ) : (
                  <span className="text-[var(--muted)]">
                    ₹{fmtINR(skill.avgSalary)}
                  </span>
                )}
              </div>

              <div className="w-32 hidden md:block font-mono text-sm text-[var(--muted)] text-right">
                {skill.remoteCount.toLocaleString()}
              </div>

              <div className="w-12 ml-4 flex justify-center">
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
                      : "text-[var(--muted-2)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]"
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
