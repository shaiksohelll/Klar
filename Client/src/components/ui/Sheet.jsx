import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useReducedMotion } from "../../lib/useReducedMotion";

// Sheet — the liquid-glass slide-in surface used for mobile nav and any
// edge-anchored overlay. Same a11y contract as Modal (ESC, scrim, focus trap,
// scroll lock, focus restore). `side` controls the anchor edge.
export default function Sheet({
  open,
  onClose,
  side = "right",
  label = "Menu",
  children,
  className = "",
}) {
  const reduced = useReducedMotion();
  const ref = useFocusTrap(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const sideClasses =
    side === "left"
      ? "left-0 top-0 h-full w-[82%] max-w-xs rounded-r-[var(--radius-xl)]"
      : side === "bottom"
        ? "left-0 right-0 bottom-0 w-full rounded-t-[var(--radius-xl)]"
        : "right-0 top-0 h-full w-[82%] max-w-xs rounded-l-[var(--radius-xl)]";

  const anim =
    side === "left"
      ? "klar-sheet-left"
      : side === "bottom"
        ? "klar-sheet-up"
        : "klar-sheet-right";

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/55 cursor-default focus-visible:outline-none"
        style={
          reduced
            ? undefined
            : { animation: "klar-scrim var(--d-3) var(--ease-decelerate)" }
        }
        tabIndex={-1}
      />
      <div
        ref={ref}
        tabIndex={-1}
        className={[
          "glass absolute shadow-[var(--elev-3)] focus:outline-none",
          sideClasses,
          className,
        ].join(" ")}
        style={
          reduced ? undefined : { animation: `${anim} var(--d-4) var(--ease-decelerate)` }
        }
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
