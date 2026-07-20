import { query, execute } from "@/lib/db";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateProductInput, ProductDTO, ProductListInput, ProductListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toDTO(r: {
  product_id: number; sku: string; name: string; description: string | null;
  price: string; cost: string; stock: number; category_id: number; category_name: string;
}): ProductDTO {
  return {
    id: r.product_id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    cost: Number(r.cost),
    stock: r.stock,
    categoryId: r.category_id,
    categoryName: r.category_name,
  };
}

export async function listProducts(input: ProductListInput): Promise<ProductListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const clauses: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (input.q?.trim()) {
    clauses.push(`(p.name || ' ' || p.sku) ILIKE '%' || $${pi++} || '%'`);
    params.push(input.q.trim());
  }
  if (input.categoryId) {
    clauses.push(`p.category_id = $${pi++}`);
    params.push(input.categoryId);
  }
  if (input.cursor) {
    clauses.push(`p.product_id > $${pi++}`);
    params.push(input.cursor);
  }

  const limN = pi;
  params.push(limit + 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const rows = await query<{
      product_id: number; sku: string; name: string; description: string | null;
      price: string; cost: string; stock: number; category_id: number; category_name: string;
    }>(
      `SELECT p.product_id, p.sku, p.name, p.description, p.price, p.cost, p.stock,
              p.category_id, c.name AS category_name
       FROM products p JOIN categories c ON c.category_id = p.category_id
       ${where}
       ORDER BY p.product_id ASC
       LIMIT $${limN}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listProducts");
  }
}

export async function getProduct(id: number): Promise<ProductDTO> {
  try {
    const rows = await query<{
      product_id: number; sku: string; name: string; description: string | null;
      price: string; cost: string; stock: number; category_id: number; category_name: string;
    }>(
      `SELECT p.product_id, p.sku, p.name, p.description, p.price, p.cost, p.stock,
              p.category_id, c.name AS category_name
       FROM products p JOIN categories c ON c.category_id = p.category_id
       WHERE p.product_id = $1 LIMIT 1`,
      [id],
    );
    if (rows.length === 0) throw new AppError("NOT_FOUND", `product ${id} not found`);
    return toDTO(rows[0]);
  } catch (err) {
    mapDbError(err, "getProduct");
  }
}

let _productId = Date.now();

export async function createProduct(input: CreateProductInput): Promise<ProductDTO> {
  if (!input.sku || !input.name || input.price == null || input.cost == null || !input.categoryId) {
    throw new AppError("BAD_REQUEST", "sku, name, price, cost, and categoryId are required");
  }
  try {
    const catRows = await query<{ category_id: number; name: string }>(
      `SELECT category_id, name FROM categories WHERE category_id = $1 LIMIT 1`,
      [input.categoryId],
    );
    if (catRows.length === 0) throw new AppError("NOT_FOUND", `category ${input.categoryId} not found`);

    const productId = ++_productId;
    await execute(
      `INSERT INTO products (product_id, sku, name, description, price, cost, stock, category_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [productId, input.sku, input.name, input.description ?? null, input.price, input.cost, input.stock ?? 0, input.categoryId],
    );

    return {
      id: productId,
      sku: input.sku,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      cost: input.cost,
      stock: input.stock ?? 0,
      categoryId: input.categoryId,
      categoryName: catRows[0].name,
    };
  } catch (err) {
    mapDbError(err, "createProduct");
  }
}
