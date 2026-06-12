import { describe, it, expect } from "vitest";
import { detectRemote } from "./remote.js";

describe("detectRemote", () => {
  it.each([
    "This is a fully remote position",
    "100% remote, work from anywhere",
    "We are a remote-first company",
    "Work from home opportunity",
    "WFH available for this role",
    "Remote",
    "Senior React Developer (Remote)",
  ])("returns true for clear positive signal: %s", (text) => {
    expect(detectRemote(text)).toBe(true);
  });

  it.each([
    "This role is not remote",
    "This is not a remote role",
    "No remote option for this position",
    "On-site only, Bangalore office",
    "Onsite only",
    "Hybrid \u2014 occasionally remote",
    "Hybrid working model",
    "Remote work is not available",
    "Backend developer position in Pune",
    "",
  ])("returns false for negated/qualified/absent: %s", (text) => {
    expect(detectRemote(text)).toBe(false);
  });
});
