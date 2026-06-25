/**
 * Num — inline numeric formatter.
 *
 * Wraps a numeral in a <span> with tabular-nums so digits don't jiggle
 * during count updates, and applies locale-aware formatting (commas etc.)
 * when the value is a plain number.
 *
 * Usage:
 *   <Num>{42}</Num>            → "42"
 *   <Num>{1500}</Num>          → "1,500"
 *   <Num className="…">72</Num>
 */
export default function Num({ children, className = "" }) {
  const raw = children;
  const formatted =
    typeof raw === "number"
      ? raw.toLocaleString()
      : String(raw ?? "");

  return (
    <span
      className={`tabular-nums ${className}`.trim()}
      aria-label={formatted}
    >
      {formatted}
    </span>
  );
}
