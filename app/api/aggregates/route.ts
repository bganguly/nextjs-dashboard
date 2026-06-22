import { NextRequest, NextResponse } from "next/server";
import { getDailyAggregates, isAppError } from "@/lib/services";

// GET /api/aggregates?from=YYYY-MM-DD&to=YYYY-MM-DD&regionCode=<code>
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  try {
    const data = await getDailyAggregates({
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      regionCode: searchParams.get("regionCode"),
    });
    return NextResponse.json({ data });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
