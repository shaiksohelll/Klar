import { useEffect, useState } from "react";
import { useCountUp } from "../../lib/useCountUp";
import { useReducedMotion } from "../../lib/useReducedMotion";
import Num from "./Num";
import VerdictBadge from "./VerdictBadge";
import Confidence from "./Confidence";

// Reveal — the Klar core flow made literal. Four beats:
//   1. NOMINAL  — the number as the user thinks of it (raw, no verdict color)
//   2. FACTORS  — the cost-of-living / relocation adjustments being applied
//   3. RESOLVE  — the real value counts up + sharpens from blur; verdict color
//                 and the VerdictBadge appear ONLY once it has settled
//   4. WHY      — Confidence (%, plain why, how-we-calculate)
//
// The caller owns all numbers and formatting; Reveal owns only the
// choreography. `format(value)` renders the live animated figure so currency /
// locale logic is never duplicated here.
//
// Reduced motion: no blur, no count-up, verdict color shown immediately.
export default function Reveal({
  nominal, // { value, label }  — the raw figure
  factors = [], // [{ label, value }] — what's being applied
  realValue, // numeric target the count-up resolves to
  format = (n) => Math.round(n).toLocaleString(),
  verdict = "neutral", // "pos" | "neg" | "neutral" — the settled verdict
  verdictValue, // e.g. "+18%" shown in the badge
  verdictLabel, // e.g. "REAL RAISE"
  confidence, // { level, why, source } | undefined
  className = "",
}) {
  const reduced = useReducedMotion();
  const animated = useCountUp(realValue ?? 0, { duration: 900 });
  const [settled, setSettled] = useState(reduced);

  // Mark settled after the resolve duration so verdict color + badge only
  // appear on the resolved truth, never on the nominal noise.
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setSettled(true), 920);
    return () => clearTimeout(t);
  }, [realValue, reduced]);

  const displayValue = realValue == null ? null : format(animated);
  const verdictColorVar =
    verdict === "pos"
      ? "var(--pos)"
      : verdict === "neg"
        ? "var(--neg)"
        : "var(--neutral)";

  return (
    <div className={["flex flex-col gap-5", className].join(" ")}>
      {/* 1 — Nominal: the number as the user thinks of it. */}
      <div className="flex flex-col gap-1">
        <span className="font-sans text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          {nominal?.label || "Nominal"}
        </span>
        <Num className="text-2xl text-[var(--muted)]">{nominal?.value}</Num>
      </div>

      {/* 2 — Factors: visibly apply cost-of-living / relocation. */}
      {factors.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-l-2 border-[var(--border)] pl-4">
          {factors.map((f) => (
            <li
              key={f.label}
              className="flex items-baseline justify-between gap-4 text-sm"
            >
              <span className="text-[var(--muted)]">{f.label}</span>
              <Num className="text-[var(--text)]">{f.value}</Num>
            </li>
          ))}
        </ul>
      )}

      {/* 3 — Resolve: real value sharpens from blur + counts up; verdict color
             is applied only once settled. */}
      {realValue != null && (
        <div className="flex flex-col gap-3">
          <span className="font-sans text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Real value
          </span>
          <Num
            aria-live="polite"
            className={[
              "text-4xl font-medium leading-none",
              reduced ? "" : settled ? "resolved" : "resolving",
            ].join(" ")}
            style={{ color: settled ? verdictColorVar : "var(--text)" }}
          >
            {displayValue}
          </Num>

          {verdictValue && settled && (
            <VerdictBadge
              value={verdictValue}
              label={verdictLabel}
              tone={verdict}
            />
          )}
        </div>
      )}

      {/* 4 — Why: calibrated confidence. */}
      {confidence && (
        <Confidence
          level={confidence.level}
          why={confidence.why}
          source={confidence.source}
        />
      )}
    </div>
  );
}
