import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

// GET /api/orders?cursor=<id>&limit=<n>&q=<search>
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const cursor = searchParams.get("cursor");
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 100);
  const q = searchParams.get("q")?.trim();

  const where: Prisma.OrderWhereInput = q
    ? {
        OR: [
          { customer: { email: { contains: q, mode: "insensitive" } } },
          { customer: { firstName: { contains: q, mode: "insensitive" } } },
          { customer: { lastName: { contains: q, mode: "insensitive" } } },
          { notes: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const orders = await prisma.order.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: Number(cursor) }, skip: 1 } : {}),
    orderBy: { placedAt: "desc" },
    include: {
      customer: { select: { id: true, email: true, firstName: true, lastName: true } },
      region: { select: { id: true, code: true, name: true } },
      items: {
        include: { product: { select: { id: true, sku: true, name: true } } },
      },
    },
  });

  const hasMore = orders.length > limit;
  const data = hasMore ? orders.slice(0, limit) : orders;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return NextResponse.json({ data, nextCursor, hasMore });
}

// POST /api/orders
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { customerId, regionId, currency = "USD", notes, items } = body;

  if (!customerId || !regionId || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "customerId, regionId, and items are required" }, { status: 400 });
  }

  const total = items.reduce(
    (sum: number, item: { quantity: number; unitPrice: number; discount?: number }) =>
      sum + item.quantity * item.unitPrice * (1 - (item.discount ?? 0)),
    0
  );

  const order = await prisma.order.create({
    data: {
      customerId,
      regionId,
      currency,
      notes,
      total,
      items: {
        create: items.map((item: { productId: number; quantity: number; unitPrice: number; discount?: number }) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
        })),
      },
    },
    include: {
      items: true,
      customer: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });

  return NextResponse.json(order, { status: 201 });
}
