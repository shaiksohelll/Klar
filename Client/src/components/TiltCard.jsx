import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useRef } from "react";

const tiltSpring = { stiffness: 300, damping: 30 };
const outerStyle = { perspective: 1000 };
const innerStyle = { transform: "translateZ(40px)", transformStyle: "preserve-3d" };

export function TiltCard({ children, className = "" }) {
  const ref = useRef(null);

  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const mouseXSpring = useSpring(x, tiltSpring);
  const mouseYSpring = useSpring(y, tiltSpring);

  const rotateX = useTransform(mouseYSpring, [-0.5, 0.5], ["6deg", "-6deg"]);
  const rotateY = useTransform(mouseXSpring, [-0.5, 0.5], ["-6deg", "6deg"]);
  const cardStyle = { rotateX, rotateY, transformStyle: "preserve-3d" };

  const handleMouseMove = (e) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    x.set(mouseX / rect.width - 0.5);
    y.set(mouseY / rect.height - 0.5);
  };

  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <div style={outerStyle} className={`group w-full h-full relative ${className}`}>
      <motion.div
        ref={ref}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={cardStyle}
        className="w-full h-full relative rounded-2xl bg-linear-to-b from-[var(--panel)] to-[var(--surface-2)] border border-[var(--border)] overflow-hidden transition-shadow duration-500 hover:shadow-[0_20px_40px_rgba(0,0,0,0.6),_0_0_40px_rgba(235,0,41,0.05)]"
      >
        <div className="absolute top-0 right-0 w-32 h-32 bg-[#FF2740] rounded-full blur-[100px] opacity-10 pointer-events-none group-hover:opacity-20 transition-opacity duration-500" />
        <div style={innerStyle} className="w-full h-full relative z-10 p-6 md:p-8">
          {children}
        </div>
      </motion.div>
    </div>
  );
}
