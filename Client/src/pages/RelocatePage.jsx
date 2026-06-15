import { useState } from "react";
import axios from "axios";
import { motion } from "framer-motion";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

const CURRENCIES = ["INR", "USD", "GBP", "CAD", "AUD"];
const CURRENCY_SYMBOL = { INR: "\u20b9", USD: "$", GBP: "\u00a3", CAD: "$", AUD: "$" };

const EASE = [0.16, 1, 0.3, 1];

// Format a number in a currency with its symbol (no decimals — these are salaries).
function fmt(amount, currency) {
  if (amount == null) return "\u2014";
  const sym = CURRENCY_SYMBOL[currency] || "";
  return `${sym}${Math.round(amount).toLocaleString()}`;
}

// USD-baseline “real lifestyle” value (always reported in $).
function fmtUSD(amount) {
  if (amount == null) return "\u2014";
  return `$${Math.round(amount).toLocaleString()}`;
}

export default function RelocatePage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [salary, setSalary] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [hasOffer, setHasOffer] = useState(false);
  const [targetSalary, setTargetSalary] = useState("");

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const onSubmit = (e) => {
    e.preventDefault();
    // All async work + setState lives inside the IIFE; the handler body itself
    // performs no post-await state writes (consistent with our effect rules).
    (async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const params = { from: from.trim(), to: to.trim(), salary: Number(salary), currency };
        if (hasOffer && targetSalary !== "") params.targetSalary = Number(targetSalary);
        const res = await axios.get(`${API}/api/relocation`, { params });
        setResult(res.data);
      } catch (err) {
        const msg =
          err?.response?.data?.error ||
          "Couldn't compute relocation ROI. Check your inputs and try again.";
        setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  };

  // Purchasing-power delta drives the verdict badge colour.
  // Prefer roiPct (concrete offer); otherwise derive direction from price levels.
  const delta =
    result == null
      ? null
      : result.roiPct != null
        ? result.roiPct
        : result.toPriceLevel < result.fromPriceLevel
          ? 1
          : result.toPriceLevel > result.fromPriceLevel
            ? -1
            : 0;

  const deltaColor = delta == null ? "#9A9AA6" : delta > 0 ? "#3FB950" : delta < 0 ? "#EB0029" : "#9A9AA6";
  const deltaLabel =
    delta == null
      ? ""
      : result.roiPct != null
        ? `${result.roiPct > 0 ? "+" : ""}${result.roiPct}% real ${result.roiPct >= 0 ? "gain" : "cut"}`
        : delta > 0
          ? "Real purchasing-power gain"
          : delta < 0
            ? "Real purchasing-power cut"
            : "Roughly neutral";

  return (
    <main className="max-w-4xl mx-auto px-4 md:px-6 mt-16 md:mt-24 space-y-12 relative z-10">
      <section className="text-center max-w-2xl mx-auto space-y-6">
        <div className="font-mono text-[#EB0029] text-xs uppercase tracking-[0.2em] font-bold">
          Relocation ROI
        </div>
        <h1 className="font-space font-bold text-4xl md:text-6xl leading-[1.05] tracking-tight text-white">
          What your salary is{" "}
          <span className="text-[#EB0029] italic">really</span> worth.
        </h1>
        <p className="text-lg text-[#9A9AA6] font-medium">
          Convert a nominal salary into real, cost-of-living-adjusted purchasing
          power between two cities.
        </p>
      </section>

      {/* ── Form ── */}
      <form
        onSubmit={onSubmit}
        className="bg-[#121216] border border-[#26262E] rounded-2xl p-6 md:p-8 space-y-6"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <label className="space-y-2">
            <span className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">From city</span>
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="Bangalore (or IN)"
              className="w-full bg-[#08080A] border border-[#26262E] rounded-lg px-4 py-2.5 text-[#F4F4F6] placeholder:text-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors"
            />
          </label>
          <label className="space-y-2">
            <span className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">To city</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="San Francisco (or US)"
              className="w-full bg-[#08080A] border border-[#26262E] rounded-lg px-4 py-2.5 text-[#F4F4F6] placeholder:text-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <label className="space-y-2">
            <span className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">Current salary</span>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="2500000"
                className="flex-1 bg-[#08080A] border border-[#26262E] rounded-lg px-4 py-2.5 text-[#F4F4F6] placeholder:text-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors"
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="bg-[#08080A] border border-[#26262E] rounded-lg px-3 py-2.5 text-[#F4F4F6] font-mono text-sm focus:outline-none focus:border-[#EB0029] transition-colors"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </label>

          <div className="space-y-2">
            <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-[#9A9AA6] cursor-pointer">
              <input
                type="checkbox"
                checked={hasOffer}
                onChange={(e) => setHasOffer(e.target.checked)}
                className="accent-[#EB0029]"
              />
              I have an offer of
            </label>
            <input
              type="number"
              min="0"
              disabled={!hasOffer}
              value={targetSalary}
              onChange={(e) => setTargetSalary(e.target.value)}
              placeholder="Target salary (destination currency)"
              className="w-full bg-[#08080A] border border-[#26262E] rounded-lg px-4 py-2.5 text-[#F4F4F6] placeholder:text-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors disabled:opacity-40"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="bg-[#EB0029] hover:bg-[#FF2740] disabled:opacity-50 text-white px-6 py-2.5 rounded-full font-medium text-sm transition-all shadow-[0_0_20px_rgba(235,0,41,0.2)] hover:shadow-[0_0_30px_rgba(255,39,64,0.4)]"
        >
          {loading ? "Calculating\u2026" : "Calculate real value"}
        </button>
      </form>

      {/* ── States ── */}
      {error && (
        <div className="text-center py-6 font-mono text-sm text-[#EB0029]">{error}</div>
      )}

      {result && !error && (
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="bg-[#121216] border border-[#26262E] rounded-2xl p-6 md:p-8 space-y-6"
        >
          {/* Verdict */}
          <div className="space-y-3">
            <span
              className="inline-block font-mono text-xs uppercase tracking-widest px-3 py-1 rounded-full"
              style={{ color: deltaColor, border: `1px solid ${deltaColor}` }}
            >
              {deltaLabel}
            </span>
            <p className="text-xl md:text-2xl text-[#F4F4F6] leading-relaxed">
              Your {fmt(result.salary, result.currency)} in{" "}
              <span className="text-white font-semibold">{result.from.input}</span>{" "}
              ≈ {fmtUSD(result.realValueCurrent)} of real lifestyle. To match it in{" "}
              <span className="text-white font-semibold">{result.to.input}</span>, you’d need{" "}
              <span className="text-[#EB0029] font-semibold">
                {fmt(result.equivalentInTarget, result.to.currency || result.currency)}
              </span>
              .
            </p>
          </div>

          {/* Breakdown */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-[#26262E] rounded-xl overflow-hidden">
            {[
              ["Nominal (USD)", fmtUSD(result.nominalUSD)],
              [`${result.from.input} price level`, result.fromPriceLevel],
              [`${result.to.input} price level`, result.toPriceLevel],
              result.realValueTarget != null && ["Offer real value", fmtUSD(result.realValueTarget)],
              result.roiPct != null && ["ROI", `${result.roiPct > 0 ? "+" : ""}${result.roiPct}%`],
              ["Confidence", result.confidence],
            ]
              .filter(Boolean)
              .map(([label, value]) => (
                <div key={label} className="bg-[#121216] p-4">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-[#5C5C66] mb-1">
                    {label}
                  </div>
                  <div className="text-[#F4F4F6] font-semibold">{value}</div>
                </div>
              ))}
          </div>
        </motion.section>
      )}

      <footer className="font-mono text-[10px] text-[#5C5C66] text-center leading-relaxed max-w-2xl mx-auto">
        Country-level price data from World Bank (CC-BY-4.0); city adjustments are
        approximate. Not financial advice.
      </footer>
    </main>
  );
}
