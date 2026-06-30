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
  frontend_6_remote_disclosed_in: makeTrending({ totalJobs: 150, role: "frontend", months: 6, skills: [
    { skill: "Remix", demand: 60, avgSalary: 70000, remoteCount: 60, velocity: 10, trend: "up" },
  ]}),
  frontend_6_disclosed: makeTrending({ totalJobs: 900, role: "frontend", months: 6, skills: [
    { skill: "Tailwind", demand: 220, avgSalary: 72000, remoteCount: 0, velocity: 4, trend: "up" },
  ]}),
  // Salary band fixtures (default role, default window)
  salary_10to25: makeTrending({ totalJobs: 2200, skills: [
    { skill: "Node.js", demand: 440, avgSalary: 1800000, remoteCount: 100, velocity: 3, trend: "up" },
  ]}),
  // Combined: role=frontend + salary=10to25 — unique skill so test 8 can
  // detect if the app stops forwarding salary when another facet is also active.
  frontend_salary_10to25: makeTrending({ totalJobs: 850, role: "frontend", skills: [
    { skill: "Gatsby", demand: 170, avgSalary: 1600000, remoteCount: 50, velocity: 2, trend: "up" },
  ]}),
};

/** Pick fixture based on query params. Most specific combos first. */
function fixtureForParams(urlStr) {
  const url = new URL(urlStr);
  const role = url.searchParams.get("role") || "all";
  const months = url.searchParams.get("months") || "12";
  const remote = url.searchParams.get("remote") || "";
  const disclosed = url.searchParams.get("disclosed") || "";
  const country = url.searchParams.get("country") || "";
  const salary = url.searchParams.get("salary") || "";

  // Salary-aware branch FIRST: if salary is present with role=frontend, return
  // the combined fixture regardless of the window. This ensures salary is never
  // shadowed by a months-specific branch (e.g. role=frontend&months=6&salary=10to25
  // previously hit frontend_6 before reaching this check).
  if (role === "frontend" && salary === "10to25")
    return FIXTURES.frontend_salary_10to25;
  if (role === "frontend" && months === "6" && remote === "remote" && disclosed === "1" && country === "in")
    return FIXTURES.frontend_6_remote_disclosed_in;
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
  // Salary band fixtures (all-role, 12M)
  if (salary === "10to25" && role === "all")
    return FIXTURES.salary_10to25;
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

  await page.route("**/api/places/countries*", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, countries: [{ code: "in", count: 500 }, { code: "us", count: 300 }] }),
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

    // Country — select India from the dropdown
    await page.locator("select[aria-label='Filter by country']").selectOption("in");
    await waitForSkill(page, "Remix");

    // URL
    const url = new URL(page.url());
    expect(url.searchParams.get("role")).toBe("frontend");
    expect(url.searchParams.get("w")).toBe("6");
    expect(url.searchParams.get("remote")).toBe("remote");
    expect(url.searchParams.get("disclosed")).toBe("1");
    expect(url.searchParams.get("country")).toBe("in");

    // Chips (5 total)
    const chips = await getChipLabels(page, 5);
    expect(chips).toContain("FRONTEND");
    expect(chips).toContain("6M");
    expect(chips).toContain("REMOTE");
    expect(chips).toContain("SALARY DISCLOSED");
    expect(chips).toContain("INDIA");

    // API params
    const reqUrl = new URL(findReq({ role: "frontend", months: 6, remote: "remote", disclosed: "1", country: "in" }));
    expect(reqUrl.searchParams.get("role")).toBe("frontend");
    expect(reqUrl.searchParams.get("months")).toBe("6");
    expect(reqUrl.searchParams.get("remote")).toBe("remote");
    expect(reqUrl.searchParams.get("disclosed")).toBe("1");
    expect(reqUrl.searchParams.get("country")).toBe("in");
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
    expect(url.searchParams.has("country")).toBe(false);
    expect(url.searchParams.get("foo")).toBe("bar");

    const chips = await getChipLabels(page, 0);
    expect(chips.length).toBe(0);

    // Country dropdown should reset to "All countries" (empty value).
    await expect(page.locator("select[aria-label='Filter by country']")).toHaveValue("");
  });

  // ─── 4. Browser back/forward -> chips and ranking sync ─────────────────────
  test("4: browser back/forward -> ranking syncs with URL", async ({ page }) => {
    await setupMocks(page);
    await page.goto(DEMAND);
    await waitForSkill(page, "React");

    // Push entry 1: Frontend (role=frontend, window=12M)
    await pill(page, "Frontend").click();
    await waitForSkill(page, "Next.js");

    // Push entry 2: 6M (role=frontend, window=6M)
    await pill(page, "6M").click();
    await waitForSkill(page, "Vue");

    // Back → should land on entry 1: role=frontend, no w param (12M default)
    await page.goBack();
    await waitForSkill(page, "Next.js");

    const backUrl = new URL(page.url());
    expect(backUrl.searchParams.get("role")).toBe("frontend");
    expect(backUrl.searchParams.has("w")).toBe(false);

    const backChips = await getChipLabels(page, 1);
    expect(backChips).toContain("FRONTEND");

    // Forward → should restore entry 2: role=frontend, w=6
    await page.goForward();
    await waitForSkill(page, "Vue");

    const fwdUrl = new URL(page.url());
    expect(fwdUrl.searchParams.get("role")).toBe("frontend");
    expect(fwdUrl.searchParams.get("w")).toBe("6");

    const fwdChips = await getChipLabels(page, 2);
    expect(fwdChips).toContain("FRONTEND");
    expect(fwdChips).toContain("6M");
  });

  // ─── 5. Deep-link: URL params -> state restored on first paint ─────────────
  test("5: deep-link restores state on first paint", async ({ page }) => {
    const { findReq } = await setupMocks(page);

    await page.goto(`${DEMAND}?role=frontend&w=6&remote=remote&disclosed=1&country=in`);
    await waitForSkill(page, "Remix");

    const chips = await getChipLabels(page, 5);
    expect(chips).toContain("FRONTEND");
    expect(chips).toContain("6M");
    expect(chips).toContain("REMOTE");
    expect(chips).toContain("SALARY DISCLOSED");
    expect(chips).toContain("INDIA");

    // Find the request for the active window (months=6)
    const reqUrl = new URL(findReq({ role: "frontend", months: 6, remote: "remote", disclosed: "1", country: "in" }));
    expect(reqUrl.searchParams.get("role")).toBe("frontend");
    expect(reqUrl.searchParams.get("months")).toBe("6");
    expect(reqUrl.searchParams.get("remote")).toBe("remote");
    expect(reqUrl.searchParams.get("disclosed")).toBe("1");
    expect(reqUrl.searchParams.get("country")).toBe("in");

    await expect(pill(page, "Frontend")).toHaveAttribute("aria-pressed", "true");
    await expect(pill(page, "Salary Disclosed")).toHaveAttribute("aria-pressed", "true");

    // Country dropdown should restore to the deep-linked value.
    await expect(page.locator("select[aria-label='Filter by country']")).toHaveValue("in");
  });

  // ─── 6. Malformed country deep-link → ignored ──────────────────────────────
  test("6: malformed country in deep-link is ignored", async ({ page }) => {
    await setupMocks(page);

    await page.goto(`${DEMAND}?role=frontend&country=zzzz`);
    await waitForSkill(page, "Next.js");

    // Only role chip, no country chip.
    const chips = await getChipLabels(page, 1);
    expect(chips).toContain("FRONTEND");

    // Country dropdown should be unset.
    await expect(page.locator("select[aria-label='Filter by country']")).toHaveValue("");
  });

  // ─── 7. Select salary band → URL + chip + filtered ─────────────────────────
  test("7: select salary band → URL, chip, and filtered content", async ({ page }) => {
    const { findReq } = await setupMocks(page);
    await page.goto(DEMAND);
    await waitForSkill(page, "React");

    // Select the ₹10–25L band from the salary dropdown.
    await page.locator("select[aria-label='Filter by salary band']").selectOption("10to25");
    await waitForSkill(page, "Node.js");

    // URL should contain salary=10to25.
    const url = new URL(page.url());
    expect(url.searchParams.get("salary")).toBe("10to25");

    // Chip for the salary band should appear.
    const chips = await getChipLabels(page, 1);
    expect(chips).toContain("₹10–25L");

    // API request should include salary=10to25.
    const reqUrl = new URL(findReq({ salary: "10to25" }));
    expect(reqUrl.searchParams.get("salary")).toBe("10to25");
  });

  // ─── 8. Clear-all resets salary dropdown ────────────────────────────────────
  // "Clear all" only renders when ≥ 2 chips are active, so we deep-link with
  // role + salary. The combined fixture (frontend_salary_10to25 → "Gatsby") is
  // distinct from the role-only fixture (frontend → "Next.js"), so if the app
  // ever stops forwarding salary when another facet is active the waitForSkill
  // assertion will fail immediately.
  test("8: clear-all resets the salary dropdown", async ({ page }) => {
    const { findReq } = await setupMocks(page);
    await page.goto(`${DEMAND}?role=frontend&salary=10to25`);
    await waitForSkill(page, "Gatsby"); // unique to the combined fixture

    // Verify the initial request carried BOTH params.
    const initialReq = new URL(findReq({ role: "frontend", salary: "10to25" }));
    expect(initialReq.searchParams.get("role")).toBe("frontend");
    expect(initialReq.searchParams.get("salary")).toBe("10to25");

    // Two chips visible → Clear all button appears.
    await page.getByText("Clear all").click();
    await waitForSkill(page, "React");

    // URL should not have salary param.
    const url = new URL(page.url());
    expect(url.searchParams.has("salary")).toBe(false);
    expect(url.searchParams.has("role")).toBe(false);

    // No chips.
    const chips = await getChipLabels(page, 0);
    expect(chips.length).toBe(0);

    // Salary dropdown should reset to default (empty).
    await expect(page.locator("select[aria-label='Filter by salary band']")).toHaveValue("");
  });

  // ─── 9. Deep-link ?salary=10to25 restores dropdown + chip ──────────────────
  test("9: deep-link with salary restores dropdown + chip", async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${DEMAND}?salary=10to25`);
    await waitForSkill(page, "Node.js");

    // Chip present.
    const chips = await getChipLabels(page, 1);
    expect(chips).toContain("₹10–25L");

    // Salary dropdown restored to the deep-linked value.
    await expect(page.locator("select[aria-label='Filter by salary band']")).toHaveValue("10to25");
  });

  test("10: error recovery keeps active filters on retry", async ({ page }) => {
    await setupMocks(page);
    let shouldFail = true;
    const trendingRequests = [];
    
    // We override the default trending mock for just this test
    await page.route("**/api/skills/trending*", async (route) => {
      trendingRequests.push(route.request().url());
      if (shouldFail) {
        // Fail the requests until the Try Again button is clicked
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false }) });
      } else {
        // Succeed on retry
        const body = fixtureForParams(route.request().url());
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      }
    });

    await page.route("**/api/skills/all*", async (route) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, skills: [] }),
      });
    });

    page.on('console', msg => console.log('TEST LOG:', msg.text()));
    page.on('request', req => console.log('REQ:', req.method(), req.url()));
    page.on('response', res => console.log('RES:', res.status(), res.url()));
    await page.goto("/?role=frontend&w=6");
    
    // Should see error state and Try again button
    const retryBtn = page.getByRole("button", { name: /try again/i });
    await expect(retryBtn).toBeVisible({ timeout: 10000 });

    // Now allow it to succeed and click retry
    shouldFail = false;
    trendingRequests.length = 0; // clear to capture only the retry requests
    await retryBtn.click();
    
    // Should recover and show data, ensuring the 2nd request had role=frontend and months=6
    await expect(page.getByText("Vue").first()).toBeVisible({ timeout: 10000 });
    
    expect(
      trendingRequests.some(
        (url) => url.includes("role=frontend") && url.includes("months=6")
      )
    ).toBeTruthy();  });
});
