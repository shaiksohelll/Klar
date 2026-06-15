// ─────────────────────────────────────────────────────────────────────────────
// build-col.mjs — Cost-of-living index builder (World Bank, no API key).
//
// Builds Server/src/data/colIndex.json: per-country price levels + FX rates
// plus hand-seeded city multipliers, used by lib/costOfLiving.js to convert
// nominal salaries into real, cost-of-living-adjusted purchasing power.
//
// Run:  node scripts/build-col.mjs
//
// Indicators (World Bank v2 API):
//   PA.NUS.PPPC.RF  PPP-to-market-FX conversion factor ratio (US ≈ 1.0).
//                   priceLevel = PA.NUS.PPPC.RF * 100  (so US = 100).
//   PA.NUS.FCRF     Official exchange rate (LCU per US$, period average).
//
// Recent years are frequently null, so for each indicator we walk to the most
// recent NON-NULL observation.
//
// Resilience: each fetch is retried; if the API is unreachable we KEEP the
// previously committed colIndex.json rather than overwrite it with empty or
// zeroed values.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "data");
const OUT_FILE = join(OUT_DIR, "colIndex.json");

// Supported countries. Easy to extend: add an ISO-2 + currency entry.
const COUNTRIES = [
  { iso2: "us", currency: "USD" },
  { iso2: "in", currency: "INR" },
  { iso2: "gb", currency: "GBP" },
  { iso2: "ca", currency: "CAD" },
  { iso2: "au", currency: "AUD" },
];

// Hand-seeded, APPROXIMATE city multipliers relative to the country's national
// price level (1.0 = national average). Keyed by GeoNames id (resolved via the
// cities15000 gazetteer). These are rough planning figures, NOT precise data.
const CITY_MULTIPLIERS = {
  1277333: 0.95, // Bengaluru, IN
  1275339: 1.15, // Mumbai, IN
  1273294: 1.05, // Delhi, IN
  1269843: 0.92, // Hyderabad, IN
  1259229: 0.98, // Pune, IN
  5391959: 1.55, // San Francisco, US
  5128581: 1.45, // New York City, US
  5809844: 1.25, // Seattle, US
  2643743: 1.30, // London, GB
  6167865: 1.15, // Toronto, CA
  2147714: 1.20, // Sydney, AU
};

const WB = "https://api.worldbank.org/v2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON with retries + a 10s timeout per attempt.
 * Returns the parsed JSON, or throws after the final attempt.
 */
async function fetchJson(url, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Walk a World Bank indicator response to the most recent NON-NULL value.
 * The response shape is [meta, [ { date, value }, ... ]] sorted newest-first.
 */
function latestNonNull(json) {
  const series = Array.isArray(json) ? json[1] : null;
  if (!Array.isArray(series)) return null;
  for (const row of series) {
    if (row && row.value != null) {
      return { value: Number(row.value), year: row.date };
    }
  }
  return null;
}

async function fetchCountry(iso2) {
  const upper = iso2.toUpperCase();
  const [pppcJson, fcrfJson] = await Promise.all([
    fetchJson(`${WB}/country/${upper}/indicator/PA.NUS.PPPC.RF?format=json&per_page=100`),
    fetchJson(`${WB}/country/${upper}/indicator/PA.NUS.FCRF?format=json&per_page=100`),
  ]);
  const pppc = latestNonNull(pppcJson);
  const fcrf = latestNonNull(fcrfJson);
  return { pppc, fcrf };
}

function loadPrevious() {
  try {
    return JSON.parse(readFileSync(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const previous = loadPrevious();
  const countries = {};
  let failures = 0;

  for (const { iso2, currency } of COUNTRIES) {
    try {
      const { pppc, fcrf } = await fetchCountry(iso2);
      if (iso2 === "us") {
        // Base country: priceLevel is pinned to 100, fx to 1.
        countries.us = { currency: "USD", fx: 1, priceLevel: 100 };
        continue;
      }
      if (!pppc || !fcrf) throw new Error("missing indicator value");
      countries[iso2] = {
        currency,
        fx: fcrf.value,
        priceLevel: pppc.value * 100,
      };
    } catch (err) {
      failures++;
      console.warn(`World Bank fetch failed for ${iso2}:`, err.message);
      // Keep the previously committed value for this country if we have one.
      if (previous?.countries?.[iso2]) {
        countries[iso2] = previous.countries[iso2];
        console.warn(`  -> kept previous value for ${iso2}`);
      }
    }
  }

  // Always ensure the US base exists even if its (pinned) branch was skipped.
  if (!countries.us) countries.us = { currency: "USD", fx: 1, priceLevel: 100 };

  // Resilience guard: if EVERY remote country failed and we have a previous
  // file, keep it wholesale rather than write a degraded index.
  const remoteCount = COUNTRIES.length - 1; // excluding pinned US
  if (failures >= remoteCount && previous) {
    console.warn("All remote fetches failed — keeping previous colIndex.json untouched.");
    return;
  }

  const out = {
    base: "US",
    generatedAt: new Date().toISOString(),
    countries,
    // City multipliers are static hand-seeded approximations; preserve any
    // previously committed extras by merging the seed on top.
    cityMultipliers: { ...(previous?.cityMultipliers || {}), ...CITY_MULTIPLIERS },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_FILE} (${Object.keys(countries).length} countries, ${failures} failures)`);
}

main();
