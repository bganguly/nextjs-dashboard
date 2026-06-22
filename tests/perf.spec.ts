import { test, expect } from "@playwright/test";

/**
 * Scale/perf guards against the 4M dataset. Locks in the cursor-hang finding:
 * search must stay fast, and deep pagination must not blow up once offset
 * pagination is live.
 */
const BUDGET_MS = 8_000;

test.describe("performance @ 4M rows", () => {
  test("search API responds under budget", async ({ request }) => {
    const t0 = Date.now();
    const res = await request.get("/api/orders?q=a&pageSize=20&limit=20", {
      timeout: BUDGET_MS + 5_000,
    });
    expect(res.ok(), `search returned HTTP ${res.status()}`).toBeTruthy();
    const ms = Date.now() - t0;
    expect(ms, `search took ${ms}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
  });

  test("deep pagination responds under budget (once offset pagination is live)", async ({
    request,
  }) => {
    const probe = await request.get("/api/orders?page=2&pageSize=20");
    const body = await probe.json().catch(() => ({}));
    test.skip(
      !("totalPages" in body || "page" in body),
      "offset pagination not shipped yet (response has no page/totalPages)",
    );

    // No `q`: this isolates DEEP OFFSET performance (page 500). Text-search
    // slowness is owned by the separate "search API responds under budget" test,
    // so we don't conflate the two.
    const t0 = Date.now();
    const res = await request.get(
      "/api/orders?page=500&pageSize=20&sort=placedAt&dir=desc",
      { timeout: BUDGET_MS + 5_000 },
    );
    expect(res.ok(), `deep page returned HTTP ${res.status()}`).toBeTruthy();
    const ms = Date.now() - t0;
    expect(ms, `deep page 500 (no filter) took ${ms}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
  });
});
