/**
 * Audits dashboard slice consistency through the combined endpoint.
 *
 * Flags cases where the list has matches but the chart is empty, the endpoint
 * errors, or the response exceeds SLOW_MS. Use this after changing read models:
 *   DASHBOARD_URL=http://localhost:3003 npx tsx scripts/audit-dashboard-slices.ts
 */

const baseUrl = process.env.DASHBOARD_URL ?? "http://localhost:3003";
const slowMs = Number(process.env.SLOW_MS ?? 1000);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 60_000);

const searches = ["", "ito", "diaz", "frank", "997"];
const cases: Record<string, string>[] = [
  {},
  { status: "SHIPPED" },
  { status: "REFUNDED" },
  { status: "DELIVERED" },
  { regionCode: "R3" },
  { status: "SHIPPED", regionCode: "R3" },
  { minTotal: "100", maxTotal: "250" },
  { status: "SHIPPED", minTotal: "100", maxTotal: "250" },
];

interface DashboardResponse {
  orders?: { data?: unknown[]; total?: number };
  aggregates?: unknown[];
}

function labelFor(q: string, filters: Record<string, string>): string {
  const parts = Object.entries(filters).map(([k, v]) => `${k}=${v}`);
  return [`q=${q || "<empty>"}`, parts.join(" ") || "no filters"].join(" ");
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function auditOne(q: string, filters: Record<string, string>) {
  const params = new URLSearchParams({
    q,
    page: "1",
    pageSize: "3",
    topCategories: "4",
    from: "2026-05-24",
    to: "2026-06-23",
  });
  for (const [k, v] of Object.entries(filters)) params.set(k, v);

  const label = labelFor(q, filters);
  const started = performance.now();
  const res = await fetchWithTimeout(`${baseUrl}/api/dashboard-search?${params}`);
  const ms = Math.round(performance.now() - started);
  const text = await res.text();

  if (!res.ok) {
    return { ok: false, label, ms, reason: `HTTP ${res.status}: ${text.slice(0, 120)}` };
  }

  let data: DashboardResponse;
  try {
    data = JSON.parse(text) as DashboardResponse;
  } catch {
    return { ok: false, label, ms, reason: `invalid JSON: ${text.slice(0, 120)}` };
  }

  const rows = data.orders?.data?.length ?? 0;
  const total = data.orders?.total ?? 0;
  const aggregateDays = Array.isArray(data.aggregates) ? data.aggregates.length : -1;
  const emptyChartMismatch = total > 0 && aggregateDays === 0;
  const slow = ms > slowMs;

  return {
    ok: !emptyChartMismatch && !slow,
    label,
    ms,
    rows,
    total,
    aggregateDays,
    reason: emptyChartMismatch ? "list has matches but chart is empty" : slow ? "slow" : "",
  };
}

async function main() {
  const failures: Awaited<ReturnType<typeof auditOne>>[] = [];
  for (const q of searches) {
    for (const filters of cases) {
      const result = await auditOne(q, filters);
      const prefix = result.ok ? "OK " : "BAD";
      console.log(
        `${prefix} ${String(result.ms).padStart(5)}ms ${result.label}` +
          ("rows" in result
            ? ` rows=${result.rows} total=${result.total} agg=${result.aggregateDays}`
            : "") +
          (result.reason ? ` ${result.reason}` : ""),
      );
      if (!result.ok) failures.push(result);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} dashboard slice issue(s) found.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
