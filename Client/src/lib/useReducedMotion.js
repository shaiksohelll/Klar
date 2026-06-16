import { useEffect, useState } from "react";

// useReducedMotion — the single source of truth for honoring
// prefers-reduced-motion across the Clarity motion layer. When it returns
// true, callers must disable tilt / count-up / blur and render final values
// instantly. Reacts live to OS preference changes.
export function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mql = window.matchMedia(query);
    const onChange = (e) => setReduced(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
