import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useReducedMotion } from "../../lib/useReducedMotion";

// Modal — the Clarity liquid-glass dialog. Centered, r-lg glass surface over a
// dimmed scrim. ESC closes, the scrim closes on click, focus is trapped while
// open and restored to the trigger on close, and body scroll is locked.
// This is the container the Clerk auth components are wrapped in.
export default function Modal({
  open,
  onClose,
  label = "Dialog",
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

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
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
          "glass relative w-full max-w-md rounded-[var(--radius-lg)]",
          "shadow-[var(--elev-3)] focus:outline-none",
          className,
        ].join(" ")}
        style={
          reduced
            ? undefined
            : { animation: "klar-modal-in var(--d-4) var(--ease-decelerate)" }
        }
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
