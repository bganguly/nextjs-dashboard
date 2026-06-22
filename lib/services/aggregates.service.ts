import { prisma } from "@/lib/prisma";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  if (!input.from || !input.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

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

    return Array.from(byDate.values());
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}
