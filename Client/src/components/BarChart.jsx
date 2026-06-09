import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useState } from "react";

// Bar spring: stiffness 150, damping 18
const BAR_SPRING = { type: "spring", stiffness: 150, damping: 18 };
// Staggered entrance: 50 ms between each bar (left-to-right)
const BAR_STAGGER_MS = 0.05; // seconds

const labelInit = { opacity: 0 };
const labelShow = { opacity: 1 };
const tipInit = { opacity: 0, y: 8, scale: 0.95 };
const tipShow = { opacity: 1, y: 0, scale: 1 };
const tipTrans = { type: "spring", stiffness: 420, damping: 34 };
const barStyle = { background: "linear-gradient(180deg, #FF2740 0%, #9E0019 100%)" };
const nameWrapStyle = { transform: "rotate(-45deg)" };

export function BarChart({ skills, maxCount, onSelect }) {
  const [hoveredId, setHoveredId] = useState(null);
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="w-full h-full flex flex-col pt-10 pb-[100px] px-2 md:px-4 relative">
      <div className="flex-1 flex items-end justify-between gap-2 md:gap-4 relative border-b border-[#26262E]">
        {skills.map((skill, index) => {
          const heightPct = Math.max((skill.count / maxCount) * 100, 5);
          const isHovered = hoveredId === skill.id;
          const isFaded = hoveredId !== null && hoveredId !== skill.id;

          // Equalizer entrance: bars grow from height 0 → target, staggered
          // 50 ms left-to-right using the bar spring.  When reduced-motion is
          // preferred we skip transforms and just fade in.
          const barInitial = shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 1 };
          const barAnimate = shouldReduceMotion
            ? { opacity: 1 }
            : { height: `${heightPct}%`, opacity: 1 };
          const barTransition = shouldReduceMotion
            ? { duration: 0.3, delay: index * BAR_STAGGER_MS }
            : { ...BAR_SPRING, delay: index * BAR_STAGGER_MS };

          const remotePct = skill.count
            ? Math.round((skill.remoteCount / skill.count) * 100)
            : 0;

          return (
            <div
              key={skill.id}
              className="relative flex flex-col items-center flex-1 h-full justify-end group cursor-pointer"
              onMouseEnter={() => setHoveredId(skill.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelect(skill)}
            >
              {/* Permanent value label */}
              <motion.div
                initial={labelInit}
                animate={labelShow}
                className={`absolute bottom-full mb-2 left-1/2 -translate-x-1/2 font-mono text-[10px] md:text-xs tracking-tight transition-colors duration-300 ${
                  isHovered ? "text-white" : "text-[#9A9AA6]"
                }`}
              >
                {skill.count.toLocaleString()}
              </motion.div>

              {/* Floating tooltip */}
              <AnimatePresence>
                {isHovered && (
                  <div className="absolute -top-24 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
                    <motion.div
                      initial={tipInit}
                      animate={tipShow}
                      exit={tipInit}
                      transition={tipTrans}
                      className="bg-[#08080A] border border-[#26262E] rounded-lg p-3 shadow-2xl flex flex-col gap-1 min-w-[120px]"
                    >
                      <div className="font-sans text-sm font-medium text-white">{skill.name}</div>
                      <div className="font-mono text-xs text-[#9A9AA6]">
                        {skill.count.toLocaleString()} jobs
                      </div>
                      <div className="font-mono text-[10px] text-[#EB0029] uppercase tracking-wider">
                        {remotePct}% Remote
                      </div>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>

              {/* The bar — grows from bottom using bar spring */}
              <div className="w-full max-w-[48px] relative h-full flex items-end">
                <motion.div
                  initial={barInitial}
                  animate={barAnimate}
                  transition={barTransition}
                  className={`w-full rounded-t-sm relative ${
                    isFaded ? "opacity-30 saturate-50" : "opacity-100"
                  } ${!shouldReduceMotion && isHovered ? "-translate-y-1.5" : ""}`}
                  style={barStyle}
                >
                  {/* Glow — brightens on hover per spec */}
                  <div
                    className={`absolute inset-0 bg-[#FF2740] blur-md rounded-t-sm -z-10 transition-opacity duration-300 ${
                      isHovered ? "opacity-80" : "opacity-0 group-hover:opacity-30"
                    }`}
                  />
                  <div className="absolute top-0 inset-x-0 h-px bg-white/30 rounded-t-sm" />
                </motion.div>
              </div>

              {/* Rotated name label below the axis */}
              <div
                className="absolute -bottom-3 left-1/2 flex justify-end items-center origin-top-left pointer-events-none"
                style={nameWrapStyle}
              >
                <span
                  className={`font-sans text-xs md:text-sm whitespace-nowrap pl-2 transition-colors duration-300 ${
                    isHovered ? "text-white font-medium" : "text-[#9A9AA6]"
                  }`}
                >
                  {skill.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
