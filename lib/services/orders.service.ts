import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateOrderInput,
  OrderDTO,
  OrderItemDTO,
  OrderListInput,
  OrderListResult,
  OrderStatus,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const orderInclude = {
  customer: { select: { id: true, email: true, firstName: true, lastName: true } },
  region: { select: { id: true, code: true, name: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true } } } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function toOrderDTO(o: OrderWithRelations): OrderDTO {
  return {
    id: o.id,
    status: o.status as OrderStatus,
    total: Number(o.total),
    currency: o.currency,
    notes: o.notes,
    placedAt: o.placedAt.toISOString(),
    customer: o.customer,
    region: o.region,
    items: o.items.map(
      (it): OrderItemDTO => ({
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: Number(it.unitPrice),
        discount: Number(it.discount),
        product: it.product,
      }),
    ),
  };
}

export async function listOrders(input: OrderListInput): Promise<OrderListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const q = input.q?.trim();

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

  try {
    const rows = await prisma.order.findMany({
      where,
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy: { placedAt: "desc" },
      include: orderInclude,
    });

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toOrderDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

export async function createOrder(input: CreateOrderInput): Promise<OrderDTO> {
  if (!input.customerId || !input.regionId || !Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("BAD_REQUEST", "customerId, regionId, and at least one item are required");
  }
  for (const it of input.items) {
    if (!it.productId || it.quantity <= 0 || it.unitPrice < 0) {
      throw new AppError(
        "BAD_REQUEST",
        "each item needs productId, a positive quantity, and a non-negative unitPrice",
      );
    }
  }

  const total = input.items.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice * (1 - (it.discount ?? 0)),
    0,
  );

  try {
    const created = await prisma.order.create({
      data: {
        customerId: input.customerId,
        regionId: input.regionId,
        currency: input.currency ?? "USD",
        notes: input.notes ?? null,
        total,
        items: {
          create: input.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discount: it.discount ?? 0,
          })),
        },
      },
      include: orderInclude,
    });
    return toOrderDTO(created);
  } catch (err) {
    mapDbError(err, "createOrder");
  }
}
