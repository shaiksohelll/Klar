// Returns null (renders nothing) for flat trend or when velocity is missing.
// Props: velocity (number|null), trend ("up"|"down"|"flat"|"new")
export function VelocityBadge({ velocity = null, trend = "flat" }) {
  if (trend === "up" && velocity !== null) {
    return (
      <span className="inline-flex items-center shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium text-[#FF2740] bg-[#FF2740]/10">
        🔥 +{velocity}%
      </span>
    );
  }
  if (trend === "down" && velocity !== null) {
    return (
      <span className="inline-flex items-center shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium text-[#9A9AA6] bg-[#9A9AA6]/10">
        ▼ {Math.abs(velocity)}%
      </span>
    );
  }
  if (trend === "new") {
    return (
      <span className="inline-flex items-center shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px] font-medium text-[#FF2740] bg-[#FF2740]/10">
        NEW
      </span>
    );
  }
  return null;
}
