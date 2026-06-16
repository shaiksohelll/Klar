// <Num> — the single gateway for every numeral the product renders.
//
// Klar's whole story is that nominal numbers resolve into sharp, mono truth,
// so every salary, %, currency, percentile, count and score flows through
// here: JetBrains Mono + tabular-nums for a stable baseline, optional verdict
// coloring, and right-alignment when used inside a table cell.
//
// It is presentational only — formatting stays with the caller so locale and
// currency logic are never duplicated here.

export default function Num({
  children,
  cell = false, // right-align for tabular columns
  verdict, // "pos" | "neg" | "neutral" | undefined
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

  const classes = ["num", cell ? "num-cell" : "", verdictColor, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
