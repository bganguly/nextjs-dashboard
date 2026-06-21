import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Pagination: run a search, page forward, and assert the cursor advances
 * (cursor-based pagination over the search results / orders).
 *
 * The cursor may be surfaced as a data attribute on the "next" control, as a
 * URL query param (?cursor=...), or implicitly via changed result content.
 * All three are accepted as evidence the cursor moved.
 */

async function firstPresent(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

function resultsLocator(page: Page): Locator {
  return page.locator(
    "[data-testid='search-results'] [data-testid='search-result']," +
      " [data-testid='search-results'] li," +
      " [data-testid='result-row']," +
      " [data-testid='search-result']",
  );
}

/** Read the current cursor from the next-control or the URL, if present. */
async function readCursor(page: Page, nextBtn: Locator | null): Promise<string | null> {
  if (nextBtn && (await nextBtn.count()) > 0) {
    for (const attr of ["data-cursor", "data-next-cursor", "data-after"]) {
      const v = await nextBtn.getAttribute(attr);
      if (v) return v;
    }
  }
  const url = new URL(page.url());
  return url.searchParams.get("cursor") ?? url.searchParams.get("after");
}

/** A signature of the currently displayed results (ids if available, else text). */
async function resultsSignature(page: Page): Promise<string> {
  const rows = resultsLocator(page);
  const n = await rows.count();
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const id =
      (await row.getAttribute("data-id")) ??
      (await row.getAttribute("data-result-id")) ??
      (await row.innerText().catch(() => "")) ??
      "";
    parts.push(id.replace(/\s+/g, " ").trim());
  }
  return parts.join("||");
}

test.describe("pagination", () => {
  test("search results paginate and the cursor advances", async ({ page }) => {
    await page.goto("/");

    const input = await firstPresent(page, [
      "[data-testid='search-input']",
      "input[type='search']",
      "input[placeholder*='search' i]",
      "[role='searchbox']",
    ]);
    expect(input, "no search input found").not.toBeNull();

    await input!.fill("a");
    await input!.press("Enter");

    const rows = resultsLocator(page);
    await expect(rows.first(), "search produced no results").toBeVisible({
      timeout: 10_000,
    });

    const firstPageSig = await resultsSignature(page);

    const nextBtn = await firstPresent(page, [
      "[data-testid='next-page']",
      "[data-testid='pagination-next']",
      "button:has-text('Next')",
      "a:has-text('Next')",
      "[aria-label='Next page']",
    ]);
    expect(nextBtn, "no next-page control found").not.toBeNull();
    await expect(nextBtn!, "next-page control is disabled on first page").toBeEnabled();

    const cursorBefore = await readCursor(page, nextBtn);

    await nextBtn!.click();

    // Wait for the result set to change (new page loaded).
    await expect
      .poll(async () => resultsSignature(page), {
        message: "results did not change after paging forward",
        timeout: 10_000,
      })
      .not.toBe(firstPageSig);

    const cursorAfter = await readCursor(page, nextBtn);

    // The cursor must have advanced. If a cursor token is exposed it must
    // differ; otherwise the changed result signature (asserted above) is the
    // evidence the cursor moved.
    if (cursorBefore !== null || cursorAfter !== null) {
      expect(
        cursorAfter,
        `cursor did not advance (before=${cursorBefore}, after=${cursorAfter})`,
      ).not.toBe(cursorBefore);
      expect(cursorAfter, "cursor missing after paging").not.toBeNull();
    }
  });
});
