import { query } from "@/lib/db";
import { AppError, mapDbError } from "@/lib/errors";
import { aggCacheGet, aggCacheSet } from "@/lib/aggregates-cache";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import {
  escapeLike,
  normalizeStatusList,
  resolveFilters,
  todayDateString,
  isPureDateRangeQuery,
  getOrderCount,
} from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Others";

interface AggRow {
  day: string;
  category: string;
  total_orders: string;
  total_items: string;
  total_revenue: string;
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  const query_in = {
    ...input,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  if (!query_in.from || !query_in.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const topN =
    query_in.topCategories != null && query_in.topCategories > 0
      ? Math.trunc(query_in.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const cacheKey = `data:${JSON.stringify(query_in)}`;
  const cached = aggCacheGet<DailyAggregate[]>(cacheKey);
  if (cached) return cached;

  try {
    const rows = await runAggQuery(query_in);
    const result = rowsToDailyAggregates(rows, topN);
    aggCacheSet(cacheKey, result);
    return result;
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

export async function getExactAggregateTotal(input: AggregateQueryInput): Promise<number> {
  const query_in = {
    ...input,
    to: input.to || (input.from ? todayDateString() : input.to),
  };

  const inProcKey = `total:${JSON.stringify(query_in)}`;
  const cachedTotal = aggCacheGet<number>(inProcKey);
  if (cachedTotal != null) return cachedTotal;

  try {
    const filters = await resolveFilters(query_in);
    const total = await getOrderCount(query_in.q ?? undefined, filters);
    aggCacheSet(inProcKey, total);
    return total;
  } catch (err) {
    mapDbError(err, "getExactAggregateTotal");
  }
}

async function runAggQuery(input: AggregateQueryInput): Promise<AggRow[]> {
  const params: unknown[] = [];
  let pi = 1;
  const clauses: string[] = [];

  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    clauses.push(`o.search_text ILIKE '%' || $${pi++} || '%'`);
    params.push(escapeLike(tok));
  }

  if (input.from) {
    clauses.push(`o.placed_at >= $${pi++}::timestamptz`);
    params.push(input.from);
  }
  if (input.to) {
    clauses.push(`o.placed_at <= $${pi++}::timestamptz`);
    params.push(input.to);
  }

  const statuses = normalizeStatusList(input.status);
  if (statuses.length) {
    clauses.push(`o.status = ANY($${pi++}::text[])`);
    params.push(statuses);
  }

  const regionCodes = parseCsv(input.regionCode);
  if (regionCodes.length) {
    clauses.push(`o.region_code = ANY($${pi++}::text[])`);
    params.push(regionCodes);
  }

  if (input.minTotal != null) {
    clauses.push(`o.total >= $${pi++}`);
    params.push(input.minTotal);
  }
  if (input.maxTotal != null) {
    clauses.push(`o.total <= $${pi++}`);
    params.push(input.maxTotal);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return query<AggRow>(
    `SELECT
       DATE(o.placed_at)::text                                     AS day,
       oi.category_name                                            AS category,
       count(DISTINCT o.order_id)::text                            AS total_orders,
       sum(oi.unit_price * oi.quantity * (1 - oi.discount))::text AS total_revenue,
       sum(oi.quantity)::text                                      AS total_items
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.order_id
     ${where}
     GROUP BY DATE(o.placed_at), oi.category_name
     ORDER BY day ASC, category ASC`,
    params,
  );
}

function rowsToDailyAggregates(rows: AggRow[], topN: number): DailyAggregate[] {
  const byDate = new Map<string, DailyAggregate>();
  for (const r of rows) {
    let entry = byDate.get(r.day);
    if (!entry) {
      entry = { date: r.day, categories: {}, totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 } };
      byDate.set(r.day, entry);
    }
    const totalOrders = Number(r.total_orders);
    const totalRevenue = Number(r.total_revenue ?? 0);
    const totalItems = Number(r.total_items);
    const existing = entry.categories[r.category];
    const cat: CategoryAggregate = existing
      ? { totalOrders: existing.totalOrders + totalOrders, totalRevenue: existing.totalRevenue + totalRevenue, totalItems: existing.totalItems + totalItems, avgOrderValue: 0 }
      : { totalOrders, totalRevenue, totalItems, avgOrderValue: 0 };
    cat.avgOrderValue = cat.totalOrders > 0 ? cat.totalRevenue / cat.totalOrders : 0;
    entry.categories[r.category] = cat;
    entry.totals.totalOrders += totalOrders;
    entry.totals.totalRevenue += totalRevenue;
    entry.totals.totalItems += totalItems;
  }
  return Array.from(byDate.values()).map((day) => capToTopCategories(day, topN));
}

function capToTopCategories(day: DailyAggregate, topN: number): DailyAggregate {
  const entries = Object.entries(day.categories);
  if (entries.length <= topN) return day;
  const existingOther = day.categories[OTHER_BUCKET];
  const realEntries = entries.filter(([cat]) => cat !== OTHER_BUCKET).sort(([, a], [, b]) => b.totalRevenue - a.totalRevenue);
  const top = realEntries.slice(0, topN);
  const rest = realEntries.slice(topN);
  const other = rest.reduce<CategoryAggregate>(
    (acc, [, c]) => ({ totalOrders: acc.totalOrders + c.totalOrders, totalRevenue: acc.totalRevenue + c.totalRevenue, totalItems: acc.totalItems + c.totalItems, avgOrderValue: 0 }),
    existingOther ?? { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;
  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  if (other.totalOrders > 0 || existingOther) categories[OTHER_BUCKET] = other;
  return { ...day, categories };
}
