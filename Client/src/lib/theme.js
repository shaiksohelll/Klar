// ─────────────────────────────────────────────────────────────────────────────
// theme.js — tiny, dependency-free light/dark theme helper.
//
// The user's explicit choice (localStorage "klar-theme") always wins. With no
// stored choice we respect the OS preference via prefers-color-scheme, falling
// back to "dark" (the app's default) when matchMedia is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_KEY = "klar-theme";

/**
 * Resolve the theme to use on load.
 * @returns {"light"|"dark"}
 */
export function getInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode / SSR) — fall through.
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

/**
 * Apply a theme: set the data-theme attribute (drives the CSS tokens) and
 * persist the choice. Safe to call repeatedly.
 * @param {"light"|"dark"} theme
 */
export function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", t);
  }
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // Persisting is best-effort; ignore storage failures.
  }
  return t;
}
