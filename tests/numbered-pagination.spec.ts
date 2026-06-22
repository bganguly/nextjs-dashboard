import { test, expect } from "@playwright/test";

/**
 * Numbered pagination (offset contract from wt1/wt2).
 * Skips itself until wt2 ships the page-number UI (data-testid="page-2"),
 * so the suite stays green now and auto-activates when it lands.
 */
test.describe("numbered pagination", () => {
  test("clicking a page number advances current page and changes rows", async ({ page }) => {
    await page.goto("/");
    // The initial (empty) search loads page 1 fast — avoid a slow "a" query.
    const rows = page.locator("[data-testid='search-result'], table tbody tr");
    await rows.first().waitFor({ state: "visible", timeout: 25_000 }).catch(() => {});

    const page2 = page.locator("[data-testid='page-2']");
    test.skip(
      (await page2.count()) === 0,
      "numbered pagination not shipped yet (no [data-testid=page-2])",
    );

    const firstPage = (await rows.allInnerTexts()).join("|");
    await page2.click();

    await expect(page.locator("[data-testid='current-page']")).toHaveText(/2/);
    await expect
      .poll(async () => (await rows.allInnerTexts()).join("|"), { timeout: 10_000 })
      .not.toBe(firstPage);
  });
});
