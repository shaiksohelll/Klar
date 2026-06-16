import { useEffect, useState } from "react";

// useTheme — a live read of the active theme straight from the documentElement
// `data-theme` attribute (the single source of truth set by the FOUC guard
// and applyTheme). A MutationObserver keeps subscribers in sync without a
// shared store, so Clerk's literal-hex appearance and any theme-aware chrome
// re-render the instant the toggle flips.
export function useTheme() {
  const read = () =>
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark";

  const [theme, setTheme] = useState(read);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    // Sync once in case the attribute changed between first render and effect.
    setTheme(read());
    return () => obs.disconnect();
  }, []);

  return theme;
}
