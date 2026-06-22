import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateOrderInput,
  OrderDTO,
  OrderItemDTO,
  OrderListInput,
  OrderListResult,
  OrderSortField,
  OrderStatus,
  SortDir,
} from "@/lib/types";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT: OrderSortField = "placedAt";
const DEFAULT_DIR: SortDir = "desc";

/** Maps each allowed sort field to a Prisma orderBy clause for the given direction. */
const ORDER_BY: Record<OrderSortField, (dir: SortDir) => Prisma.OrderOrderByWithRelationInput> = {
  placedAt: (dir) => ({ placedAt: dir }),
  total: (dir) => ({ total: dir }),
  status: (dir) => ({ status: dir }),
  customer: (dir) => ({ customer: { lastName: dir } }),
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in ORDER_BY ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

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
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
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

  // Tie-break on id so pages are stable when the sort key has duplicates.
  const orderBy: Prisma.OrderOrderByWithRelationInput[] = [ORDER_BY[sort](dir), { id: dir }];

  try {
    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy,
        include: orderInclude,
      }),
      prisma.order.count({ where }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    return { data: rows.map(toOrderDTO), page, pageSize, total, totalPages };
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
