// ─────────────────────────────────────────────────────────────────────────────
// costOfLiving.js — real (cost-of-living-adjusted) purchasing-power helpers.
//
// Converts nominal salaries across cities/countries into real value using
// World Bank price levels + FX rates (see scripts/build-col.mjs) plus
// hand-seeded per-city multipliers. The index (src/data/colIndex.json) is
// lazy-loaded once via readFileSync on first use — mirroring geocode.js — so
// importing this module is free.
//
// priceLevel convention: US = 100 (base). A country/city with priceLevel 120
// is 20% pricier than the US baseline; 25 is 75% cheaper.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "colIndex.json");

const US_PRICE_LEVEL = 100;

// Lazily-loaded index. null until the first call that needs it.
let INDEX = null;

/**
 * Lazy-load colIndex.json once. Degrades to a US-only base if the file is
 * missing/unbuilt so callers still get sensible (low-confidence) answers.
 */
function loadIndex() {
  if (INDEX) return INDEX;
  try {
    INDEX = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    INDEX = {
      base: "US",
      countries: { us: { currency: "USD", fx: 1, priceLevel: US_PRICE_LEVEL } },
      cityMultipliers: {},
    };
  }
  return INDEX;
}

// Test-only hook: reset the lazy cache so a test can swap the fixture.
export function _resetColCache() {
  INDEX = null;
}

/** Normalise an ISO-2 country code to the lowercase key used in the index. */
function normCountry(code) {
  return code ? String(code).toLowerCase() : null;
}

/**
 * Return the city multiplier for a geonameId (fallback 1.0 when unseeded).
 */
export function cityMultiplier(geonameId) {
  if (geonameId == null) return 1.0;
  const index = loadIndex();
  const m = index.cityMultipliers?.[String(geonameId)];
  return typeof m === "number" && Number.isFinite(m) ? m : 1.0;
}

/**
 * Resolve the FX rate (LCU per US$) for a currency code. USD -> 1.
 * Returns null when the currency is unknown.
 */
function fxForCurrency(currency) {
  if (!currency) return null;
  const cur = String(currency).toUpperCase();
  if (cur === "USD") return 1;
  const index = loadIndex();
  for (const c of Object.values(index.countries || {})) {
    if (c.currency === cur && typeof c.fx === "number") return c.fx;
  }
  return null;
}

/** Currency code for a country, or null if unknown. */
function currencyForCountry(countryCode) {
  const key = normCountry(countryCode);
  if (!key) return null;
  const index = loadIndex();
  return index.countries?.[key]?.currency ?? null;
}

/**
 * Effective price level for a place.
 *
 * @param {{ countryCode?: string, geonameId?: number|string }} arg
 * @returns {{ priceLevel: number, confidence: "high"|"low" }}
 *   priceLevel = country priceLevel * cityMultiplier(geonameId).
 *   When the country is unknown we fall back to the US base (100) and flag
 *   low confidence.
 */
export function getPriceLevel({ countryCode, geonameId } = {}) {
  const index = loadIndex();
  const key = normCountry(countryCode);
  const country = key ? index.countries?.[key] : null;

  if (!country || typeof country.priceLevel !== "number") {
    // Unknown country: fall back to US baseline, low confidence.
    return { priceLevel: US_PRICE_LEVEL * cityMultiplier(geonameId), confidence: "low" };
  }
  return { priceLevel: country.priceLevel * cityMultiplier(geonameId), confidence: "high" };
}

/**
 * Convert a local-currency amount to US dollars: amount / fx.
 * Unknown currency -> null.
 */
export function toUSD(amount, currency) {
  const fx = fxForCurrency(currency);
  if (fx == null || !Number.isFinite(amount)) return null;
  return amount / fx;
}

/**
 * Convert a US-dollar amount to a local currency: amountUSD * fx.
 * Unknown currency -> null.
 */
export function fromUSD(amountUSD, currency) {
  const fx = fxForCurrency(currency);
  if (fx == null || !Number.isFinite(amountUSD)) return null;
  return amountUSD * fx;
}

/**
 * Compute relocation purchasing-power ROI between two places.
 *
 * @param {{
 *   salary: number, currency: string,
 *   fromCountry: string, fromGeonameId?: number|string,
 *   toCountry: string, toGeonameId?: number|string,
 *   targetSalary?: number
 * }} args
 * @returns {{
 *   fromPriceLevel: number, toPriceLevel: number, nominalUSD: number|null,
 *   equivalentInTarget: number|null, realValueCurrent: number|null,
 *   realValueTarget: number|null, roiPct: number|null,
 *   confidence: "high"|"low"
 * }}
 */
export function relocationRoi({
  salary,
  currency,
  fromCountry,
  fromGeonameId,
  toCountry,
  toGeonameId,
  targetSalary,
} = {}) {
  const from = getPriceLevel({ countryCode: fromCountry, geonameId: fromGeonameId });
  const to = getPriceLevel({ countryCode: toCountry, geonameId: toGeonameId });
  const confidence = from.confidence === "low" || to.confidence === "low" ? "low" : "high";

  const nominalUSD = toUSD(salary, currency);

  // Salary expressed in the destination country's currency (FX only).
  const targetCurrency = currencyForCountry(toCountry);
  const salaryInTargetCurrency =
    nominalUSD != null && targetCurrency ? fromUSD(nominalUSD, targetCurrency) : null;

  // To preserve the SAME real lifestyle in the destination, scale the
  // FX-converted salary by the price-level ratio (pricier dest => need more).
  const equivalentInTarget =
    salaryInTargetCurrency != null && from.priceLevel > 0
      ? salaryInTargetCurrency * (to.priceLevel / from.priceLevel)
      : null;

  // Real value of the CURRENT salary, expressed in US-baseline dollars.
  const realValueCurrent =
    nominalUSD != null && from.priceLevel > 0
      ? nominalUSD / (from.priceLevel / 100)
      : null;

  // If the user has a concrete offer in the destination, compute its real
  // value and the ROI vs their current real value.
  let realValueTarget = null;
  let roiPct = null;
  if (targetSalary != null && Number.isFinite(targetSalary) && targetCurrency) {
    const targetUSD = toUSD(targetSalary, targetCurrency);
    if (targetUSD != null && to.priceLevel > 0) {
      realValueTarget = targetUSD / (to.priceLevel / 100);
      if (realValueCurrent != null && realValueCurrent > 0) {
        roiPct = Math.round(((realValueTarget - realValueCurrent) / realValueCurrent) * 100);
      }
    }
  }

  const round = (n) => (n == null ? null : Math.round(n));

  return {
    fromPriceLevel: Math.round(from.priceLevel * 100) / 100,
    toPriceLevel: Math.round(to.priceLevel * 100) / 100,
    nominalUSD: round(nominalUSD),
    equivalentInTarget: round(equivalentInTarget),
    realValueCurrent: round(realValueCurrent),
    realValueTarget: round(realValueTarget),
    roiPct,
    confidence,
  };
}
