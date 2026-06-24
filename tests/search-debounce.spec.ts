import { test, expect, type Page } from "@playwright/test";

/**
 * Tests that the search input filters the list and aggregates when Enter is pressed.
 *
 * Run against port 3003:
 *   BASE_URL=http://localhost:3003 npx playwright test search-debounce
 */

const FETCH_TIMEOUT = 8_000;

/**
 * Navigate to the dashboard and wait for the initial order list to appear.
 * Retries once with a reload if the data fetch doesn't resolve in 12 s — guards
 * against the SSE reconnect loop (Task 12) continuously bumping refreshSignal and
 * interrupting the first fetch before data arrives.
 */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("load");
  const loaded = await page
    .locator("[data-testid='search-result']")
    .first()
    .isVisible({ timeout: 12_000 })
    .catch(() => false);
  if (!loaded) {
    await page.waitForTimeout(2_000);
    await page.reload();
    await page.waitForLoadState("load");
  }
}

test.describe("Search (Enter key)", () => {
  test("pressing Enter filters the list", async ({ page }) => {
    await loadDashboard(page);

    const resultsLocator = page.locator("[data-testid='search-result']");
    await expect(resultsLocator.first(), "No search results on load — page not populated").toBeVisible({ timeout: 8_000 });
    const countBefore = await resultsLocator.count();
    expect(countBefore, "No results before typing — page may not have loaded data").toBeGreaterThan(0);

    const input = page.locator("[data-testid='search-input']").first();
    await expect(input, "search input not found — add data-testid='search-input'").toBeVisible();

    await input.click();
    await input.fill("fra");
    await input.press("Enter");

    await expect(async () => {
      const countAfter = await resultsLocator.count();
      expect(
        countAfter,
        `List count unchanged (${countBefore} → ${countAfter}) after pressing Enter with "fra" — ` +
        "search handler not wired to Enter key",
      ).not.toBe(countBefore);
      expect(
        countAfter,
        `Search returned 0 rows for "fra" — backend may not support partial/case-insensitive match (ILIKE '%fra%')`,
      ).toBeGreaterThan(0);
    }).toPass({ timeout: FETCH_TIMEOUT });

    await expect(input).toHaveValue("fra");
  });

  test("search query is reflected in aggregate totals on Enter", async ({ page }) => {
    await loadDashboard(page);

    const resultsLocator = page.locator("[data-testid='search-result']");
    await expect(resultsLocator.first(), "search results not visible — page not loaded").toBeVisible({ timeout: 8_000 });

    const anyTile = page.locator("[data-testid='aggregate-tile']").first();
    await expect(anyTile, "aggregate-tile testid missing — add data-testid='aggregate-tile' to each tile (wt2 Task 14)").toBeVisible({ timeout: 8_000 });
    const unfiltered = await anyTile.textContent({ timeout: 5_000 });

    const input = page.locator("[data-testid='search-input']").first();
    await expect(input).toBeVisible();
    await input.click();
    await input.fill("fra");
    await input.press("Enter");

    await expect(async () => {
      const filtered = await anyTile.textContent({ timeout: 1_000 });
      expect(
        filtered,
        `Aggregate tile text unchanged after pressing Enter with "fra" — ` +
        `unfiltered: "${unfiltered}", filtered: "${filtered}". ` +
        "Totals must recompute alongside the list (wt2 Task 14).",
      ).not.toBe(unfiltered);
    }).toPass({ timeout: FETCH_TIMEOUT });
  });

  test("clearing the search and pressing Enter restores the full list", async ({ page }) => {
    await loadDashboard(page);

    const resultsLocator = page.locator("[data-testid='search-result']");
    const firstRow = resultsLocator.first();
    await expect(firstRow, "search-result testid missing — add data-testid='search-result' to each row").toBeVisible({ timeout: 8_000 });
    const fullListFirstId = await firstRow.getAttribute("data-order-id");
    expect(fullListFirstId, "data-order-id missing on row — add data-order-id={order.id} to each row").not.toBeNull();
    const countFull = await resultsLocator.count();

    const input = page.locator("[data-testid='search-input']").first();
    await input.click();
    await input.fill("fra");
    await input.press("Enter");

    // Step 1: list MUST filter after Enter (guards against vacuous pass on clear)
    await expect(async () => {
      const countFiltered = await resultsLocator.count();
      expect(
        countFiltered,
        `List did not filter after pressing Enter with "fra" — search not firing on Enter`,
      ).not.toBe(countFull);
      expect(
        countFiltered,
        `Search returned 0 rows for "fra" — backend may not support partial/case-insensitive match`,
      ).toBeGreaterThan(0);
    }).toPass({ timeout: FETCH_TIMEOUT });

    // Step 2: clear the input and press Enter — full list must return
    await input.selectText();
    await input.press("Backspace");
    await input.press("Enter");

    await expect(async () => {
      const countRestored = await resultsLocator.count();
      expect(
        countRestored,
        `Clearing search and pressing Enter did not restore the full list — count stuck at ${countRestored} (was ${countFull})`,
      ).toBe(countFull);
    }).toPass({ timeout: FETCH_TIMEOUT });

    const restoredFirstId = await firstRow.getAttribute("data-order-id");
    expect(
      restoredFirstId,
      `First row changed after clear — "${fullListFirstId}" → "${restoredFirstId}"`,
    ).toBe(fullListFirstId);
  });
});
