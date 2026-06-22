import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import { buildFilterConditions, resolveFilters } from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
// Literal key the chart relies on for the rolled-up remainder bucket.
const OTHER_BUCKET = "Others";

interface AggRow {
  day: string; // 'YYYY-MM-DD'
  category: string;
  total_orders: bigint;
  total_items: bigint;
  total_revenue: Prisma.Decimal | string | number | null;
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  if (!input.from || !input.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  // 0 / null / undefined -> default; negative is clamped to the default too.
  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  try {
    // Identical filter resolution to GET /api/orders: `from`/`to` become the
    // placedAt range, and status / regionCode (comma list) / minTotal / maxTotal
    // all narrow the same way. The daily category buckets are then computed over
    // exactly that filtered order set.
    const filters = await resolveFilters(input);
    const conds = buildFilterConditions(filters);
    // `from`/`to` are required, so `conds` is never empty; guard regardless.
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;

    // Filters apply to `orders` (alias `o`); revenue/items come from the line
    // items joined out to their category. `to_char` keeps the day in the stored
    // timestamp's own calendar (no timezone shift).
    const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT
        to_char(o."placedAt", 'YYYY-MM-DD')                                AS day,
        cat.name                                                           AS category,
        count(DISTINCT o.id)::bigint                                       AS total_orders,
        coalesce(sum(oi.quantity), 0)::bigint                              AS total_items,
        coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) AS total_revenue
      FROM orders o
      JOIN order_items oi ON oi."orderId" = o.id
      JOIN products p     ON p.id = oi."productId"
      JOIN categories cat ON cat.id = p."categoryId"
      ${whereSql}
      GROUP BY day, cat.name
      ORDER BY day ASC, cat.name ASC`);

    const byDate = new Map<string, DailyAggregate>();
    for (const r of rows) {
      let entry = byDate.get(r.day);
      if (!entry) {
        entry = {
          date: r.day,
          categories: {},
          totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 },
        };
        byDate.set(r.day, entry);
      }

      const totalOrders = Number(r.total_orders);
      const totalRevenue = Number(r.total_revenue ?? 0);
      const totalItems = Number(r.total_items);
      const cat: CategoryAggregate = {
        totalOrders,
        totalRevenue,
        totalItems,
        avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      };
      entry.categories[r.category] = cat;
      entry.totals.totalOrders += totalOrders;
      entry.totals.totalRevenue += totalRevenue;
      entry.totals.totalItems += totalItems;
    }

    return Array.from(byDate.values()).map((day) => capToTopCategories(day, topN));
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

/**
 * Keep only the top-N categories by revenue for a day; sum the remainder into a
 * single "Others" bucket so the chart shows at most N+1 keys. Day-level `totals`
 * are unaffected (they already reflect every category).
 */
function capToTopCategories(day: DailyAggregate, topN: number): DailyAggregate {
  const entries = Object.entries(day.categories).sort(
    ([, a], [, b]) => b.totalRevenue - a.totalRevenue,
  );
  if (entries.length <= topN) return day;

  const top = entries.slice(0, topN);
  const rest = entries.slice(topN);

  const other = rest.reduce<CategoryAggregate>(
    (acc, [, c]) => ({
      totalOrders: acc.totalOrders + c.totalOrders,
      totalRevenue: acc.totalRevenue + c.totalRevenue,
      totalItems: acc.totalItems + c.totalItems,
      avgOrderValue: 0, // recomputed below
    }),
    { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;

  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  categories[OTHER_BUCKET] = other;
  return { ...day, categories };
}
