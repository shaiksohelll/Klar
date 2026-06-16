// Card — the bento tile. r-lg panel surface, hairline border, soft elev-1.
// col/row span props let a dashboard compose deliberate hierarchy (the
// decisive number gets the big tile) instead of an evenly-stamped grid.
//
// Spans use whole Tailwind class strings so the JIT compiler keeps them;
// never build span classes by interpolation.
const COL = {
  1: "md:col-span-1",
  2: "md:col-span-2",
  3: "md:col-span-3",
  4: "md:col-span-4",
  6: "md:col-span-6",
};
const ROW = {
  1: "md:row-span-1",
  2: "md:row-span-2",
  3: "md:row-span-3",
};

export default function Card({
  col = 1,
  row = 1,
  as: Tag = "div",
  className = "",
  children,
  ...rest
}) {
  return (
    <Tag
      className={[
        "bg-[var(--panel)] border border-[var(--border)]",
        "rounded-[var(--radius-lg)] shadow-[var(--elev-1)]",
        COL[col] || COL[1],
        ROW[row] || ROW[1],
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </Tag>
  );
}
