// @ts-check
import { test, expect } from "@playwright/test";

test.describe("RelocatePage", () => {
  test("renders without crashing and exercises interaction", async ({ page }) => {
    // Mock the suggest API for the combobox
    await page.route("**/api/places/suggest*", async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get("q") || "";
      if (q.toLowerCase().startsWith("lon")) {
        await route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ ok: true, suggestions: [{ token: "london,gb", label: "London, GB", country: "gb" }] })
        });
      } else if (q.toLowerCase().startsWith("ber")) {
        await route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ ok: true, suggestions: [{ token: "berlin,de", label: "Berlin, DE", country: "de" }] })
        });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, suggestions: [] }) });
      }
    });

    // Mock the relocation API
    await page.route("**/api/relocation*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          from: { displayName: "London, GB" },
          to: { displayName: "Berlin, DE", currency: "EUR" },
          currency: "USD",
          nominalUSD: 100000,
          fromBaseLevel: 100,
          fromMultiplier: 1,
          fromPriceLevel: 100,
          toBaseLevel: 80,
          toMultiplier: 1,
          toPriceLevel: 80,
          realValueCurrent: 100000,
          equivalentInTarget: 80000,
          confidence: "High"
        }),
      });
    });

    // Mock trending for App.jsx
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
    });

    await page.goto("/relocate");

    // Type in From box
    await page.getByPlaceholder("Bangalore (or IN)").fill("Lon");
    // The dropdown should appear and we should be able to click London
    await page.getByText("London, GB").click();

    // Type in To box
    await page.getByPlaceholder("San Francisco (or US)").fill("Ber");
    await page.getByText("Berlin, DE").click();

    // Fill current salary
    await page.getByLabel("Current Salary").fill("100000");

    // Submit
    await page.getByRole("button", { name: "Calculate" }).click();

    // Assert results exist
    await expect(page.getByText("Berlin").first()).toBeVisible({ timeout: 10000 });
  });
});
