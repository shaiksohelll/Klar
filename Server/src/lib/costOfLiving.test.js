import { describe, it, expect } from "vitest";
import {
  getPriceLevel,
  cityMultiplier,
  toUSD,
  fromUSD,
  relocationRoi,
} from "./costOfLiving.js";

// These tests run against the committed seed fixture src/data/colIndex.json:
//   us: fx 1,    priceLevel 100
//   in: fx 83,   priceLevel 25
//   gb: fx 0.78, priceLevel 98
// City multipliers (seed): Bengaluru(1277333)=0.95, NYC(5128581)=1.45,
//   San Francisco(5391959)=1.55.

describe("getPriceLevel", () => {
  it("returns the country price level when no city multiplier applies", () => {
    const { priceLevel, confidence } = getPriceLevel({ countryCode: "us" });
    expect(priceLevel).toBe(100);
    expect(confidence).toBe("high");
  });

  it("applies the city multiplier to the country price level", () => {
    // India national 25 * Bengaluru 0.95 = 23.75
    const { priceLevel } = getPriceLevel({ countryCode: "in", geonameId: 1277333 });
    expect(priceLevel).toBeCloseTo(23.75, 5);
  });

  it("falls back to the US baseline with low confidence for an unknown country", () => {
    const { priceLevel, confidence } = getPriceLevel({ countryCode: "zz" });
    expect(priceLevel).toBe(100);
    expect(confidence).toBe("low");
  });
});

describe("cityMultiplier", () => {
  it("returns the seeded multiplier for a known city", () => {
    expect(cityMultiplier(5128581)).toBe(1.45); // New York City
  });
  it("falls back to 1.0 for an unseeded city", () => {
    expect(cityMultiplier(99999999)).toBe(1.0);
  });
  it("falls back to 1.0 when geonameId is missing", () => {
    expect(cityMultiplier(undefined)).toBe(1.0);
  });
});

describe("toUSD / fromUSD", () => {
  it("converts local currency to USD by dividing by fx", () => {
    // 8300 INR / 83 = 100 USD
    expect(toUSD(8300, "INR")).toBeCloseTo(100, 5);
  });

  it("USD is identity (fx = 1)", () => {
    expect(toUSD(100, "USD")).toBe(100);
    expect(fromUSD(100, "USD")).toBe(100);
  });

  it("round-trips an amount through USD and back", () => {
    const original = 1_250_000; // INR
    const usd = toUSD(original, "INR");
    const back = fromUSD(usd, "INR");
    expect(back).toBeCloseTo(original, 4);
  });

  it("returns null for an unknown currency", () => {
    expect(toUSD(100, "ZZZ")).toBeNull();
    expect(fromUSD(100, "ZZZ")).toBeNull();
  });
});

describe("relocationRoi — sign correctness", () => {
  it("yields a REAL GAIN when the same offer moves to a CHEAPER country", () => {
    // Same USD-equivalent target salary, destination IN (priceLevel 25) is far
    // cheaper than US (100). realValueTarget should EXCEED realValueCurrent,
    // so roiPct must be positive.
    const r = relocationRoi({
      salary: 100000,
      currency: "USD",
      fromCountry: "us",
      toCountry: "in",
      // 100000 USD in INR at fx 83 = 8,300,000 INR offer in India.
      targetSalary: 8_300_000,
    });
    expect(r.roiPct).toBeGreaterThan(0);
    expect(r.realValueTarget).toBeGreaterThan(r.realValueCurrent);
  });

  it("yields a REAL CUT when the same offer moves to a PRICIER country", () => {
    // Reverse direction: IN -> US. The FX-equivalent offer in the US has the
    // same nominal USD value but buys less real lifestyle (US pricier).
    const r = relocationRoi({
      salary: 8_300_000,
      currency: "INR",
      fromCountry: "in",
      toCountry: "us",
      targetSalary: 100000, // USD
    });
    expect(r.roiPct).toBeLessThan(0);
    expect(r.realValueTarget).toBeLessThan(r.realValueCurrent);
  });

  it("equivalentInTarget scales DOWN moving to a cheaper destination", () => {
    // Need LESS nominal money in a cheaper place to keep the same lifestyle.
    const r = relocationRoi({
      salary: 100000,
      currency: "USD",
      fromCountry: "us",
      toCountry: "in",
    });
    // equivalentInTarget is in INR; convert back to USD for a fair comparison.
    const equivUSD = r.equivalentInTarget / 83;
    expect(equivUSD).toBeLessThan(100000);
  });

  it("applies the destination city multiplier (pricier metro => higher equivalent)", () => {
    const national = relocationRoi({
      salary: 100000, currency: "USD", fromCountry: "us", toCountry: "us",
    });
    const sf = relocationRoi({
      salary: 100000, currency: "USD", fromCountry: "us", toCountry: "us",
      toGeonameId: 5391959, // San Francisco, multiplier 1.55
    });
    expect(sf.equivalentInTarget).toBeGreaterThan(national.equivalentInTarget);
    expect(sf.toPriceLevel).toBeCloseTo(155, 5);
  });
});

describe("relocationRoi — confidence", () => {
  it("flags low confidence when a location's country is unknown", () => {
    const r = relocationRoi({
      salary: 100000, currency: "USD", fromCountry: "us", toCountry: "zz",
    });
    expect(r.confidence).toBe("low");
  });

  it("reports high confidence for two known countries", () => {
    const r = relocationRoi({
      salary: 100000, currency: "USD", fromCountry: "us", toCountry: "in",
    });
    expect(r.confidence).toBe("high");
  });
});
