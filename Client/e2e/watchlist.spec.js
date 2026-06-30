// @ts-check
import { test, expect } from "@playwright/test";

test.describe("WatchlistPage", () => {
  test("loads watchlist and passes correct window facet to SkillGap", async ({ page }) => {
    // Mock the watchlist API
    await page.route("**/api/watchlist*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, skills: ["react"] }),
      });
    });

    // Mock trending for App.jsx background fetch and Watchlist sorting
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          totalJobs: 1000,
          skills: [{ id: "react", skill: "react", count: 500, demand: 500, share: 50 }]
        }),
      });
    });

    const gapRequests = [];
    // Mock SkillGap API
    await page.route("**/api/skill-gap*", async (route) => {
      const url = new URL(route.request().url());
      gapRequests.push(Number(url.searchParams.get("months")));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, gaps: [], empty: true }),
      });
    });

    page.on('console', msg => console.log('TEST LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR', err.message));
    page.on('request', req => console.log('REQ:', req.method(), req.url()));
    page.on('response', res => console.log('RES:', res.status(), res.url()));
    
    // We deep link with ?w=6 (6 months)
    const responsePromise = page.waitForResponse((r) => r.url().includes("/api/skill-gap"), { timeout: 5000 });
    await page.goto("/watchlist?w=6");
    await responsePromise;

    // Assert that SkillGap requested the 6 month window
    expect(gapRequests).toContain(6);
  });
});
