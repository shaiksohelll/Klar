// @ts-check
import { test, expect } from "@playwright/test";

test.describe("AboutPage", () => {
  test("renders without crashing", async ({ page }) => {
    // Mock trending for App.jsx
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
    });

    await page.goto("/about");

    // Expect some about content
    await expect(page.getByText("reads the market")).toBeVisible({ timeout: 10000 });
  });
});
