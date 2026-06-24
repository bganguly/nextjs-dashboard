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
    await expect(rows.first()).not.toHaveAttribute("data-new", "true", {
      timeout: 1_000,
    });
    const sawPageChangeAnimation = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const firstRowIsAnimating = () =>
            document
              .querySelector("[data-testid='search-result']")
              ?.getAttribute("data-new") === "true";
          let sawAnimation = firstRowIsAnimating();
          const observer = new MutationObserver(() => {
            if (firstRowIsAnimating()) sawAnimation = true;
          });
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ["data-new"],
            childList: true,
            subtree: true,
          });
          setTimeout(() => {
            observer.disconnect();
            resolve(sawAnimation);
          }, 1_200);
        }),
    );

    await page2.click();

    await expect(page.locator("[data-testid='current-page']")).toHaveText(/2/);
    await expect
      .poll(async () => (await rows.allInnerTexts()).join("|"), { timeout: 10_000 })
      .not.toBe(firstPage);
    expect(
      await sawPageChangeAnimation,
      "Pagination should not mark the first row data-new; that animation is only for quick-add/SSE inserts",
    ).toBe(false);
  });
});
