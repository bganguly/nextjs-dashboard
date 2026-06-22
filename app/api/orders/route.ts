import { NextRequest, NextResponse } from "next/server";
import { createOrder, isAppError, listOrders } from "@/lib/services";
import type { CreateOrderInput } from "@/lib/types";

// GET /api/orders?cursor=<id>&limit=<n>&q=<search>
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const cursor = searchParams.get("cursor");
  const limit = searchParams.get("limit");

  try {
    const result = await listOrders({
      cursor: cursor ? Number(cursor) : null,
      limit: limit ? Number(limit) : undefined,
      q: searchParams.get("q"),
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
