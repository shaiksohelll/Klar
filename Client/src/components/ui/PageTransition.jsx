import { useEffect, useState } from "react";
import { useReducedMotion } from "../../lib/useReducedMotion";

// PageTransition — wraps route content so each screen fades + rises into
// place, settling with --ease-decelerate. Under reduced motion it renders
// children immediately with no transform or opacity animation.
//
// CSS-only (no framer-motion needed here) to keep route changes cheap and
// avoid layout shift while a page mounts.
export default function PageTransition({ children, className = "" }) {
  const reduced = useReducedMotion();
  const [entered, setEntered] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setEntered(true);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  const style = reduced
    ? undefined
    : {
        opacity: entered ? 1 : 0,
        transform: entered ? "translateY(0)" : "translateY(12px)",
        transition:
          "opacity var(--d-4) var(--ease-decelerate), transform var(--d-5) var(--ease-decelerate)",
      };

  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}
