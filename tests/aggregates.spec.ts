import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Aggregates: dragging the date-range control re-queries the DailySummary
 * aggregates and the chart updates accordingly.
 *
 * Targets a date-range brush/slider with data-testid selectors and falls back
 * to dragging across the chart area itself (a typical brush interaction).
 */

async function firstPresent(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

/**
 * A stable signature of the chart's current data, so we can detect updates
 * without knowing the exact charting library. Prefers an explicit data hash
 * exposed by the app, then falls back to structural/textual signals.
 */
async function chartSignature(page: Page): Promise<string> {
  const chart = page.locator("[data-testid='chart']").first();
  if ((await chart.count()) > 0) {
    const dataAttr = await chart.getAttribute("data-signature");
    if (dataAttr) return `sig:${dataAttr}`;

    const bars = chart.locator("[data-testid='bar'], rect, .bar, path.line");
    const count = await bars.count();
    const text = (await chart.innerText().catch(() => "")) ?? "";
    return `bars:${count}|text:${text.replace(/\s+/g, " ").trim()}`;
  }
  // Fall back to a headline aggregate value if there is no chart container yet.
  const total = page.locator(
    "[data-testid='total-revenue'], [data-testid='total-orders'], [data-testid='aggregate-total']",
  );
  if ((await total.count()) > 0) return `total:${await total.first().innerText()}`;
  return "none";
}

async function dragRange(page: Page): Promise<boolean> {
  // Preferred: an explicit range handle we can move a known distance.
  const startHandle = await firstPresent(page, [
    "[data-testid='range-start']",
    "[data-testid='date-range-start']",
    "[data-testid='range-handle-left']",
  ]);
  if (startHandle) {
    const box = await startHandle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      return true;
    }
  }

  // Fall back: brush-drag across the chart / date-range container.
  const surface = await firstPresent(page, [
    "[data-testid='date-range']",
    "[data-testid='chart']",
  ]);
  if (surface) {
    const box = await surface.boundingBox();
    if (box) {
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * 0.2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, y, { steps: 15 });
      await page.mouse.up();
      return true;
    }
  }
  return false;
}

test.describe("aggregates", () => {
  test("from-only date filters use today as the end date", async ({ request }) => {
    const params = new URLSearchParams({
      q: "ito",
      from: "2026-06-22",
      pageSize: "1",
    });

    const [ordersRes, aggregatesRes] = await Promise.all([
      request.get(`/api/orders?${params.toString()}`),
      request.get(`/api/aggregates?${params.toString()}`),
    ]);

    expect(ordersRes.ok(), await ordersRes.text()).toBeTruthy();
    expect(aggregatesRes.ok(), await aggregatesRes.text()).toBeTruthy();

    const orders = await ordersRes.json();
    const aggregates = await aggregatesRes.json();
    const aggregateTotal = aggregates.data.reduce(
      (sum: number, day: { totals?: { totalOrders?: number } }) =>
        sum + (day.totals?.totalOrders ?? 0),
      0,
    );
    const allDaysReconcile = aggregates.data.every(
      (day: {
        categories: Record<string, { totalOrders?: number }>;
        totals?: { totalOrders?: number };
      }) => {
        const categoryTotal = Object.values(day.categories).reduce(
          (sum, category) => sum + (category.totalOrders ?? 0),
          0,
        );
        return categoryTotal === (day.totals?.totalOrders ?? 0);
      },
    );

    expect(orders.total).toBeGreaterThan(0);
    expect(aggregateTotal).toBe(orders.total);
    expect(allDaysReconcile).toBeTruthy();
  });

  test("from-only chart renders rolled-up other buckets", async ({ page, request }) => {
    const params = new URLSearchParams({
      q: "ito",
      from: "2026-06-22",
    });
    const aggregatesRes = await request.get(`/api/aggregates?${params.toString()}`);
    expect(aggregatesRes.ok(), await aggregatesRes.text()).toBeTruthy();
    const aggregates = await aggregatesRes.json();
    const daysWithOther = aggregates.data.filter(
      (day: { categories?: Record<string, unknown> }) =>
        Object.prototype.hasOwnProperty.call(day.categories ?? {}, "Others"),
    ).length;

    expect(daysWithOther).toBeGreaterThan(0);

    await page.goto("/");
    await page.getByTestId("search-input").fill("ito");
    await page.getByTestId("search-input").press("Enter");
    await page.locator("input[type='date']").first().fill("2026-06-22");

    await expect
      .poll(
        async () =>
          page.locator("[data-testid='chart-bar'][data-category='Others']").count(),
        {
          message: "rolled-up Others buckets did not render in the chart",
          timeout: 10_000,
        },
      )
      .toBeGreaterThanOrEqual(daysWithOther);
  });

  test("lowercase status filters match list and chart aggregates", async ({ request }) => {
    const params = new URLSearchParams({
      status: "shipped,refunded",
      regionCode: "R42",
      from: "2026-06-22",
      to: "2026-06-22",
      q: "ito",
      pageSize: "5",
    });

    const [ordersRes, aggregatesRes] = await Promise.all([
      request.get(`/api/orders?${params.toString()}`),
      request.get(`/api/aggregates?${params.toString()}`),
    ]);

    expect(ordersRes.ok(), await ordersRes.text()).toBeTruthy();
    expect(aggregatesRes.ok(), await aggregatesRes.text()).toBeTruthy();

    const orders = await ordersRes.json();
    const aggregates = await aggregatesRes.json();
    const aggregateTotal = aggregates.data.reduce(
      (sum: number, day: { totals?: { totalOrders?: number } }) =>
        sum + (day.totals?.totalOrders ?? 0),
      0,
    );

    expect(orders.total).toBeGreaterThan(0);
    expect(aggregateTotal).toBe(orders.total);
    expect(
      orders.data.every((row: { status: string; region?: { code?: string } }) =>
        ["SHIPPED", "REFUNDED"].includes(row.status) && row.region?.code === "R42",
      ),
    ).toBeTruthy();
  });

  test("dragging the date range updates the chart data", async ({ page }) => {
    await page.goto("/");

    // Ensure the chart is present before measuring.
    const chart = page.locator("[data-testid='chart'], main svg, main canvas").first();
    await expect(chart, "chart did not render").toBeVisible({ timeout: 15_000 });

    const before = await chartSignature(page);

    const dragged = await dragRange(page);
    expect(dragged, "could not find a date-range control or chart to drag").toBeTruthy();

    // The chart re-queries aggregates after the range changes; wait for the
    // signature to differ from the pre-drag state.
    await expect
      .poll(async () => chartSignature(page), {
        message: "chart data did not change after dragging the date range",
        timeout: 10_000,
      })
      .not.toBe(before);
  });
});
