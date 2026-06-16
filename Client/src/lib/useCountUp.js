import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

// useCountUp — animates a numeric value to its final figure as part of the
// "resolve" moment. Decelerating ease so the number settles rather than
// snaps. Under reduced motion it returns the target immediately with no RAF
// loop, so reading the value is never blocked or delayed.
//
// Returns the live numeric value; the caller formats it (and wraps it in
// <Num>) so locale/currency formatting is never duplicated here.
export function useCountUp(target, { duration = 700 } = {}) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);
  const rafRef = useRef(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const from = fromRef.current;
    const start = performance.now();

    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      // Quartic ease-out — approximates --ease-decelerate.
      const eased = 1 - Math.pow(1 - progress, 4);
      const next = from + (target - from) * eased;
      setValue(next);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, reduced]);

  return reduced ? target : value;
}
