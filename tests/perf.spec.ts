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

  test("dense keyword search paginates under budget", async ({ request }) => {
    const first = await request.get("/api/orders?q=frank&page=1&pageSize=20", {
      timeout: BUDGET_MS + 5_000,
    });
    expect(first.ok(), `frank page 1 returned HTTP ${first.status()}`).toBeTruthy();
    const firstBody = await first.json();
    const firstId = firstBody.data?.[0]?.id;
    expect(firstId, "frank page 1 returned no first row").toBeTruthy();

    const t0 = Date.now();
    const second = await request.get("/api/orders?q=frank&page=2&pageSize=20", {
      timeout: BUDGET_MS + 5_000,
    });
    expect(second.ok(), `frank page 2 returned HTTP ${second.status()}`).toBeTruthy();
    const ms = Date.now() - t0;
    expect(
      ms,
      `frank page 2 took ${ms}ms (budget ${BUDGET_MS}ms)`,
    ).toBeLessThan(BUDGET_MS);

    const secondBody = await second.json();
    expect(
      secondBody.data?.[0]?.id,
      "frank page 2 should advance to a different first row",
    ).not.toBe(firstId);
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
