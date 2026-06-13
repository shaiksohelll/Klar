import { describe, it, expect } from "vitest"
import { resolveSkill, resolveRole, KNOWN_ROLES } from "./validate.js"
import { normalizeRole, SKILL_TAXONOMY } from "./skills.js"

describe("resolveSkill", () => {
  it("accepts canonical skills as-is", () => {
    expect(resolveSkill("react")).toBe("react")
    expect(resolveSkill("node.js")).toBe("node.js")
    expect(resolveSkill("c++")).toBe("c++")
    expect(resolveSkill("c#")).toBe("c#")
    expect(resolveSkill("ci/cd")).toBe("ci/cd")
  })

  it("trims and lowercases", () => {
    expect(resolveSkill("  React ")).toBe("react")
    expect(resolveSkill("NODE.JS")).toBe("node.js")
  })

  it("resolves aliases to canonical form", () => {
    expect(resolveSkill("reactjs")).toBe("react")
    expect(resolveSkill("react.js")).toBe("react")
    expect(resolveSkill("k8s")).toBe("kubernetes")
    expect(resolveSkill("nodejs")).toBe("node.js")
    expect(resolveSkill("postgres")).toBe("postgresql")
    expect(resolveSkill("google cloud")).toBe("gcp")
    expect(resolveSkill("nextjs")).toBe("next.js")
    expect(resolveSkill("html5")).toBe("html")
  })

  it("rejects unknown / malformed input as null", () => {
    expect(resolveSkill("asdfghjkl")).toBeNull()
    expect(resolveSkill("react; drop table jobs")).toBeNull()
    expect(resolveSkill("")).toBeNull()
    expect(resolveSkill("   ")).toBeNull()
    expect(resolveSkill(undefined)).toBeNull()
    expect(resolveSkill(null)).toBeNull()
    expect(resolveSkill(123)).toBeNull()
  })

  it("resolves every canonical taxonomy entry to itself", () => {
    for (const s of SKILL_TAXONOMY) {
      expect(resolveSkill(s)).toBe(s.toLowerCase())
    }
  })
})

describe("resolveRole", () => {
  it("accepts known role buckets, case/space-insensitive", () => {
    expect(resolveRole("backend")).toBe("backend")
    expect(resolveRole("Backend")).toBe("backend")
    expect(resolveRole(" data ")).toBe("data")
    expect(resolveRole("fullstack")).toBe("fullstack")
    expect(resolveRole("other")).toBe("other")
  })

  it("rejects unknown / malformed input as null", () => {
    expect(resolveRole("wizard")).toBeNull()
    expect(resolveRole("")).toBeNull()
    expect(resolveRole(null)).toBeNull()
    expect(resolveRole(42)).toBeNull()
  })
})

describe("KNOWN_ROLES integrity", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(KNOWN_ROLES)).toBe(true)
  })

  it("covers every value normalizeRole() can emit", () => {
    const titles = [
      "Senior Full Stack Engineer",
      "Frontend Developer",
      "Backend Engineer",
      "DevOps Engineer",
      "Site Reliability Engineer (SRE)",
      "Data Scientist",
      "Android Mobile Developer",
      "iOS Engineer",
      "Project Manager",
      "",
    ]
    for (const t of titles) {
      expect(KNOWN_ROLES).toContain(normalizeRole(t))
    }
  })
})
