import { useEffect, useRef, useState } from "react";

/**
 * Animates an integer from 0 → target over `duration` ms.
 * Re-runs whenever `target` changes (filter changes).
 * Respects prefers-reduced-motion: returns `target` immediately without
 * any animation or setState calls inside the effect.
 */
export function useCountUp(target, duration = 700) {
  const [value, setValue] = useState(0);
  const rafRef = useRef(null);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    // When reduced motion is preferred, skip the RAF loop entirely —
    // no setState is called inside this branch.
    if (reducedMotion) return;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const start = performance.now();

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Approximate cubic-bezier(0.16, 1, 0.3, 1) with a quartic ease-out.
      const eased = 1 - Math.pow(1 - progress, 4);
      setValue(Math.round(target * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, reducedMotion]);

  // When reduced motion is on, bypass the animated value entirely.
  return reducedMotion ? target : value;
}
