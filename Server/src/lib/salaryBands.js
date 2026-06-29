/**
 * Server-side salary band definitions (INR, absolute rupees).
 * The salary facet only applies to disclosed, INR-denominated jobs.
 *
 * Band ids must stay in sync with Client/src/utils/salaryBands.js.
 * Ranges and Mongo $match logic live here (server-side);
 * labels and dropdown options live in the client counterpart.
 */

const SALARY_BAND_RANGES = {
  lt10:     { gte: 0,         lt: 1_000_000  },
  "10to25": { gte: 1_000_000, lt: 2_500_000  },
  "25to50": { gte: 2_500_000, lt: 5_000_000  },
  gte50:    { gte: 5_000_000, lt: null        },
};

export const SALARY_BAND_IDS = new Set(Object.keys(SALARY_BAND_RANGES));

/**
 * Build a Mongo $match fragment for a validated salary band id.
 * Returns {} if the band id is not recognised.
 */
export function salaryBandMatch(bandId) {
  const range = SALARY_BAND_RANGES[bandId];
  if (!range) return {};
  const cond = {};
  cond["salaryRange.currency"] = "INR";
  cond.salaryDisclosed = true;
  const midCond = {};
  if (range.gte != null) midCond.$gte = range.gte;
  if (range.lt != null) midCond.$lt = range.lt;
  if (Object.keys(midCond).length) cond["salaryRange.midpoint"] = midCond;
  return cond;
}
