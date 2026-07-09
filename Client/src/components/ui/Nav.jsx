import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { gsap } from "gsap";
import ThemeToggle from "../ThemeToggle";
import Brand from "../Brand";
import { useReducedMotion } from "../../lib/useReducedMotion";


// Routes are listed in a fixed order and never reordered.
const ROUTES = [
  { to: "/", label: "Demand", end: true },
  { to: "/trends", label: "Trends" },
  { to: "/forecast", label: "Foresight" },
  { to: "/atlas", label: "Atlas" },
  { to: "/relocate", label: "Relocate" },
  { to: "/compare", label: "Compare" },
  { to: "/hiring", label: "Hiring" },
  { to: "/watchlist", label: "Watchlist" },
  { to: "/resume", label: "Resume Gap" },
  { to: "/about", label: "About" },
];

// Red sweep color for the pill hover circle.
const circleStyle = { background: "#FF2740" };

// Callback-ref helper: block body returns undefined (React 19 cleanup-safe).
const assignRef = (refArr, i) => (el) => {
  refArr.current[i] = el;
};

// Plain links — used inside the mobile glass Sheet (rendered by App).
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

// Desktop rail — same routes, with the animated pill-sweep hover effect.
function NavPills() {
  const pillRefs = useRef([]);
  const circleRefs = useRef([]);
  const tlRefs = useRef([]);
  const tweenRefs = useRef([]);
  const reduceRef = useRef(false);

  // Sync the hook's reactive value into the ref so gsap enter/leave handlers
  // (which read reduceRef.current at call time) always use the live setting.
  const reduceMotion = useReducedMotion();
  useEffect(() => { reduceRef.current = reduceMotion; }, [reduceMotion]);

  useEffect(() => {
    let mounted = true;

    const build = () => {
      if (!mounted) return;
      pillRefs.current.forEach((pill, i) => {
        const circle = circleRefs.current[i];
        if (!pill || !circle) return;

        const { width: w, height: h } = pill.getBoundingClientRect();
        if (!w || !h) return;

        const R = ((w * w) / 4 + h * h) / (2 * h);
        const D = Math.ceil(2 * R) + 2;
        const delta =
          Math.ceil(R - Math.sqrt(Math.max(0, R * R - (w * w) / 4))) + 1;
        const originY = D - delta;

        circle.style.width = `${D}px`;
        circle.style.height = `${D}px`;
        circle.style.bottom = `-${delta}px`;
        gsap.set(circle, {
          xPercent: -50,
          scale: 0,
          transformOrigin: `50% ${originY}px`,
        });

        const label = pill.querySelector(".pill-label");
        const hover = pill.querySelector(".pill-label-hover");
        if (label) gsap.set(label, { y: 0 });
        if (hover) gsap.set(hover, { y: h + 12, opacity: 0 });

        tlRefs.current[i]?.kill();
        const tl = gsap.timeline({ paused: true });
        tl.to(
          circle,
          { scale: 1.2, xPercent: -50, duration: 2, ease: "power3.easeOut", overwrite: "auto" },
          0
        );
        if (label)
          tl.to(
            label,
            { y: -(h + 8), duration: 2, ease: "power3.easeOut", overwrite: "auto" },
            0
          );
        if (hover)
          tl.to(
            hover,
            { y: 0, opacity: 1, duration: 2, ease: "power3.easeOut", overwrite: "auto" },
            0
          );
        tlRefs.current[i] = tl;
      });
    };

      build();
  let rafId = 0;
  const onResize = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(build);
  };
  window.addEventListener("resize", onResize);
  if (document.fonts?.ready) document.fonts.ready.then(build).catch(() => {});

  return () => {
    mounted = false;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", onResize);
    tweenRefs.current.forEach((tw) => tw?.kill());
    tlRefs.current.forEach((tl) => tl?.kill());

    tweenRefs.current = [];
    tlRefs.current = [];
  };
}, []);

  const enter = (i) => {
    const tl = tlRefs.current[i];
    if (!tl) return;
    tweenRefs.current[i]?.kill();
    tweenRefs.current[i] = tl.tweenTo(tl.duration(), {
      duration: reduceRef.current ? 0 : 0.3,
      ease: "power3.easeOut",
      overwrite: "auto",
    });
  };
  const leave = (i) => {
    const tl = tlRefs.current[i];
    if (!tl) return;
    tweenRefs.current[i]?.kill();
    tweenRefs.current[i] = tl.tweenTo(0, {
      duration: reduceRef.current ? 0 : 0.2,
      ease: "power3.easeOut",
      overwrite: "auto",
    });
  };

  return (
    <>
      {ROUTES.map((r, i) => (
        <NavLink
          key={r.to}
          to={r.to}
          end={r.end}
          ref={assignRef(pillRefs, i)}
          onMouseEnter={() => enter(i)}
          onMouseLeave={() => leave(i)}
          onFocus={() => enter(i)}
          onBlur={() => leave(i)}
          className={({ isActive }) =>
            [
              "pill-link relative overflow-hidden inline-flex items-center justify-center h-9 px-4 rounded-[var(--radius-pill)]",
              "font-mono text-xs uppercase tracking-[0.14em] whitespace-nowrap no-underline cursor-pointer",
              "focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]",
              isActive ? "text-[var(--text)]" : "text-[var(--muted)]",
            ].join(" ")
          }
        >
          <span
            ref={assignRef(circleRefs, i)}
            className="absolute left-1/2 bottom-0 z-0 block rounded-full pointer-events-none"
            style={circleStyle}
            aria-hidden="true"
          />
          <span className="relative z-[1] inline-block leading-none">
            <span className="pill-label relative inline-block leading-none">
              {r.label}
            </span>
            <span
              className="pill-label-hover absolute left-0 top-0 inline-block leading-none text-white opacity-0"
              aria-hidden="true"
            >
              {r.label}
            </span>
          </span>
        </NavLink>
      ))}
    </>
  );
}

export default function Nav({
  freshness,
  signedIn,
  onSignIn,
  onSignOut,
  onOpenMenu,
  userButton,
}) {
  return (
    <nav className="glass sticky top-0 z-40 border-b border-[var(--glass-border)]">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <NavLink
          to="/"
          className="flex items-baseline font-space text-xl font-bold tracking-tight text-[var(--text)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] rounded-[var(--radius-xs)]"
          aria-label="Klar home"
        >
          <Brand />
        </NavLink>

        <div className="hidden flex-1 items-center justify-center gap-x-2 px-2 md:flex">
          <NavPills />
        </div>

        <div className="flex items-center gap-3">
          {freshness && (
            <span className="mr-1 hidden items-center gap-1.5 border-r border-[var(--border)] pr-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-2)] sm:flex">
              <span className="klar-pulse h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              Fresh jobs · updated {freshness}
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
