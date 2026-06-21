import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke tests: the dashboard loads, the SSE stream connects, a chart renders,
 * and search returns results.
 *
 * The frontend/backend feature work is built in parallel worktrees, so these
 * specs target the intended contracts using data-testid selectors with
 * sensible fallbacks. Override defaults with env vars:
 *   BASE_URL   (default http://localhost:3000)  - set in playwright.config.ts
 *   SSE_PATH   (default /api/stream)             - the EventSource endpoint
 */
const SSE_PATH = process.env.SSE_PATH ?? "/api/stream";

/** First visible match among several candidate locators, or null. */
async function firstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

test.describe("smoke", () => {
  test("dashboard page loads", async ({ page }) => {
    const response = await page.goto("/");
    expect(response, "navigation should return a response").not.toBeNull();
    expect(response!.ok(), `GET / returned ${response!.status()}`).toBeTruthy();
    await expect(page.locator("body")).toBeVisible();
    // A real dashboard has more than the empty starter; assert some content.
    await expect(page.locator("main, [data-testid='dashboard']").first()).toBeVisible();
  });

  test("SSE stream connects", async ({ page }) => {
    // Two acceptance paths: an explicit connection indicator, or an actual
    // text/event-stream response observed on the network.
    const eventStream = page
      .waitForResponse(
        (res) =>
          (res.url().includes(SSE_PATH) ||
            (res.headers()["content-type"] ?? "").includes("text/event-stream")),
        { timeout: 15_000 },
      )
      .catch(() => null);

    await page.goto("/");

    const statusIndicator = await firstVisible(page, [
      "[data-testid='sse-status'][data-connected='true']",
      "[data-testid='sse-status']:has-text('connected')",
      "[data-testid='connection-status']:has-text('connected')",
    ]);

    if (statusIndicator) {
      await expect(statusIndicator).toBeVisible();
      return;
    }

    // Fall back to verifying the stream over the wire, including a direct
    // EventSource probe if the page itself didn't open one.
    let res = await eventStream;
    if (!res) {
      const opened = await page.evaluate(
        (path) =>
          new Promise<boolean>((resolve) => {
            try {
              const es = new EventSource(path);
              const done = (ok: boolean) => {
                es.close();
                resolve(ok);
              };
              es.onopen = () => done(true);
              es.onmessage = () => done(true);
              es.onerror = () => done(false);
              setTimeout(() => done(false), 8000);
            } catch {
              resolve(false);
            }
          }),
        SSE_PATH,
      );
      expect(opened, `EventSource(${SSE_PATH}) did not connect`).toBeTruthy();
      return;
    }
    expect(
      res.ok() || res.status() === 200,
      `SSE response status ${res.status()}`,
    ).toBeTruthy();
  });

  test("a chart renders", async ({ page }) => {
    await page.goto("/");
    const chart = await firstVisible(page, [
      "[data-testid='chart']",
      "[data-testid='chart'] svg",
      "[data-testid='chart'] canvas",
      "main svg",
      "main canvas",
      "[role='img']",
    ]);
    expect(chart, "no chart element (svg/canvas/[data-testid=chart]) found").not.toBeNull();
    await expect(chart!).toBeVisible();
  });

  test("search returns results", async ({ page }) => {
    await page.goto("/");
    const input = await firstVisible(page, [
      "[data-testid='search-input']",
      "input[type='search']",
      "input[placeholder*='search' i]",
      "[role='searchbox']",
    ]);
    expect(input, "no search input found").not.toBeNull();

    await input!.fill("a");
    await input!.press("Enter");

    const results = page
      .locator("[data-testid='search-results'] [data-testid='search-result'], [data-testid='search-results'] li, [data-testid='search-result']")
      .first();
    await expect(results, "search produced no results").toBeVisible({ timeout: 10_000 });
  });
});
