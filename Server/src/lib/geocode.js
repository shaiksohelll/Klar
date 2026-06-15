// ─────────────────────────────────────────────────────────────────────────────
// geocode.js — pure, synchronous, dependency-free city resolver.
//
// Resolves a normalized city token (produced by normalizeLocation()) to a
// VERIFIED GeoNames place. The gazetteer (src/data/cities.json) is built by
// scripts/build-cities.mjs and lazy-loaded once, on the first geocodeCity()
// call, via readFileSync — so importing this module is free and tests that
// never geocode pay no I/O cost.
//
// Index shape: a Map keyed by BOTH the lowercased ascii name AND the lowercased
// name, each mapping to an array of candidate records sorted by population desc.
// Looking up by either spelling therefore finds the most-populous match first.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "cities.json");

// Lazily-built index: key (lowercased name | ascii) -> records[] (pop desc).
let INDEX = null;

/**
 * Build the in-memory lookup index from cities.json (once).
 * Each record is registered under both its lowercased ascii name and its
 * lowercased name; per-key candidate arrays are sorted by population desc so
 * the first element is always the most populous match.
 */
function loadIndex() {
  if (INDEX) return INDEX;
  const map = new Map();
  let cities = [];
  try {
    cities = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    // Missing/unbuilt gazetteer: degrade gracefully to an empty index so
    // geocodeCity() returns confidence "none" rather than throwing.
    cities = [];
  }

  const add = (key, rec) => {
    if (!key) return;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(rec);
  };

  for (const c of cities) {
    const rec = {
      geonameId: c.id,
      city: c.name,
      admin1: c.admin1,
      country: (c.country || "").toLowerCase(),
      lat: c.lat,
      lng: c.lng,
      pop: c.pop || 0,
    };
    add((c.ascii || "").toLowerCase(), rec);
    add((c.name || "").toLowerCase(), rec);
  }

  // Sort every candidate list by population desc (highest first).
  for (const arr of map.values()) {
    arr.sort((a, b) => b.pop - a.pop);
  }

  INDEX = map;
  return INDEX;
}

/**
 * Resolve a normalized city token to a VERIFIED GeoNames place.
 *
 * @param {string} cityToken   already normalized (lowercase, punctuation
 *                             stripped) by normalizeLocation().
 * @param {string} [countryHint] ISO-3166 alpha-2, lowercased (e.g. "in").
 * @returns {{ value: {geonameId:number, city:string, admin1:string, country:string, lat:number, lng:number}|null, confidence: "exact"|"ambiguous"|"none" }}
 *   exact     = single match, OR matched on countryHint.
 *   ambiguous = multiple matches, picked by population.
 *   none      = no match.
 */
export function geocodeCity(cityToken, countryHint) {
  const index = loadIndex();
  const key = (cityToken || "").trim().toLowerCase();
  if (!key) return { value: null, confidence: "none" };

  const candidates = index.get(key);
  if (!candidates || candidates.length === 0) {
    return { value: null, confidence: "none" };
  }

  const hint = countryHint ? String(countryHint).toLowerCase() : null;

  // Strip the internal `pop` field before returning the public record shape.
  const shape = (rec) => ({
    geonameId: rec.geonameId,
    city: rec.city,
    admin1: rec.admin1,
    country: rec.country,
    lat: rec.lat,
    lng: rec.lng,
  });

  // Country hint given: prefer a candidate in that country.
  if (hint) {
    const inCountry = candidates.filter((c) => c.country === hint);
    if (inCountry.length > 0) {
      // Matched on the hint -> exact (candidates already pop-sorted).
      return { value: shape(inCountry[0]), confidence: "exact" };
    }
    // Hint provided but no candidate matched it: fall through to population.
  }

  // Single candidate -> exact. Multiple -> ambiguous, picked by population.
  if (candidates.length === 1) {
    return { value: shape(candidates[0]), confidence: "exact" };
  }
  return { value: shape(candidates[0]), confidence: "ambiguous" };
}

/**
 * Resolve a numeric geonameId directly to a VERIFIED GeoNames place.
 *
 * Deterministic lookup used by the typeahead: a suggestion stores the
 * geonameId, so on submit we resolve it exactly (no fuzzy name matching).
 * Scans the lazily-built index (records are shared across keys) and returns
 * the first record whose geonameId matches.
 *
 * @param {number|string} geonameId
 * @returns {{ geonameId:number, city:string, admin1:string, country:string, lat:number, lng:number }|null}
 */
export function geocodeById(geonameId) {
  const id = Number(geonameId);
  if (!Number.isFinite(id)) return null;
  const index = loadIndex();
  for (const arr of index.values()) {
    for (const rec of arr) {
      if (rec.geonameId === id) {
        return {
          geonameId: rec.geonameId,
          city: rec.city,
          admin1: rec.admin1,
          country: rec.country,
          lat: rec.lat,
          lng: rec.lng,
        };
      }
    }
  }
  return null;
}

// Common alias -> canonical-city spellings. Typing an alias surfaces the
// canonical GeoNames city (which stores only the official name). Keys are
// lowercased; values are matched against the gazetteer name/ascii index.
const CITY_ALIASES = {
  bangalore: "bengaluru",
  bombay: "mumbai",
  calcutta: "kolkata",
  madras: "chennai",
  gurgaon: "gurugram",
};

/**
 * Suggest VERIFIED cities for a free-typed query (typeahead backend).
 *
 * Case-insensitive substring match against BOTH the city name and the ascii
 * name in the existing gazetteer (reuses the lazy-loaded index — does NOT
 * re-read cities.json). A small alias map maps common spellings to their
 * canonical city so e.g. "bangalore" surfaces Bengaluru. Results are
 * de-duplicated by geonameId and ranked by population (desc).
 *
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {Array<{ geonameId:number, city:string, admin1:string, country:string, lat:number, lng:number, population:number }>}
 */
export function searchCities(query, limit = 8) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const cap = Math.max(1, Number(limit) || 8);

  const index = loadIndex();

  // Expand the query with any alias so typing the alias surfaces the canonical
  // city. We match on BOTH the original query and the aliased term.
  const needles = [q];
  if (CITY_ALIASES[q]) needles.push(CITY_ALIASES[q]);

  const seen = new Set();
  const out = [];
  for (const [key, arr] of index.entries()) {
    if (!needles.some((n) => key.includes(n))) continue;
    for (const rec of arr) {
      if (seen.has(rec.geonameId)) continue;
      seen.add(rec.geonameId);
      out.push({
        geonameId: rec.geonameId,
        city: rec.city,
        admin1: rec.admin1,
        country: rec.country,
        lat: rec.lat,
        lng: rec.lng,
        population: rec.pop || 0,
      });
    }
  }

  out.sort((a, b) => b.population - a.population);
  return out.slice(0, cap);
}
