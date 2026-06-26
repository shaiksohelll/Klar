import { useId, useState } from "react";
import Num from "./Num";

// Confidence — the calibrated-trust indicator that must accompany every
// estimate / prediction in Klar. It shows a mono confidence %, a 5-segment
// bar, and an expandable "why" panel carrying the plain-language driver and
// the data source ("how we calculate this"). Probabilistic output is never
// shown as certainty.
//
// `level` is 0–100. Segments fill proportionally; the bar is never the only
// signal because the % is always shown in text beside it.
export default function Confidence({
  level = 0,
  why,
  source,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const filled = Math.round((Math.min(Math.max(level, 0), 100) / 100) * 5);
  const hasDetail = Boolean(why || source);

  return (
    <div className={["flex flex-col gap-1.5", className].join(" ")}>
      <div className="flex items-center gap-2">
        <span className="font-sans text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Confidence
        </span>
        <Num className="text-sm text-[var(--text)]">{level}%</Num>
        <div
          className="flex items-center gap-1"
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={[
                "h-1.5 w-4 rounded-[var(--radius-xs)]",
                i < filled ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]",
              ].join(" ")}
            />
          ))}
        </div>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="ml-1 font-sans text-xs text-[var(--muted)] underline underline-offset-2 hover:text-[var(--text)] focus-visible:outline-none focus-visible:shadow-[var(--glow-red)] rounded-[var(--radius-xs)]"
          >
            {open ? "Hide" : "Why?"}
          </button>
        )}
      </div>

      {hasDetail && open && (
        <div
          id={panelId}
          className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--muted)] leading-relaxed"
        >
          {why && <p className="text-[var(--text)]">{why}</p>}
          {source && (
            <p className="mt-1.5 text-xs">
              <span className="font-semibold uppercase tracking-[0.1em]">
                How we calculate this:
              </span>{" "}
              {source}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
