import { NextRequest, NextResponse } from "next/server";
import { getDailyAggregates, isAppError, listOrders } from "@/lib/services";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : undefined;
  };
  const nullableNum = (name: string) => {
    const v = num(name);
    return v == null ? null : v;
  };

  try {
    const q = searchParams.get("q");
    const status = searchParams.get("status");
    const regionCode = searchParams.get("regionCode");
    const from = searchParams.get("from") ?? "";
    const to = searchParams.get("to") ?? "";
    const minTotal = nullableNum("minTotal");
    const maxTotal = nullableNum("maxTotal");
    const topCategories = nullableNum("topCategories");

    const [orders, aggregates] = await Promise.all([
      listOrders({
        page: num("page"),
        pageSize: num("pageSize"),
        q,
        sort: searchParams.get("sort"),
        dir: searchParams.get("dir"),
        status,
        regionCode,
        from: searchParams.get("orderFrom"),
        to: searchParams.get("orderTo"),
        minTotal,
        maxTotal,
        facets: searchParams.get("facets") === "1" || searchParams.get("facets") === "true",
      }),
      getDailyAggregates({
        from,
        to,
        q,
        status,
        regionCode,
        minTotal,
        maxTotal,
        topCategories,
      }),
    ]);

    return NextResponse.json({ orders, aggregates });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
