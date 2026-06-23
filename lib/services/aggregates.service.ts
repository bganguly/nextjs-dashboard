import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import { buildFilterConditions, escapeLike, resolveFilters } from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Others";

interface AggRow {
  day: string;
  category: string;
  total_orders: bigint;
  total_items: bigint;
  total_revenue: Prisma.Decimal | string | number | null;
}

function canUseDailySummary(input: AggregateQueryInput): boolean {
  const noQ = !input.q || input.q.trim() === "";
  const noStatus = !input.status || input.status.trim() === "";
  const noMinTotal = input.minTotal == null;
  const noMaxTotal = input.maxTotal == null;
  return noQ && noStatus && noMinTotal && noMaxTotal;
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  if (!input.from || !input.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  try {
    const rows = canUseDailySummary(input)
      ? await fastPath(input)
      : await slowPath(input);
    return rowsToDailyAggregates(rows, topN);
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

async function fastPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];

  if (input.regionCode) {
    const codes = input.regionCode
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (codes.length) {
      conds.push(Prisma.sql`ds."regionCode" = ANY(${codes})`);
    }
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD')    AS day,
      ds."categoryName"                  AS category,
      SUM(ds."totalOrders")::bigint      AS total_orders,
      SUM(ds."totalItems")::bigint       AS total_items,
      SUM(ds."totalRevenue")             AS total_revenue
    FROM daily_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

async function slowPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const filters = await resolveFilters(input);
  const conds = buildFilterConditions(filters);

  const q = input.q?.trim();
  let customerJoin = Prisma.empty;
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const custRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT id FROM customers
      WHERE ("firstName" || ' ' || "lastName" || ' ' || email) ILIKE ${pattern}
      LIMIT 50001`);
    if (custRows.length > 50000) {
      // Broad text: fall back to inline ILIKE (extremely rare)
      customerJoin = Prisma.sql`JOIN customers c ON c.id = o."customerId"`;
      conds.push(
        Prisma.sql`((c."firstName" || ' ' || c."lastName" || ' ' || c.email) ILIKE ${pattern} OR o.notes ILIKE ${pattern})`,
      );
    } else {
      const ids = custRows.map((r) => r.id);
      conds.push(Prisma.sql`(o."customerId" = ANY(${ids}) OR o.notes ILIKE ${pattern})`);
    }
  }

  const whereSql = conds.length
    ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
    : Prisma.empty;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(o."placedAt", 'YYYY-MM-DD')                                AS day,
      cat.name                                                           AS category,
      count(DISTINCT o.id)::bigint                                       AS total_orders,
      coalesce(sum(oi.quantity), 0)::bigint                              AS total_items,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) AS total_revenue
    FROM orders o
    ${customerJoin}
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    ${whereSql}
    GROUP BY day, cat.name
    ORDER BY day ASC, cat.name ASC`);
}

function rowsToDailyAggregates(rows: AggRow[], topN: number): DailyAggregate[] {
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
}

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
      avgOrderValue: 0,
    }),
    { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;

  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  categories[OTHER_BUCKET] = other;
  return { ...day, categories };
}

/**
 * Incrementally upsert daily_summary rows for a single order. Fire-and-forget
 * from createOrder so the summary stays in sync without a full backfill.
 */
export async function updateDailySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_summary (date, "categoryId", "categoryName", "regionId", "regionCode",
                               "totalOrders", "totalRevenue", "totalItems", "avgOrderValue",
                               "createdAt", "updatedAt")
    SELECT
      o."placedAt"::date,
      cat.id,
      cat.name,
      o."regionId",
      r.code,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code
    ON CONFLICT (date, "categoryId", "regionId")
    DO UPDATE SET
      "totalOrders"  = daily_summary."totalOrders" + 1,
      "totalRevenue" = daily_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_summary."totalItems" + EXCLUDED."totalItems",
      "avgOrderValue"= (daily_summary."totalRevenue" + EXCLUDED."totalRevenue")
                       / (daily_summary."totalOrders" + 1),
      "updatedAt"    = now()`);
}
