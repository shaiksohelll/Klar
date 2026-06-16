import { forwardRef } from "react";

// Button — the one button in Clarity. Three variants, one shape (h44, r-md,
// 24px horizontal padding, Space Grotesk medium), the same --glow-red focus
// ring everywhere, and a quiet .98 press scale on a spring so every press
// feels acknowledged. >=44px tall to satisfy target-size (WCAG 2.5.8).
const VARIANTS = {
  primary:
    "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] border border-transparent",
  secondary:
    "bg-[var(--panel)] text-[var(--text)] border border-[var(--border)] hover:border-[var(--muted)]",
  ghost:
    "bg-transparent text-[var(--muted)] hover:text-[var(--text)] border border-transparent",
};

const Button = forwardRef(function Button(
  { variant = "primary", className = "", type = "button", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "inline-flex items-center justify-center gap-2",
        "h-11 px-6 rounded-[var(--radius-md)]",
        "font-sans font-medium text-[0.9375rem] leading-none",
        "transition-[transform,background-color,border-color,color] duration-[120ms]",
        "[transition-timing-function:var(--ease-spring)]",
        "active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none",
        "focus-visible:outline-none focus-visible:shadow-[var(--glow-red)]",
        VARIANTS[variant] || VARIANTS.primary,
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
});

export default Button;
