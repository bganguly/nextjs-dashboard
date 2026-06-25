import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateProductInput,
  ProductDTO,
  ProductListInput,
  ProductListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const productInclude = {
  category: { select: { name: true } },
} satisfies Prisma.ProductInclude;

type ProductWithCategory = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function toProductDTO(p: ProductWithCategory): ProductDTO {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    price: Number(p.price),
    cost: Number(p.cost),
    stock: p.stock,
    categoryId: p.categoryId,
    categoryName: p.category.name,
  };
}

export async function listProducts(input: ProductListInput): Promise<ProductListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const q = input.q?.trim();

  const where: Prisma.ProductWhereInput = {
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { sku: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  try {
    const rows = await prisma.product.findMany({
      where,
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      include: productInclude,
    });

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toProductDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listProducts");
  }
}

export async function getProduct(id: number): Promise<ProductDTO> {
  try {
    const p = await prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!p) throw new AppError("NOT_FOUND", `product ${id} not found`);
    return toProductDTO(p);
  } catch (err) {
    mapDbError(err, "getProduct");
  }
}

export async function createProduct(input: CreateProductInput): Promise<ProductDTO> {
  if (!input.sku || !input.name || input.price == null || input.cost == null || !input.categoryId) {
    throw new AppError("BAD_REQUEST", "sku, name, price, cost, and categoryId are required");
  }
  try {
    const p = await prisma.product.create({
      data: {
        sku: input.sku,
        name: input.name,
        description: input.description ?? null,
        price: input.price,
        cost: input.cost,
        stock: input.stock ?? 0,
        categoryId: input.categoryId,
      },
      include: productInclude,
    });
    return toProductDTO(p);
  } catch (err) {
    mapDbError(err, "createProduct");
  }
}
