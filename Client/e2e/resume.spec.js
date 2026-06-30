// @ts-check
import { test, expect } from "@playwright/test";

test.describe("ResumePage", () => {
  test("renders without crashing", async ({ page }) => {
    // Mock trending for App.jsx
    await page.route("**/api/skills/trending*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, totalJobs: 0, skills: [] }) });
    });

    await page.goto("/resume");

    // Expect the dropzone to be visible
    await expect(page.getByText("Upload your resume")).toBeVisible({ timeout: 10000 });
  });
});
