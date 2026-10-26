import { test, expect } from "@playwright/test";
import { mockTauri, invokeCalls } from "./tauri-mock";

const sections = ["General", "Models", "Advanced", "History", "About"];

test.describe("Settings UI (mocked Tauri backend)", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauri(page);
  });

  test("main window renders and loads settings from the backend", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    for (const section of sections) {
      await expect(
        page.getByText(section, { exact: true }).first(),
      ).toBeVisible();
    }

    const calls = await invokeCalls(page);
    expect(calls.map((c) => c.cmd)).toContain("get_app_settings");
    expect(errors).toEqual([]);
  });

  test("every sidebar section renders without crashing", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    for (const section of sections) {
      await page.getByText(section, { exact: true }).first().click();
      await expect(page.locator("#root")).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
  });
});
