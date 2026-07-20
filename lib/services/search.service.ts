import { query } from "@/lib/db";
import { AppError, mapDbError } from "@/lib/errors";
import type { SearchInput, SearchResult, SearchResultItem } from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function search(input: SearchInput): Promise<SearchResult> {
  const q = input.q?.trim();
  if (!q) throw new AppError("BAD_REQUEST", "q (search query) is required");

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const [orderRows, productRows, customerRows] = await Promise.all([
      (!input.entityType || input.entityType === "order")
        ? query<{ order_id: string; search_text: string }>(
            `SELECT order_id, search_text FROM orders
             WHERE search_text ILIKE '%' || $1 || '%'
             ORDER BY placed_at DESC LIMIT $2`,
            [q, limit],
          )
        : Promise.resolve([]),
      (!input.entityType || input.entityType === "product")
        ? query<{ product_id: number; name: string; sku: string }>(
            `SELECT product_id, name, sku FROM products
             WHERE (name || ' ' || sku) ILIKE '%' || $1 || '%'
             LIMIT $2`,
            [q, limit],
          )
        : Promise.resolve([]),
      (!input.entityType || input.entityType === "customer")
        ? query<{ customer_id: string; first_name: string; last_name: string; email: string }>(
            `SELECT customer_id, first_name, last_name, email FROM customers
             WHERE (first_name || ' ' || last_name || ' ' || email) ILIKE '%' || $1 || '%'
             LIMIT $2`,
            [q, limit],
          )
        : Promise.resolve([]),
    ]);

    const results: SearchResultItem[] = [
      ...orderRows.map((r) => ({ entityType: "order", entityId: Number(r.order_id), content: r.search_text })),
      ...productRows.map((r) => ({ entityType: "product", entityId: r.product_id, content: `${r.name} ${r.sku}` })),
      ...customerRows.map((r) => ({ entityType: "customer", entityId: Number(r.customer_id), content: `${r.first_name} ${r.last_name} ${r.email}` })),
    ].slice(0, limit);

    return { query: q, results };
  } catch (err) {
    mapDbError(err, "search");
  }
}
