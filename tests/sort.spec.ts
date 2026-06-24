import { test, expect } from "@playwright/test";

/**
 * Server-side sort (wt1/wt2). Skips until wt2 ships sortable headers
 * (data-testid="sort-total").
 */
test.describe("server-side sort", () => {
  test("clicking a sort header reorders the results", async ({ page }) => {
    await page.goto("/");
    // The initial (empty) search loads page 1 fast — avoid a slow "a" query.
    const rows = page.locator("[data-testid='search-result'], table tbody tr");
    await rows.first().waitFor({ state: "visible", timeout: 25_000 }).catch(() => {});

    const sortHeader = page.locator("[data-testid='sort-total']");
    test.skip(
      (await sortHeader.count()) === 0,
      "sortable headers not shipped yet (no [data-testid=sort-total])",
    );

    const before = (await rows.allInnerTexts()).join("|");
    await sortHeader.click();
    await expect
      .poll(async () => (await rows.allInnerTexts()).join("|"), { timeout: 10_000 })
      .not.toBe(before);
  });
});
