import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { motion } from "framer-motion";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

const CURRENCIES = ["INR", "USD", "GBP", "CAD", "AUD"];
const CURRENCY_SYMBOL = { INR: "\u20b9", USD: "$", GBP: "\u00a3", CAD: "$", AUD: "$" };

// ISO-2 country -> default salary currency. Used to pre-fill the currency
// <select> when the From place resolves to a supported country, so we avoid
// nonsensical defaults like "$1,800,000 in Bengaluru".
const COUNTRY_CURRENCY = { in: "INR", us: "USD", gb: "GBP", ca: "CAD", au: "AUD" };

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

// ── Combobox ──────────────────────────────────────────────────────────
// Inline typeahead (no extra npm dep). As the user types we debounce ~200ms,
// query /api/places/suggest (min 2 chars) and show a dropdown. Picking a
// suggestion fills the visible label and reports its token via onSelect.
// Free typing (no pick) reports a null token, so the parent falls back to the
// raw text on submit.
function Combobox({ label, placeholder, value, onChange, onSelect }) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const rootRef = useRef(null);

  // Debounced fetch on value change. ALL setState (including the synchronous
  // resets) lives inside an async IIFE so react-hooks/set-state-in-effect
  // (an ERROR in CI) is never tripped by a state write in the effect body.
  useEffect(() => {
    const q = value.trim();
    let cancelled = false;
    let timer = null;

    (async () => {
      if (q.length < 2) {
        if (!cancelled) {
          setSuggestions([]);
          setSearched(false);
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      // Debounce ~200ms before hitting the suggest endpoint.
      await new Promise((resolve) => {
        timer = setTimeout(resolve, 200);
      });
      if (cancelled) return;
      try {
        const res = await axios.get(`${API}/api/places/suggest`, {
          params: { q, limit: 8 },
        });
        if (cancelled) return;
        setSuggestions(res.data.suggestions || []);
        setHighlight(-1);
        setSearched(true);
      } catch {
        // Fail quietly — typing should never throw a visible error.
        if (!cancelled) {
          setSuggestions([]);
          setSearched(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [value]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const pick = (s) => {
    onChange(s.label);
    onSelect({ token: s.token, country: s.country });
    setOpen(false);
    setSuggestions([]);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (highlight >= 0 && suggestions[highlight]) {
        e.preventDefault();
        pick(suggestions[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showPanel = open && value.trim().length >= 2;

  return (
    <label className="space-y-2 relative block" ref={rootRef}>
      <span className="font-mono text-xs uppercase tracking-widest text-[#9A9AA6]">{label}</span>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Typing invalidates any previously-picked token — fall back to raw.
          onSelect({ token: null, country: null });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={showPanel}
        className="w-full bg-[#08080A] border border-[#26262E] rounded-lg px-4 py-2.5 text-[#F4F4F6] placeholder:text-[#5C5C66] focus:outline-none focus:border-[#EB0029] transition-colors"
      />
      {showPanel && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-[#121216] border border-[#26262E] rounded-lg overflow-hidden shadow-2xl max-h-72 overflow-y-auto">
          {suggestions.length > 0 ? (
            suggestions.map((s, i) => (
              <button
                key={`${s.type}-${s.token}`}
                type="button"
                onMouseDown={(e) => {
                  // mousedown (not click) so it fires before the input blur.
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHighlight(i)}
                className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors"
                style={{ background: i === highlight ? "#1E1E24" : "transparent" }}
              >
                <span className="text-[#F4F4F6] text-sm truncate">{s.label}</span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-[#9A9AA6] shrink-0">
                  {s.type === "country" ? "Country" : s.country.toUpperCase()}
                </span>
              </button>
            ))
          ) : (
            !loading && searched && (
              <div className="px-4 py-2.5 font-mono text-xs text-[#9A9AA6]">No matches</div>
            )
          )}
        </div>
      )}
    </label>
  );
}

export default function RelocatePage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Picked tokens (geonameId for cities, iso2 for countries). null = free text.
  const [fromToken, setFromToken] = useState(null);
  const [toToken, setToToken] = useState(null);
  const [salary, setSalary] = useState("");
  const [currency, setCurrency] = useState("USD");
  // Whether the user manually changed the currency; once true we stop
  // auto-defaulting it from the From place.
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [hasOffer, setHasOffer] = useState(false);
  const [targetSalary, setTargetSalary] = useState("");

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // When the From place resolves to a supported country, default the salary
  // currency to that country's currency (unless the user overrode it).
  const onFromSelect = ({ token, country }) => {
    setFromToken(token);
    if (!currencyTouched && country && COUNTRY_CURRENCY[country]) {
      setCurrency(COUNTRY_CURRENCY[country]);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    // All async work + setState lives inside the IIFE; the handler body itself
    // performs no post-await state writes (consistent with our effect rules).
    (async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        // Send the stored token when a suggestion was picked; otherwise fall
        // back to the raw typed text.
        const params = {
          from: fromToken ?? from.trim(),
          to: toToken ?? to.trim(),
          salary: Number(salary),
          currency,
        };
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

  // Destination currency for the equivalent-needed headline + breakdown.
  const destCurrency = result ? result.to?.currency || result.currency : currency;

  // Resolved, human-readable place labels from the API. NEVER the submitted
  // token (which may be a bare numeric geonameId). Full label for the headline
  // ("Bengaluru, IN"); short city name for the compact breakdown labels
  // (falls back to the country displayName for country-level resolutions).
  const fromLabel = result ? result.from.displayName || result.from.input : "";
  const toLabel = result ? result.to.displayName || result.to.input : "";
  const fromCity = result ? result.from.city || result.from.displayName || result.from.input : "";
  const toCity = result ? result.to.city || result.to.displayName || result.to.input : "";

  // ── Offer mode (real-raise verdict) ──────────────────────────────────
  // An offer was evaluated when the API echoed a targetSalary and a roiPct.
  const hasOfferResult = !!(result && result.targetSalary != null && result.roiPct != null);

  // Verdict thresholds: >= +3% real raise (green), <= -3% real cut (red),
  // otherwise roughly flat (grey).
  const offerVerdict = (() => {
    if (!hasOfferResult) return null;
    const pct = result.roiPct;
    if (pct >= 3) {
      return { color: "#3FB950", label: `+${pct}% REAL RAISE`, word: "real raise" };
    }
    if (pct <= -3) {
      return { color: "#EB0029", label: `${pct}% REAL CUT`, word: "real cut" };
    }
    return { color: "#9A9AA6", label: "~ ROUGHLY FLAT", word: "roughly flat move" };
  })();

  // Break-even comparison: is the offer above or below the amount needed to
  // preserve the same real lifestyle in the destination?
  const breakEvenAbove =
    hasOfferResult && result.offerVsBreakEvenPct != null ? result.offerVsBreakEvenPct >= 0 : null;
  const breakEvenColor = breakEvenAbove == null ? "#9A9AA6" : breakEvenAbove ? "#3FB950" : "#EB0029";

  // Render a price level WITH its city multiplier when one is in play, e.g.
  // "25 x 0.95 = 23.75"; otherwise just the effective level.
  const priceLevelStr = (base, mult, effective) => {
    if (base != null && mult != null && mult !== 1) {
      return `${base} \u00d7 ${mult} = ${effective}`;
    }
    return String(effective);
  };

  // Per-place price-level breakdown strings, e.g. "25 x 0.95 = 23.75".
  // fromPriceLevel/toPriceLevel are already country x cityMultiplier; the
  // user-facing string reconstructs that product when a city multiplier is in
  // play (price level differs from a clean country base is not guaranteed, so
  // we simply show the effective level alongside the destination figure).
  const breakdownCells = result
    ? [
        ["Nominal (USD)", fmtUSD(result.nominalUSD)],
        [
          `${fromCity} price level`,
          priceLevelStr(result.fromBaseLevel, result.fromMultiplier, result.fromPriceLevel),
        ],
        [
          `${toCity} price level`,
          priceLevelStr(result.toBaseLevel, result.toMultiplier, result.toPriceLevel),
        ],
        ["Real value in origin", fmtUSD(result.realValueCurrent)],
        [`Equivalent needed in ${toCity}`, fmt(result.equivalentInTarget, destCurrency)],
        result.realValueTarget != null && ["Offer real value", fmtUSD(result.realValueTarget)],
        result.roiPct != null && ["ROI", `${result.roiPct > 0 ? "+" : ""}${result.roiPct}%`],
        ["Confidence", result.confidence],
      ].filter(Boolean)
    : [];

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
          <Combobox
            label="From city"
            placeholder="Bangalore (or IN)"
            value={from}
            onChange={setFrom}
            onSelect={onFromSelect}
          />
          <Combobox
            label="To city"
            placeholder="San Francisco (or US)"
            value={to}
            onChange={setTo}
            onSelect={({ token }) => setToToken(token)}
          />
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
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setCurrencyTouched(true);
                }}
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
              <span className="text-white font-semibold">{fromLabel}</span>{" "}
              ≈ {fmtUSD(result.realValueCurrent)} of real lifestyle. To match it in{" "}
              <span className="text-white font-semibold">{toLabel}</span>, you’d need{" "}
              <span className="text-[#EB0029] font-semibold">
                {fmt(result.equivalentInTarget, destCurrency)}
              </span>
              .
            </p>
          </div>

          {/* Breakdown — auto-fitting grid so cells never leave dangling gaps. */}
          <div
            className="grid gap-px bg-[#26262E] rounded-xl overflow-hidden"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
          >
            {breakdownCells.map(([label, value]) => (
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
