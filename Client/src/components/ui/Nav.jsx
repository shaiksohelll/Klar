import { NavLink } from "react-router-dom";
import ThemeToggle from "../ThemeToggle";
import Brand from "../Brand";

// Nav — the liquid-glass chrome that frames every screen. Presentational: all
// auth state and freshness data are passed in from App so no data logic lives
// here. The brand is the Klar wordmark with a precise 8px red dot; the active
// route is marked with the accent. On mobile the link rail collapses into a
// glass Sheet (rendered by App) toggled by the menu button.
//
// Routes are listed in a fixed order and never reordered.
const ROUTES = [
  { to: "/", label: "Demand", end: true },
  { to: "/atlas", label: "Atlas" },
  { to: "/relocate", label: "Relocate" },
  { to: "/compare", label: "Compare" },
  { to: "/hiring", label: "Hiring" },
  { to: "/watchlist", label: "Watchlist" },
  { to: "/resume", label: "Resume Gap" },
  { to: "/about", label: "About" },
];

export function NavRoutes({ onNavigate, className = "" }) {
  const linkClass = ({ isActive }) =>
    [
      "whitespace-nowrap font-mono text-xs uppercase tracking-[0.14em] transition-colors",
      "focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] rounded-[var(--radius-xs)]",
      isActive
        ? "text-[var(--text)]"
        : "text-[var(--muted)] hover:text-[var(--text)]",
    ].join(" ");

  return (
    <>
      {ROUTES.map((r) => (
        <NavLink
          key={r.to}
          to={r.to}
          end={r.end}
          onClick={onNavigate}
          className={({ isActive }) => `${className} ${linkClass({ isActive })}`}
        >
          {r.label}
        </NavLink>
      ))}
    </>
  );
}

export default function Nav({
  freshness, // string like "3h ago" or null
  signedIn,
  onSignIn,
  onSignOut,
  onOpenMenu,
  userButton, // the Clerk <UserButton/> element, rendered last
}) {
  return (
    <nav className="glass sticky top-0 z-40 border-b border-[var(--glass-border)]">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        {/* Brand: wordmark + precise 8px red dot, optically nudged off the baseline. */}
        <NavLink
          to="/"
          className="flex items-baseline font-space text-xl font-bold tracking-tight text-[var(--text)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] rounded-[var(--radius-xs)]"
          aria-label="Klar home"
        >
          <Brand />
        </NavLink>

        {/* Desktop link rail. */}
        <div className="hidden flex-1 items-center justify-center gap-x-5 px-4 lg:gap-x-7 md:flex">
          <NavRoutes />
        </div>

        <div className="flex items-center gap-3">
          {freshness && (
            <span className="mr-1 hidden items-center gap-1.5 border-r border-[var(--border)] pr-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-2)] sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Updated {freshness}
            </span>
          )}

          <div className="hidden md:block">
            <ThemeToggle />
          </div>

          {signedIn ? (
            <>
              <button
                type="button"
                onClick={onSignOut}
                className="hidden font-mono text-xs uppercase tracking-[0.14em] text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] rounded-[var(--radius-xs)] md:inline"
              >
                Sign out
              </button>
              {userButton}
            </>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="hidden h-9 items-center rounded-[var(--radius-pill)] bg-[var(--accent)] px-5 font-sans text-sm font-medium text-white transition-[background-color,transform] duration-[120ms] [transition-timing-function:var(--ease-spring)] hover:bg-[var(--accent-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] md:inline-flex"
            >
              Sign in
            </button>
          )}

          {/* Mobile: hamburger opens the glass Sheet (rendered by App). */}
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
