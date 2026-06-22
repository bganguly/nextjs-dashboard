import { NextRequest, NextResponse } from "next/server";
import { getDailyAggregates, isAppError } from "@/lib/services";

// GET /api/aggregates?from=YYYY-MM-DD&to=YYYY-MM-DD&topCategories=<N>
//   filters (same as /api/orders): &status=&regionCode=&minTotal=&maxTotal=
//   (status/regionCode accept comma lists; from/to are the date range)
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const topCategories = searchParams.get("topCategories");
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : null;
  };

  try {
    const data = await getDailyAggregates({
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      status: searchParams.get("status"),
      regionCode: searchParams.get("regionCode"),
      minTotal: num("minTotal"),
      maxTotal: num("maxTotal"),
      topCategories: topCategories ? Number(topCategories) : null,
    });
    return NextResponse.json({ data });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
