// ── Shared money formatter ──────────────────────────────────────────────────
// INR uses lakh notation (L), all other currencies use million notation (M),
// both falling back to K below their respective thresholds.

const INR = (n) => {
  const l = n / 100_000;
  return l >= 1 ? `${l % 1 === 0 ? l : l.toFixed(1)}L` : `${Math.round(n / 1000)}K`;
};

const INTL = (n) => {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}K`;
};

const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function fmtMoney(n, currency) {
  if (n == null || !isFinite(n)) return null;
  const cur = currency || "INR";
  const sym = SYMBOL[cur] ?? `${cur} `;
  return cur === "INR" ? `${sym}${INR(n)}` : `${sym}${INTL(n)}`;
}
