import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { displayName } from "../lib/displayName";

// ── Springs ──────────────────────────────────────────────────────────────────
// Bar entrance spring: stiffness 150, damping 18
const BAR_SPRING = { type: "spring", stiffness: 150, damping: 18 };
// Stagger: 50 ms between each bar (left-to-right)
const BAR_STAGGER_S = 0.05;
// Hover spring: UI spring, stiffness 180, damping 22
const UI_SPRING = { type: "spring", stiffness: 180, damping: 22 };

const tipInit = { opacity: 0, y: 6, scale: 0.96 };
const tipShow = { opacity: 1, y: 0, scale: 1 };


// ── Plot geometry ────────────────────────────────────────────────────────────
const PLOT_HEIGHT = 320; // px — fixed height for the bar plot area
const MAX_FILL = 0.88; // tallest bar fills 88% of plot height
const BAR_GRADIENT = "linear-gradient(180deg, #FF2740 0%, #9E0019 100%)";

export function BarChart({ skills, maxCount, onSelect }) {
  const [hoveredId, setHoveredId] = useState(null);
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="w-full flex flex-col">
      {/* Eyebrow title */}
      <div
        className="font-mono uppercase text-[#5C5C66] tracking-[0.18em] mb-5 select-none"
        style={{ fontSize: 11 }}
      >
        Top Skills by Volume
      </div>

      {/* Plot area — fixed height, bars bottom-aligned */}
      <div
        className="relative flex items-end gap-1"
        style={{ height: PLOT_HEIGHT }}
      >
        {skills.map((skill, index) => {
          const heightPx = Math.max(
            (skill.count / maxCount) * PLOT_HEIGHT * MAX_FILL,
            8,
          );
          const isHovered = hoveredId === skill.id;
          const isFaded = hoveredId !== null && hoveredId !== skill.id;
          // #1 bar (highest value) — skills are sorted count-desc, so index 0 is top.
          const isTop = index === 0;

          // Entrance animation
          const barInitial = shouldReduceMotion
            ? { opacity: 0 }
            : { height: 0, opacity: 1 };
          const barAnimate = shouldReduceMotion
            ? { opacity: 1 }
            : { height: heightPx, opacity: 1 };
          const barTransition = shouldReduceMotion
            ? { duration: 0.3, delay: index * BAR_STAGGER_S }
            : { ...BAR_SPRING, delay: index * BAR_STAGGER_S };

          const remotePct = skill.count
            ? Math.round((skill.remoteCount / skill.count) * 100)
            : 0;

          const display = displayName(skill.name);

          return (
            <div
              key={skill.id}
              className="flex-1 flex flex-col items-center justify-end cursor-pointer relative"
              style={{ height: PLOT_HEIGHT }}
              onMouseEnter={() => setHoveredId(skill.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelect(skill)}
            >
              {/* Value label — sits just above the bar top, always visible */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * BAR_STAGGER_S + 0.15 }}
                className="font-mono text-[11px] tabular-nums text-white mb-1.5 select-none"
              >
                {skill.count.toLocaleString()}
              </motion.div>

              {/* The bar */}
              <motion.div
                initial={barInitial}
                animate={{
                  ...barAnimate,
                  // Resting top bar: full red. Resting others: muted.
                  // Hover overrides: active bar bright, every other dims.
                  // Skip y-transform when reduced motion is on.
                  y: !shouldReduceMotion && isHovered ? -5 : 0,
                  filter: isHovered
                    ? "saturate(1) opacity(1) brightness(1.15)"
                    : isFaded
                      ? "saturate(0.4) opacity(0.4)"
                      : isTop
                        ? "saturate(1) opacity(1) brightness(1)"
                        : "saturate(0.55) opacity(0.7)",
                }}
                transition={{
                  // Entrance uses bar spring; after mount, filter/y use UI spring.
                  ...barTransition,
                  filter: UI_SPRING,
                  y: UI_SPRING,
                }}
                className="w-full rounded-t-sm relative"
                style={{
                  background: BAR_GRADIENT,
                  maxWidth: 48,
                  margin: "0 auto",
                  // Static red glow for top bar at rest; removed while any bar is hovered.
                  boxShadow:
                    isTop && hoveredId === null
                      ? "0 0 24px rgba(255,39,64,0.35)"
                      : "none",
                  transition: "box-shadow 0.3s ease",
                }}
              >
                {/* Glow overlay — active when hovered, or for top bar at rest */}
                <div
                  className="absolute inset-0 bg-[#FF2740] rounded-t-sm -z-10 transition-opacity duration-300"
                  style={{
                    filter: "blur(10px)",
                    opacity: isHovered || (isTop && hoveredId === null) ? 0.6 : 0,
                  }}
                />
                {/* Top edge highlight */}
                <div className="absolute top-0 inset-x-0 h-px bg-white/25 rounded-t-sm" />
              </motion.div>

              {/* Hover tooltip — positioned just above the value label, tracks bar */}
              <AnimatePresence>
                {isHovered && (
                  <motion.div
                    initial={tipInit}
                    animate={tipShow}
                    exit={tipInit}
                    transition={UI_SPRING}
                    className="absolute z-30 pointer-events-none"
                    style={{ bottom: heightPx + 34 }}
                  >
                    <div className="bg-[#08080A] border border-[#26262E] rounded-lg px-3 py-2.5 shadow-2xl flex flex-col gap-0.5 min-w-[110px] whitespace-nowrap">
                      <div className="font-sans text-sm font-medium text-white">
                        {display}
                      </div>
                      <div className="font-mono text-xs text-[#9A9AA6]">
                        {skill.count.toLocaleString()} jobs
                      </div>
                      <div className="font-mono text-[10px] text-[#EB0029] uppercase tracking-wider">
                        {remotePct}% Remote
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Baseline */}
      <div className="h-px bg-[#26262E]" />

      {/* Horizontal skill labels — no rotation, centered under bars */}
      <div className="flex gap-1 mt-2.5">
        {skills.map((skill) => {
          const isHovered = hoveredId === skill.id;
          return (
            <div
              key={skill.id}
              className="flex-1 text-center"
              style={{ minWidth: 0 }}
            >
              <span
                className="font-mono leading-tight inline-block transition-colors duration-200"
                style={{
                  // Three tiers so names always fit on one line — no mid-word breaks.
                  fontSize:
                    skill.name.length > 11 ? 9 : skill.name.length > 8 ? 10 : 11,
                  color: isHovered ? "#FFFFFF" : "#9A9AA6",
                  whiteSpace: "nowrap",
                }}
              >
                {displayName(skill.name)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
