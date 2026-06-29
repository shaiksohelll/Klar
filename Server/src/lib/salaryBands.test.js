import { describe, it, expect } from "vitest";
import { salaryBandMatch, SALARY_BAND_IDS } from "./salaryBands.js";

describe("salaryBandMatch", () => {
  // ── Every valid band must include the INR + disclosed guards ────────────
  it("lt10 → currency:INR, salaryDisclosed:true, midpoint < 1_000_000", () => {
    const m = salaryBandMatch("lt10");
    expect(m["salaryRange.currency"]).toBe("INR");
    expect(m.salaryDisclosed).toBe(true);
    expect(m["salaryRange.midpoint"]).toEqual({ $lt: 1_000_000 });
  });

  it("10to25 → currency:INR, salaryDisclosed:true, midpoint ≥ 1M & < 2.5M", () => {
    const m = salaryBandMatch("10to25");
    expect(m["salaryRange.currency"]).toBe("INR");
    expect(m.salaryDisclosed).toBe(true);
    expect(m["salaryRange.midpoint"]).toEqual({ $gte: 1_000_000, $lt: 2_500_000 });
  });

  it("25to50 → currency:INR, salaryDisclosed:true, midpoint ≥ 2.5M & < 5M", () => {
    const m = salaryBandMatch("25to50");
    expect(m["salaryRange.currency"]).toBe("INR");
    expect(m.salaryDisclosed).toBe(true);
    expect(m["salaryRange.midpoint"]).toEqual({ $gte: 2_500_000, $lt: 5_000_000 });
  });

  it("gte50 → currency:INR, salaryDisclosed:true, midpoint ≥ 5M (no upper bound)", () => {
    const m = salaryBandMatch("gte50");
    expect(m["salaryRange.currency"]).toBe("INR");
    expect(m.salaryDisclosed).toBe(true);
    expect(m["salaryRange.midpoint"]).toEqual({ $gte: 5_000_000 });
  });

  // ── Invalid / unknown band ids return an empty object ──────────────────
  it("returns {} for an unknown band id", () => {
    expect(salaryBandMatch("bogus")).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(salaryBandMatch(undefined)).toEqual({});
  });

  it("returns {} for null", () => {
    expect(salaryBandMatch(null)).toEqual({});
  });

  // ── SALARY_BAND_IDS export matches the four defined bands ──────────────
  it("SALARY_BAND_IDS contains exactly the four band ids", () => {
    expect(SALARY_BAND_IDS).toEqual(new Set(["lt10", "10to25", "25to50", "gte50"]));
  });
});
