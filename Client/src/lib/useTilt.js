import { useCallback, useRef } from "react";
import { useReducedMotion } from "./useReducedMotion";

// useTilt — pointer-driven 3D tilt for hero / feature cards. Stays within
// --tilt-max at --perspective so it reads as a quiet response to the pointer,
// never a gimmick. No-op under reduced motion: the handlers do nothing and no
// transform is ever written.
//
// Usage:
//   const { ref, onPointerMove, onPointerLeave } = useTilt();
//   <div ref={ref} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} />
export function useTilt({ max = 6 } = {}) {
  const ref = useRef(null);
  const reduced = useReducedMotion();

  const onPointerMove = useCallback(
    (e) => {
      if (reduced || !ref.current) return;
      const el = ref.current;
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      const rotX = (-py * max).toFixed(2);
      const rotY = (px * max).toFixed(2);
      el.style.transform = `perspective(var(--perspective)) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    },
    [reduced, max],
  );

  const onPointerLeave = useCallback(() => {
    if (!ref.current) return;
    ref.current.style.transform =
      "perspective(var(--perspective)) rotateX(0deg) rotateY(0deg)";
  }, []);

  return { ref, onPointerMove, onPointerLeave, reduced };
}
