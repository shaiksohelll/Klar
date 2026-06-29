import { describe, it, expect } from "vitest";
import { salaryBandMatch, SALARY_BAND_IDS } from "./salaryBands.js";

describe("salaryBandMatch", () => {
  // ── Every valid band must include the INR + disclosed guards ────────────
  it("lt10 → currency:INR, salaryDisclosed:true, midpoint ≥ 0 & < 1_000_000 (synthetic floor excludes null)", () => {
    const m = salaryBandMatch("lt10");
    expect(m["salaryRange.currency"]).toBe("INR");
    expect(m.salaryDisclosed).toBe(true);
    // $gte: 0 is the synthetic floor — ensures null midpoints (BSON null < number)
    // are excluded from the "< ₹10L" bucket.
    expect(m["salaryRange.midpoint"]).toEqual({ $gte: 0, $lt: 1_000_000 });
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

  // ── lt10 $match must NOT match a doc where midpoint is null ────────────
  // In BSON, null is outside the numeric domain — { $gte: 0 } does NOT match
  // null. JavaScript's >= coerces null to 0 (null >= 0 === true), which differs
  // from MongoDB. We model the guard structurally: the $gte key must be present
  // and non-null, which is sufficient to exclude null midpoints in BSON.
  it("lt10 $match has $gte: 0 floor that excludes null midpoints in MongoDB", () => {
    const m = salaryBandMatch("lt10");
    const midCond = m["salaryRange.midpoint"];
    // The floor must exist and be a non-negative number so MongoDB's BSON
    // comparison excludes documents where midpoint is null.
    expect(midCond.$gte).toBe(0);
    expect(typeof midCond.$gte).toBe("number");
  });
});
