// Lazily created — fallback to uppercased ISO code if Intl is unavailable.
let _regionNames;

/**
 * Convert a lowercase ISO-2 country code to its English display name.
 * Falls back to the uppercased code if Intl.DisplayNames is unavailable.
 */
export function countryLabel(code) {
  if (!code) return "";
  try {
    if (!_regionNames) _regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    return _regionNames.of(code.toUpperCase()) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
