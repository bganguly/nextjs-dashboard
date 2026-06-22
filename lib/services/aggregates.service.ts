import { prisma } from "@/lib/prisma";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Other";

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  if (!input.from || !input.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  // 0 / null / undefined -> default; negative is clamped to the default too.
  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const fromDate = new Date(input.from);
  const toDate = new Date(input.to);
  toDate.setHours(23, 59, 59, 999);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new AppError("BAD_REQUEST", "invalid date format; expected YYYY-MM-DD");
  }

  try {
    const rows = await prisma.dailySummary.findMany({
      where: {
        date: { gte: fromDate, lte: toDate },
        ...(input.regionCode ? { regionCode: input.regionCode } : {}),
      },
      orderBy: [{ date: "asc" }, { categoryName: "asc" }],
    });

    const byDate = new Map<string, DailyAggregate>();
    for (const r of rows) {
      const key = r.date.toISOString().split("T")[0];
      let entry = byDate.get(key);
      if (!entry) {
        entry = {
          date: key,
          categories: {},
          totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 },
        };
        byDate.set(key, entry);
      }

      const cat: CategoryAggregate = {
        totalOrders: r.totalOrders,
        totalRevenue: Number(r.totalRevenue),
        totalItems: r.totalItems,
        avgOrderValue: Number(r.avgOrderValue),
      };
      entry.categories[r.categoryName] = cat;
      entry.totals.totalOrders += cat.totalOrders;
      entry.totals.totalRevenue += cat.totalRevenue;
      entry.totals.totalItems += cat.totalItems;
    }

    return Array.from(byDate.values()).map((day) => capToTopCategories(day, topN));
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

/**
 * Keep only the top-N categories by revenue for a day; sum the remainder into a
 * single "Other" bucket so the chart stays readable. Day-level `totals` are
 * unaffected.
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
