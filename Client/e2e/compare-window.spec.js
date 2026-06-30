// @ts-check
import { test, expect } from "@playwright/test";

// ── Shared mock setup ────────────────────────────────────────────────────────
// Registers all API mocks needed by ComparePage.
// Returns allRequests — an array of all ?months= values seen by /api/skills/all.

async function setupCompareMocks(page) {
  const allRequests = [];

  await page.route("**/api/skills/all*", async (route) => {
    const url = new URL(route.request().url());
    allRequests.push(Number(url.searchParams.get("months") || "12"));
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        skills: [{ skill: "react", demand: 800 }, { skill: "typescript", demand: 600 }],
      }),
    });
  });

  await page.route("**/api/places/countries*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, countries: [] }) });
  });

  await page.route("**/api/watchlist*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, skills: [] }) });
  });

  await page.route("**/api/skill/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, demand: 0, share: 0, remoteShare: 0, trend: [] }) });
  });

  await page.route("**/api/salary*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.route("**/api/skills/trending*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
  });

  return { allRequests };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("ComparePage -- URL-driven window", () => {
  test("deep-link /compare?w=6 fetches skill list with months=6", async ({ page }) => {
    const { allRequests } = await setupCompareMocks(page);

    // Register the waitForResponse BEFORE navigation so we never miss the request.
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/skills/all"),
      { timeout: 15000 },
    );

    await page.goto("/compare?w=6");
    await responsePromise;

    // The initial fetch must have used months=6, not 12.
    expect(allRequests[0]).toBe(6);

    // URL is preserved.
    await expect(page).toHaveURL(/[?&]w=6/);
  });

  test("clicking 3M button updates URL and refetches with months=3", async ({ page }) => {
    const { allRequests } = await setupCompareMocks(page);

    // Select 2 skills so the window toggle renders (canCompare requires >=2).
    const firstLoadPromise = page.waitForResponse(
      (r) => r.url().includes("/api/skills/all"),
      { timeout: 15000 },
    );
    await page.goto("/compare?skills=react,typescript");
    await firstLoadPromise;

    // The window toggle (3M/6M/12M) should now be visible.
    const btn3 = page.getByRole("button", { name: "Last 3 months" });
    await btn3.waitFor({ timeout: 8000 });

    // Set up the next response promise before clicking.
    const refetchPromise = page.waitForResponse(
      (r) => r.url().includes("/api/skills/all") && r.url().includes("months=3"),
      { timeout: 10000 },
    );

    await btn3.click();

    // URL should now contain w=3.
    await expect(page).toHaveURL(/[?&]w=3/);

    // The refetch with months=3 should have fired.
    await refetchPromise;
    expect(allRequests).toContain(3);
  });
});
