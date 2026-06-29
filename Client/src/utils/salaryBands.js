/**
 * Fixed whitelist of INR salary bands for the salary facet.
 * Shared between FilterBar (option labels) and useFacetFilters (chip labels).
 *
 * Band ids must stay in sync with Server/src/lib/salaryBands.js.
 * Labels and dropdown options live here (client-side);
 * ranges and Mongo $match logic live in the server counterpart.
 *
 * Bands apply only to disclosed, INR-denominated jobs.
 * midpoint is stored in absolute rupees (e.g. 1_500_000 = ₹15L).
 */
export const SALARY_BANDS = {
  lt10:   { label: "< ₹10L",   min: null,      max: 1_000_000  },
  "10to25": { label: "₹10–25L",  min: 1_000_000, max: 2_500_000  },
  "25to50": { label: "₹25–50L",  min: 2_500_000, max: 5_000_000  },
  gte50:  { label: "₹50L+",    min: 5_000_000, max: null        },
};

/** Ordered list of valid band IDs for whitelist checks. */
export const SALARY_BAND_IDS = Object.keys(SALARY_BANDS);

/** Look up the human-readable label for a band id, or "" if invalid. */
export function salaryBandLabel(id) {
  return SALARY_BANDS[id]?.label ?? "";
}
