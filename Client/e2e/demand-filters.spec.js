// @ts-check
import { test, expect } from "@playwright/test";

// ── Fixture factories ────────────────────────────────────────────────────────

function makeTrending(overrides = {}) {
  const defaults = {
    totalJobs: 5000, role: "all", months: 12,
    velocityReady: true, velocityBasisDays: 7,
    skills: [
      { skill: "React", demand: 800, avgSalary: 90000, remoteCount: 200, velocity: 5, trend: "up" },
      { skill: "TypeScript", demand: 600, avgSalary: 85000, remoteCount: 150, velocity: 3, trend: "up" },
    ],
  };
  return { ok: true, ...defaults, ...overrides };
}

// Each fixture has a UNIQUE skill and unique totalJobs so stale renders
// are trivially detectable.
const FIXTURES = {
  default: makeTrending(),
  frontend: makeTrending({ totalJobs: 3000, role: "frontend", skills: [
    { skill: "Next.js", demand: 500, avgSalary: 88000, remoteCount: 120, velocity: 2, trend: "up" },
  ]}),
  frontend_6: makeTrending({ totalJobs: 1200, role: "frontend", months: 6, skills: [
    { skill: "Vue", demand: 300, avgSalary: 75000, remoteCount: 80, velocity: 2, trend: "up" },
  ]}),
  frontend_6_remote: makeTrending({ totalJobs: 700, role: "frontend", months: 6, skills: [
    { skill: "Svelte", demand: 180, avgSalary: 82000, remoteCount: 180, velocity: 8, trend: "up" },
  ]}),
  frontend_6_remote_disclosed: makeTrending({ totalJobs: 350, role: "frontend", months: 6, skills: [
    { skill: "Angular", demand: 120, avgSalary: 95000, remoteCount: 120, velocity: 1, trend: "up" },
  ]}),
  frontend_6_disclosed: makeTrending({ totalJobs: 900, role: "frontend", months: 6, skills: [
    { skill: "Tailwind", demand: 220, avgSalary: 72000, remoteCount: 0, velocity: 4, trend: "up" },
  ]}),
};

/** Pick fixture based on query params. Most specific combos first. */
function fixtureForParams(urlStr) {
  const url = new URL(urlStr);
  const role = url.searchParams.get("role") || "all";
  const months = url.searchParams.get("months") || "12";
  const remote = url.searchParams.get("remote") || "";
  const disclosed = url.searchParams.get("disclosed") || "";

  if (role === "frontend" && months === "6" && remote === "remote" && disclosed === "1")
    return FIXTURES.frontend_6_remote_disclosed;
  if (role === "frontend" && months === "6" && remote === "remote")
    return FIXTURES.frontend_6_remote;
  if (role === "frontend" && months === "6" && disclosed === "1")
    return FIXTURES.frontend_6_disclosed;
  if (role === "frontend" && months === "6")
    return FIXTURES.frontend_6;
  if (role === "frontend")
    return FIXTURES.frontend;
  return FIXTURES.default;
}

// ── Shared mock setup ────────────────────────────────────────────────────────

async function setupMocks(page) {
  const trendingRequests = [];

  await page.route("**/api/skills/trending*", async (route) => {
    trendingRequests.push(route.request().url());
    const body = fixtureForParams(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.route("**/api/skills/all*", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, skills: [] }),
    });
  });

  await page.route("**/api/watchlist*", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, skills: [] }),
    });
  });

  /** Find the last request matching the active facet tuple. */
  function findReq(expectedParams) {
    return [...trendingRequests].reverse().find((u) => {
      const url = new URL(u);
      return Object.entries(expectedParams).every(
        ([key, value]) => url.searchParams.get(key) === String(value),
      );
    }) ?? null;
  }

  return { trendingRequests, findReq };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for a skill to appear (polls via Playwright auto-retry). */
async function waitForSkill(page, skillName) {
  await expect(page.getByText(skillName).first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Target FilterBar pills (role/window/remote/disclosed).
 * Scoped to the <section> parent of FilterBar to avoid matching
 * the SkillSearch remote toggle elsewhere on the page.
 */
function pill(page, name) {
  // FilterBar renders as the first <section> with flex layout after the hero.
  // Its buttons have aria-pressed. SkillSearch's remote button has a unique id.
  return page
    .locator("section")
    .filter({ has: page.locator("button[aria-pressed='true'], button[aria-pressed='false']") })
    .first()
    .locator("button[aria-pressed]")
    .filter({ hasText: new RegExp(`^${name}$`, "i") });
}

/**
 * Get chip labels. Waits for the expected number of chips to stabilize
 * to avoid race conditions with React re-renders.
 */
async function getChipLabels(page, expectedCount) {
  const chipsLoc = page.locator("button[aria-label^='Remove']");
  if (typeof expectedCount === "number") {
    await expect(chipsLoc).toHaveCount(expectedCount, { timeout: 5000 });
  }
  const labels = await chipsLoc.allInnerTexts();
  return labels.map((t) => t.replace(/[×\n]/g, "").trim());
}

const DEMAND = "/";

// ═══════════════════════════════════════════════════════════════════════════════
// SPECS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Demand page filter URL-sync", () => {

  // ─── 1. Apply all four filters ─────────────────────────────────────────────
  test("1: apply filters sequentially -> URL, chips, request match", async ({ page }) => {
    const { findReq } = await setupMocks(page);
    await page.goto(DEMAND);
    await waitForSkill(page, "React");

    // Frontend
    await pill(page, "Frontend").click();
    await waitForSkill(page, "Next.js");

    // 6M
    await pill(page, "6M").click();
    await waitForSkill(page, "Vue");

    // Remote
    await pill(page, "Remote").click();
    await waitForSkill(page, "Svelte");

    // Salary disclosed
    await pill(page, "Salary Disclosed").click();
    await waitForSkill(page, "Angular");

    // URL
    const url = new URL(page.url());
    expect(url.searchParams.get("role")).toBe("frontend");
    expect(url.searchParams.get("w")).toBe("6");
    expect(url.searchParams.get("remote")).toBe("remote");
    expect(url.searchParams.get("disclosed")).toBe("1");

    // Chips (4 total)
    const chips = await getChipLabels(page, 4);
    expect(chips).toContain("FRONTEND");
    expect(chips).toContain("6M");
    expect(chips).toContain("REMOTE");
    expect(chips).toContain("SALARY DISCLOSED");

    // API params — find the request for months=6 (the active window)
    const reqUrl = new URL(findReq({ role: "frontend", months: 6, remote: "remote", disclosed: "1" }));
    expect(reqUrl.searchParams.get("role")).toBe("frontend");
    expect(reqUrl.searchParams.get("months")).toBe("6");
    expect(reqUrl.searchParams.get("remote")).toBe("remote");
    expect(reqUrl.searchParams.get("disclosed")).toBe("1");
  });

  // ─── 2. Remove one chip -> param drops, ranking updates ────────────────────
  test("2: remove one chip -> param drops, ranking updates", async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${DEMAND}?role=frontend&w=6&remote=remote&disclosed=1`);
    await waitForSkill(page, "Angular");

    await page.locator("button[aria-label='Remove Remote filter']").click();
    await waitForSkill(page, "Tailwind");

    const url = new URL(page.url());
    expect(url.searchParams.get("role")).toBe("frontend");
    expect(url.searchParams.get("w")).toBe("6");
    expect(url.searchParams.has("remote")).toBe(false);
    expect(url.searchParams.get("disclosed")).toBe("1");

    const chips = await getChipLabels(page, 3);
    expect(chips).not.toContain("REMOTE");
    expect(chips).toContain("FRONTEND");
  });

  // ─── 3. Clear all -> facet params removed, ranking resets ──────────────────
  test("3: clear all -> facet params removed, ranking resets", async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${DEMAND}?role=frontend&w=6&remote=remote&disclosed=1&foo=bar`);
    await waitForSkill(page, "Angular");

    await page.getByText("Clear all").click();
    await waitForSkill(page, "React");

    const url = new URL(page.url());
    expect(url.searchParams.has("role")).toBe(false);
    expect(url.searchParams.has("w")).toBe(false);
    expect(url.searchParams.has("remote")).toBe(false);
    expect(url.searchParams.has("disclosed")).toBe(false);
    expect(url.searchParams.get("foo")).toBe("bar");

    const chips = await getChipLabels(page, 0);
    expect(chips.length).toBe(0);
  });

  // ─── 4. Browser back/forward -> chips and ranking sync ─────────────────────
  test("4: browser back/forward -> ranking syncs with URL", async ({ page }) => {
    await setupMocks(page);
    await page.goto(DEMAND);
    await waitForSkill(page, "React");

    await pill(page, "Frontend").click();
    await waitForSkill(page, "Next.js");
    await pill(page, "6M").click();
    await waitForSkill(page, "Vue");

    // Back
    await page.goBack();
    await expect(page.getByText("Vue").first()).not.toBeVisible({ timeout: 5000 });

    // Forward
    await page.goForward();
    await waitForSkill(page, "Vue");
    const url = new URL(page.url());
    expect(url.searchParams.get("role")).toBe("frontend");
    expect(url.searchParams.get("w")).toBe("6");

    const chips = await getChipLabels(page, 2);
    expect(chips).toContain("FRONTEND");
    expect(chips).toContain("6M");
  });

  // ─── 5. Deep-link: URL params -> state restored on first paint ─────────────
  test("5: deep-link restores state on first paint", async ({ page }) => {
    const { findReq } = await setupMocks(page);

    await page.goto(`${DEMAND}?role=frontend&w=6&remote=remote&disclosed=1`);
    await waitForSkill(page, "Angular");

    const chips = await getChipLabels(page, 4);
    expect(chips).toContain("FRONTEND");
    expect(chips).toContain("6M");
    expect(chips).toContain("REMOTE");
    expect(chips).toContain("SALARY DISCLOSED");

    // Find the request for the active window (months=6)
    const reqUrl = new URL(findReq({ role: "frontend", months: 6, remote: "remote", disclosed: "1" }));
    expect(reqUrl.searchParams.get("role")).toBe("frontend");
    expect(reqUrl.searchParams.get("months")).toBe("6");
    expect(reqUrl.searchParams.get("remote")).toBe("remote");
    expect(reqUrl.searchParams.get("disclosed")).toBe("1");

    await expect(pill(page, "Frontend")).toHaveAttribute("aria-pressed", "true");
    await expect(pill(page, "Salary Disclosed")).toHaveAttribute("aria-pressed", "true");
  });
});
