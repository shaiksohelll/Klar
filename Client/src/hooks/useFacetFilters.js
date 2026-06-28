import { useSearchParams } from "react-router-dom";
import { useCallback, useMemo } from "react";

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
const REMOTE_VALUES = new Set(["remote", "onsite"]);

// ── Normalizers ──────────────────────────────────────────────────────────────
function normalizeRole(raw) {
  if (!raw) return "All";
  const match = ROLES.find((r) => r.toLowerCase() === raw.toLowerCase());
  return match || "All";
}

function normalizeWindow(raw) {
  if (!raw) return "12M";
  const mapped = { 3: "3M", 6: "6M", 12: "12M" };
  const upper = String(raw).toUpperCase();
  if (WINDOWS.includes(upper)) return upper;
  return mapped[raw] || "12M";
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
    const rawRemote = searchParams.get("remote");
    return {
      role: normalizeRole(searchParams.get("role")),
      window: normalizeWindow(searchParams.get("w")),
      remote: rawRemote && REMOTE_VALUES.has(rawRemote) ? rawRemote : null,
      disclosed: searchParams.get("disclosed") === "1",
    };
  }, [searchParams]);

  // ── Write a single filter to the URL ────────────────────────────────────
  const setFilter = useCallback(
    (key, value) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        const paramKey = key === "window" ? "w" : key;

        // Omit default values to keep URLs clean.
        const isDefault =
          (key === "role" && (!value || value === "All")) ||
          (key === "window" && (!value || value === "12M")) ||
          (key === "remote" && !value) ||
          (key === "disclosed" && !value);

        if (isDefault) {
          next.delete(paramKey);
        } else {
          const urlValue =
            key === "disclosed"
              ? "1"
              : key === "role"
                ? value.toLowerCase()
                : key === "window"
                  ? String(value).replace(/M$/i, "")
                  : value;
          next.set(paramKey, urlValue);
        }
        return next;
      }, { replace: true });
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
        return next;
      }, { replace: true }),
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
    return chips;
  }, [filters]);

  return { filters, setFilter, clearFilter, clearAll, activeChips };
}
