// ── Shared money formatter ──────────────────────────────────────────────────
// INR uses lakh notation (L), all other currencies use million notation (M),
// both falling back to K below their respective thresholds.

const INR = (n) => {
  const l = n / 100_000;
  if (l >= 1) return `${l % 1 === 0 ? l : l.toFixed(1)}L`;
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`;
};

const INTL = (n) => {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`;
};

const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function fmtMoney(n, currency) {
  if (n == null || !isFinite(n)) return null;
  const cur = currency || "INR";
  const sym = SYMBOL[cur] ?? `${cur} `;
  return cur === "INR" ? `${sym}${INR(n)}` : `${sym}${INTL(n)}`;
}
