import { test, expect } from "@playwright/test";

/**
 * Dark mode (wt2). Skips until the theme toggle ships
 * (data-testid="theme-toggle").
 */
test.describe("dark mode", () => {
  test("theme toggle flips the dark class on <html>", async ({ page }) => {
    await page.goto("/");

    const toggle = page.locator("[data-testid='theme-toggle']");
    test.skip(
      (await toggle.count()) === 0,
      "dark mode not shipped yet (no [data-testid=theme-toggle])",
    );

    const htmlClass = async () => (await page.locator("html").getAttribute("class")) ?? "";
    const before = await htmlClass();

    await toggle.click();
    await expect
      .poll(htmlClass, {
        message: "theme toggle did not change the <html> class",
        timeout: 5_000,
      })
      .not.toBe(before);

    // Cycling the toggle should reach a dark state at some point.
    let sawDark = (await htmlClass()).includes("dark");
    for (let i = 0; i < 3 && !sawDark; i++) {
      await toggle.click();
      sawDark = (await htmlClass()).includes("dark");
    }
    expect(sawDark, "never reached a 'dark' html class").toBeTruthy();
  });
});
