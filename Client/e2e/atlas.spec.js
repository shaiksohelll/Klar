// @ts-check
import { test, expect } from "@playwright/test";

test.describe("AtlasPage", () => {
  test("renders without crashing", async ({ page }) => {
    // Basic mock for countries API
    await page.route("**/api/places/countries*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, countries: ["US", "GB", "IN"] }),
      });
    });

    // Basic mock for map points
    await page.route("**/api/places/map*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, cities: [], totalJobs: 0, totalCities: 0 }),
      });
    });

    // Mock trending for App.jsx background fetch
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
    });

    await page.goto("/atlas");

    // Map container should render
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 10000 });
  });
});
