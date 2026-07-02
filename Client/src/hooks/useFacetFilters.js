import { useSearchParams } from "react-router-dom";
import { useCallback, useMemo } from "react";
import { countryLabel } from "../utils/countryLabel";
import { SALARY_BAND_IDS, salaryBandLabel } from "../utils/salaryBands";

// ── Shared constants ─────────────────────────────────────────────────────────
export const ROLES = [
  "All",
  "Frontend",
  "Backend",
  "Fullstack",
  "DevOps",
  "Data",
  "Mobile",
];
export const WINDOWS = ["3M", "6M", "12M"];
export const WINDOW_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
// Forecast horizons (Foresight view). Kept small + honest: projecting further
// than banked history reasonably supports would over-claim.
export const HORIZONS = ["3M", "6M", "12M"];
export const HORIZON_MONTHS = { "3M": 3, "6M": 6, "12M": 12 };
const REMOTE_VALUES = new Set(["remote", "onsite"]);

// ── Normalizers ──────────────────────────────────────────────────────────────
export function normalizeRole(raw) {
  if (!raw) return "All";
  const match = ROLES.find((r) => r.toLowerCase() === raw.toLowerCase());
  return match || "All";
}

export function normalizeWindow(raw) {
  if (!raw) return "12M";
  const mapped = { 3: "3M", 6: "6M", 12: "12M" };
  const upper = String(raw).toUpperCase();
  if (WINDOWS.includes(upper)) return upper;
  return mapped[raw] || "12M";
}

// Forecast horizon. Default 6M (the API default). Same mapping style as window.
export function normalizeHorizon(raw) {
  if (!raw) return "6M";
  const mapped = { 3: "3M", 6: "6M", 12: "12M" };
  const upper = String(raw).toUpperCase();
  if (HORIZONS.includes(upper)) return upper;
  return mapped[raw] || "6M";
}

export function normalizeRemote(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return REMOTE_VALUES.has(cleaned) ? cleaned : null;
}

export function normalizeDisclosed(raw) {
  return !!raw && raw.trim() === "1";
}

export function normalizeCountry(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(cleaned) ? cleaned : null;
}

export function normalizeSalaryBand(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  return SALARY_BAND_IDS.includes(cleaned) ? cleaned : null;
}

/**
 * URL-backed faceted-filter state. Reads/writes role, w (window), remote,
 * and disclosed query params so filters survive refresh and are shareable.
 *
 * Follows the useSearchParams pattern established in ComparePage.
 */
export default function useFacetFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Derive filter values from the current URL ───────────────────────────
  const filters = useMemo(() => {
    return {
      role: normalizeRole(searchParams.get("role")),
      window: normalizeWindow(searchParams.get("w")),
      horizon: normalizeHorizon(searchParams.get("h")),
      remote: normalizeRemote(searchParams.get("remote")),
      disclosed: normalizeDisclosed(searchParams.get("disclosed")),
      country: normalizeCountry(searchParams.get("country")),
      salary: normalizeSalaryBand(searchParams.get("salary")),
    };
  }, [searchParams]);

  // ── Write a single filter to the URL ────────────────────────────────────
  const setFilter = useCallback(
    (key, value) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        const paramKey = key === "window" ? "w" : key === "horizon" ? "h" : key;

        // Omit default values to keep URLs clean.
        const isDefault =
          (key === "role" && (!value || value === "All")) ||
          (key === "window" && (!value || value === "12M")) ||
          (key === "horizon" && (!value || value === "6M")) ||
          (key === "remote" && !value) ||
          (key === "disclosed" && !value) ||
          (key === "country" && !value) ||
          (key === "salary" && !value);

        if (isDefault) {
          next.delete(paramKey);
        } else {
          const urlValue =
            key === "disclosed"
              ? "1"
              : key === "role"
                ? value.toLowerCase()
                : key === "window" || key === "horizon"
                  ? String(value).replace(/M$/i, "")
                  : value;
          next.set(paramKey, urlValue);
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // ── Clear a single filter (reset to its default) ────────────────────────
  const clearFilter = useCallback(
    (key) => setFilter(key, null),
    [setFilter],
  );

  // ── Clear every filter ──────────────────────────────────────────────────
  const clearAll = useCallback(
    () =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("role");
        next.delete("w");
        next.delete("remote");
        next.delete("disclosed");
        next.delete("country");
        next.delete("salary");
        return next;
      }),
    [setSearchParams],
  );

  // ── Chips: only non-default values ──────────────────────────────────────
  const activeChips = useMemo(() => {
    const chips = [];
    if (filters.role !== "All")
      chips.push({ key: "role", label: filters.role });
    if (filters.window !== "12M")
      chips.push({ key: "window", label: filters.window });
    if (filters.remote)
      chips.push({
        key: "remote",
        label: filters.remote === "remote" ? "Remote" : "On-site",
      });
    if (filters.disclosed)
      chips.push({ key: "disclosed", label: "Salary disclosed" });
    if (filters.country)
      chips.push({ key: "country", label: countryLabel(filters.country) });
    if (filters.salary)
      chips.push({ key: "salary", label: salaryBandLabel(filters.salary) });
    return chips;
  }, [filters]);

  return { filters, setFilter, clearFilter, clearAll, activeChips };
}
