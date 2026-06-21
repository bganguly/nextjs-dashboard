import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/aggregates?from=YYYY-MM-DD&to=YYYY-MM-DD&regionCode=<code>
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const regionCode = searchParams.get("regionCode");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to date params are required (YYYY-MM-DD)" }, { status: 400 });
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const rows = await prisma.dailySummary.findMany({
    where: {
      date: { gte: fromDate, lte: toDate },
      ...(regionCode ? { regionCode } : {}),
    },
    orderBy: [{ date: "asc" }, { categoryName: "asc" }],
  });

  // Group by date → categories
  const byDate: Record<
    string,
    {
      date: string;
      categories: Record<string, { totalOrders: number; totalRevenue: number; totalItems: number; avgOrderValue: number }>;
      totals: { totalOrders: number; totalRevenue: number; totalItems: number };
    }
  > = {};

  for (const row of rows) {
    const dateKey = row.date.toISOString().split("T")[0];
    if (!byDate[dateKey]) {
      byDate[dateKey] = { date: dateKey, categories: {}, totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 } };
    }
    const entry = byDate[dateKey];
    entry.categories[row.categoryName] = {
      totalOrders: row.totalOrders,
      totalRevenue: Number(row.totalRevenue),
      totalItems: row.totalItems,
      avgOrderValue: Number(row.avgOrderValue),
    };
    entry.totals.totalOrders += row.totalOrders;
    entry.totals.totalRevenue += Number(row.totalRevenue);
    entry.totals.totalItems += row.totalItems;
  }

  return NextResponse.json({ data: Object.values(byDate) });
}
