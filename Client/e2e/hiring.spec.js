// @ts-check
import { test, expect } from "@playwright/test";

test.describe("HiringPage", () => {
  test("renders without crashing and exercises interaction", async ({ page }) => {
    // Mock the companies API
    await page.route("**/api/companies*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          companies: [
            { company: "TechCorp", openings: 100, remote: 50, topSkills: ["React", "Node"] }
          ],
        }),
      });
    });

    // Mock trending for App.jsx
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
    });

    await page.goto("/hiring");

    // Should see TechCorp
    await expect(page.getByText("TechCorp")).toBeVisible({ timeout: 10000 });
  });
});
