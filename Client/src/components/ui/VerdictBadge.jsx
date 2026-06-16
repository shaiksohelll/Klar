import Num from "./Num";

// VerdictBadge — the verdict moment in a pill. A mono, tabular value sits next
// to a short uppercase label; color is the signal (pos green / neg red /
// neutral grey) and is the only place red is used as decoration-adjacent
// (it's still a verdict). Used for outputs like "+18% REAL RAISE".
//
// `tone` is explicit so callers control when the verdict color appears —
// during the resolve animation they pass "neutral" and switch to pos/neg only
// once the number has settled.
const TONE = {
  pos: {
    text: "text-[var(--pos)]",
    ring: "border-[var(--pos)]/40",
    bg: "bg-[var(--pos)]/10",
  },
  neg: {
    text: "text-[var(--neg)]",
    ring: "border-[var(--neg)]/40",
    bg: "bg-[var(--neg)]/10",
  },
  neutral: {
    text: "text-[var(--neutral)]",
    ring: "border-[var(--border)]",
    bg: "bg-[var(--surface-2)]",
  },
};

export default function VerdictBadge({
  value,
  label,
  tone = "neutral",
  className = "",
}) {
  const t = TONE[tone] || TONE.neutral;
  return (
    <span
      className={[
        "inline-flex items-center gap-2 px-3 h-8",
        "rounded-[var(--radius-pill)] border",
        t.ring,
        t.bg,
        className,
      ].join(" ")}
    >
      <Num className={`text-sm font-medium ${t.text}`}>{value}</Num>
      {label && (
        <span
          className={`font-sans text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ${t.text}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
