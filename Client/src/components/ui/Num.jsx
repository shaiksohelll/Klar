// <Num> — the single gateway for every numeral the product renders.
//
// Klar's whole story is that nominal numbers resolve into sharp, mono truth,
// so every salary, %, currency, percentile, count and score flows through
// here: JetBrains Mono + tabular-nums for a stable baseline, optional verdict
// coloring, and right-alignment when used inside a table cell.
//
// It is presentational only — formatting stays with the caller so locale and
// currency logic are never duplicated here.
//
// When `children` is a plain number and no custom formatting is needed,
// toLocaleString() is applied automatically so e.g. 1500 renders as "1,500".

export default function Num({
  children,
  cell = false,   // right-align for tabular columns
  verdict,        // "pos" | "neg" | "neutral" | undefined
  as: Tag = "span",
  className = "",
  ...rest
}) {
  const verdictColor =
    verdict === "pos"
      ? "text-[var(--pos)]"
      : verdict === "neg"
        ? "text-[var(--neg)]"
        : verdict === "neutral"
          ? "text-[var(--neutral)]"
          : "";

  // Auto-format plain numbers for display consistency (e.g. 1500 → "1,500").
  const formatted =
    typeof children === "number" ? children.toLocaleString() : children;

  const classes = ["num", cell ? "num-cell" : "", verdictColor, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes} aria-label={String(formatted ?? "")} {...rest}>
      {formatted}
    </Tag>
  );
}
