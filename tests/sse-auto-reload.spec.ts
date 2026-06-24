import { test, expect } from "@playwright/test";

/**
 * End-to-end test: submitting a Quick Order should auto-reload the dashboard
 * list within 10 seconds via SSE (pg_notify → EventSource → refreshSignal).
 *
 * Run against port 3003:
 *   BASE_URL=http://localhost:3003 npx playwright test sse-auto-reload
 */

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3004";
const TIMEOUT = 12_000;

async function postOrder(): Promise<number> {
  const res = await fetch(`${BACKEND}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerId: 12115,
      regionId: 1,
      currency: "USD",
      notes: `sse-test-${Date.now()}`,
      items: [{ productId: 88, quantity: 1, unitPrice: 7.77, discount: 0 }],
    }),
  });
  if (!res.ok) throw new Error(`POST /api/orders → ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { id: number };
  return json.id;
}

test.describe("SSE auto-reload", () => {
  test("new order appears in list without manual refresh", async ({ page }) => {
    // 1. Load dashboard — capture SSE connection status
    await page.goto("/");
    // "networkidle" never fires when an SSE connection is open (always in-flight); use "load" instead
    await page.waitForLoadState("load");

    // Check SSE status via Live Feed dot — "Live" means green/connected
    const liveDot = page.locator("text=Live").first();
    const isLive = await liveDot.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!isLive) {
      // Capture what the stream actually returns for diagnosis
      const streamRes = await fetch(`${BACKEND}/api/stream`, { signal: AbortSignal.timeout(3000) })
        .then(async (r) => ({ status: r.status, body: await r.text() }))
        .catch((e: Error) => ({ status: 0, body: e.message }));
      throw new Error(
        `SSE stream is not connected (Live Feed shows "${await page.locator("text=Live, text=Connecting, text=Reconnecting, text=Offline").first().textContent().catch(() => "unknown")}").\n` +
        `Direct stream check: HTTP ${streamRes.status}\n${streamRes.body}\n\n` +
        `Fix: restart wt-backend (Ctrl+C → npm run dev) after ensuring DIRECT_DATABASE_URL is set in wt-backend/.env`,
      );
    }

    // 2. Record the current first order ID in the list
    const firstRow = page.locator("[data-testid='search-result']").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    const firstIdBefore = await firstRow.getAttribute("data-order-id")
      ?? await firstRow.locator("td").first().textContent();
    expect(firstIdBefore).toBeTruthy();

    // 3. POST a new order directly to the backend (bypassing the Quick Order UI)
    const newId = await postOrder();
    console.log(`Created order #${newId}`);

    // 4. Wait for the new order to appear in the list WITHOUT any manual refresh
    //    The list should auto-reload via SSE → refreshSignal within ~2s
    await expect(
      page.locator(`text=${newId}`).first(),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("SSE stream delivers event: order after POST", async ({ page }) => {
    // Open dashboard so the EventSource is established
    await page.goto("/");
    await page.waitForLoadState("load");

    // 1. Wait to receive an `order` named event from the SSE stream
    const orderEventReceived = page.evaluate(
      ({ path, timeoutMs }) =>
        new Promise<{ received: boolean; firstEvent: string }>((resolve) => {
          const es = new EventSource(path);
          let firstEvent = "";

          es.addEventListener("order", (e) => {
            firstEvent = (e as MessageEvent).data;
            es.close();
            resolve({ received: true, firstEvent });
          });

          es.addEventListener("error", (e) => {
            const data = (e as MessageEvent).data ?? "";
            firstEvent = `error: ${data}`;
          });

          setTimeout(() => {
            es.close();
            resolve({ received: false, firstEvent });
          }, timeoutMs);
        }),
      { path: "/api/stream", timeoutMs: TIMEOUT },
    );

    // 2. POST the order after the listener is ready (small delay to ensure it's up)
    await page.waitForTimeout(500);
    const newId = await postOrder();
    console.log(`Created order #${newId} — waiting for SSE delivery`);

    const result = await orderEventReceived;

    expect(
      result.received,
      `No 'event: order' received within ${TIMEOUT}ms.\nFirst event seen: ${result.firstEvent}\n` +
      `This means the NOTIFY→SSE chain is broken. Check:\n` +
      `  1. wt-backend restarted after ssl fix? (curl http://localhost:3004/api/stream)\n` +
      `  2. DIRECT_DATABASE_URL set in wt-backend/.env?\n` +
      `  3. createOrder calls publishOrderEvent? (grep publishOrderEvent wt-backend/lib/services/orders.service.ts)`,
    ).toBe(true);
  });
});
