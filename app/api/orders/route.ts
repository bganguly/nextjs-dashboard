import { NextRequest, NextResponse } from "next/server";
import { createOrder, isAppError, listOrders } from "@/lib/services";
import type { CreateOrderInput } from "@/lib/types";

// GET /api/orders?q=<search>&page=<n>&pageSize=<n>&sort=<field>&dir=<asc|desc>
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const page = searchParams.get("page");
  const pageSize = searchParams.get("pageSize");

  try {
    const result = await listOrders({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      q: searchParams.get("q"),
      sort: searchParams.get("sort"),
      dir: searchParams.get("dir"),
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
