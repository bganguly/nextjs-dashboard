import { NextRequest, NextResponse } from "next/server";
import { createOrder, isAppError, listOrders } from "@/lib/services";
import type { CreateOrderInput } from "@/lib/types";

// GET /api/orders?q=&page=&pageSize=&sort=&dir=
//   filters: &status=&regionCode=&from=&to=&minTotal=&maxTotal=  (status/regionCode accept comma lists)
//   &facets=1 to include sidebar facet counts
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const num = (name: string) => {
    const v = searchParams.get(name);
    return v != null && v !== "" ? Number(v) : undefined;
  };

  try {
    const result = await listOrders({
      page: num("page"),
      pageSize: num("pageSize"),
      q: searchParams.get("q"),
      sort: searchParams.get("sort"),
      dir: searchParams.get("dir"),
      status: searchParams.get("status"),
      regionCode: searchParams.get("regionCode"),
      from: searchParams.get("from"),
      to: searchParams.get("to"),
      minTotal: num("minTotal") ?? null,
      maxTotal: num("maxTotal") ?? null,
      facets: searchParams.get("facets") === "1" || searchParams.get("facets") === "true",
    });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// POST /api/orders
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateOrderInput;
    const order = await createOrder(body);
    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function toErrorResponse(err: unknown) {
  if (isAppError(err)) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status: err.status },
    );
  }
  return NextResponse.json({ error: "internal server error" }, { status: 500 });
}
