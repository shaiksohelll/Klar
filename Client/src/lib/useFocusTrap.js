import { useEffect, useRef } from "react";

// useFocusTrap — traps Tab focus within an open overlay, moves focus in on
// open, and restores it to the element that had focus before opening. Shared
// by Modal and Sheet so both behave identically for keyboard + AT users.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(open) {
  const containerRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    restoreRef.current = document.activeElement;

    const focusable = () =>
      Array.from(container.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the overlay (first focusable, else the container).
    const first = focusable()[0];
    (first || container).focus();

    const onKeyDown = (e) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger so keyboard users aren't dumped at <body>.
      const toRestore = restoreRef.current;
      if (toRestore && typeof toRestore.focus === "function") toRestore.focus();
    };
  }, [open]);

  return containerRef;
}
