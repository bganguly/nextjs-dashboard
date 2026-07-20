import { query, pool } from "@/lib/db";
import { AppError, mapDbError } from "@/lib/errors";
import { invalidateAggregatesCache } from "@/lib/aggregates-cache";
import { publishOrderEvent } from "./stream.service";
import type {
  CreateOrderInput,
  CreateOrderResult,
  FacetCount,
  OrderDTO,
  OrderFacets,
  OrderFilterInput,
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
export const COUNT_SENTINEL = 10_001;

const ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED",
];

const SORT_COL: Record<OrderSortField, string> = {
  placedAt: "placed_at",
  total: "total",
  status: "status",
  customer: "customer_last_name",
  id: "order_id",
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in SORT_COL ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

export function escapeLike(input: string): string {
  return input.replace(/[%_]/g, "");
}

export function normalizeStatusList(csv: string | null | undefined): OrderStatus[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is OrderStatus => (ORDER_STATUSES as readonly string[]).includes(s));
}

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ResolvedFilters {
  statuses: OrderStatus[];
  regionCodes: string[];
  from: string | null;
  to: string | null;
  minTotal: number | null;
  maxTotal: number | null;
  hasAny: boolean;
}

function parseList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseDateBoundary(value: string | null | undefined, edge: "start" | "end"): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError("BAD_REQUEST", `invalid date filter: ${value}`);
  if (edge === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d.toISOString();
}

export async function resolveFilters(input: OrderFilterInput): Promise<ResolvedFilters> {
  const statuses = normalizeStatusList(input.status);
  const regionCodes = parseList(input.regionCode);
  const from = parseDateBoundary(input.from, "start");
  const toRaw = input.to || (input.from ? todayDateString() : input.to);
  const to = parseDateBoundary(toRaw, "end");
  const minTotal = input.minTotal ?? null;
  const maxTotal = input.maxTotal ?? null;
  const hasAny =
    statuses.length > 0 || regionCodes.length > 0 || from !== null || to !== null ||
    minTotal !== null || maxTotal !== null;
  return { statuses, regionCodes, from, to, minTotal, maxTotal, hasAny };
}

function buildWhereParts(
  searchTokens: string[],
  f: ResolvedFilters,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  for (const tok of searchTokens) {
    clauses.push(`search_text ILIKE '%' || $${pi++} || '%'`);
    params.push(escapeLike(tok));
  }
  if (f.statuses.length) {
    clauses.push(`status = ANY($${pi++}::text[])`);
    params.push(f.statuses);
  }
  if (f.regionCodes.length) {
    clauses.push(`region_code = ANY($${pi++}::text[])`);
    params.push(f.regionCodes);
  }
  if (f.from) {
    clauses.push(`placed_at >= $${pi++}::timestamptz`);
    params.push(f.from);
  }
  if (f.to) {
    clauses.push(`placed_at <= $${pi++}::timestamptz`);
    params.push(f.to);
  }
  if (f.minTotal !== null) {
    clauses.push(`total >= $${pi++}`);
    params.push(f.minTotal);
  }
  if (f.maxTotal !== null) {
    clauses.push(`total <= $${pi++}`);
    params.push(f.maxTotal);
  }
  return { clauses, params };
}

function whereSQL(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export async function listOrders(input: OrderListInput): Promise<OrderListResult> {
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);
  const offset = (page - 1) * pageSize;

  try {
    const filters = await resolveFilters(input);
    const { clauses, params } = buildWhereParts(tokens, filters);
    const where = whereSQL(clauses);
    const sortCol = SORT_COL[sort];
    const orderBy = `${sortCol} ${dir.toUpperCase()}, order_id ${dir.toUpperCase()}`;

    const countRows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM orders ${where}`,
      params,
    );
    const rawTotal = Number(countRows[0]?.n ?? 0);
    const approximate = rawTotal > COUNT_SENTINEL - 1;
    const total = approximate ? COUNT_SENTINEL - 1 : rawTotal;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    const limN = params.length + 1;
    const offN = params.length + 2;
    const idRows = await query<{ order_id: string }>(
      `SELECT order_id FROM orders ${where} ORDER BY ${orderBy} LIMIT $${limN} OFFSET $${offN}`,
      [...params, pageSize, offset],
    );
    const ids = idRows.map((r) => Number(r.order_id));
    const data = await hydrateOrders(ids);
    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(where, params);
    return result;
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

export async function listOrdersByCursor(
  input: OrderListInput & { cursorId: number; cursorPlacedAt: string; cursorDir: "next" | "prev" },
): Promise<OrderListResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const tokens = (input.q?.trim() ?? "").split(/\s+/).filter(Boolean);

  try {
    const filters = await resolveFilters(input);
    const { clauses: baseClauses, params: baseParams } = buildWhereParts(tokens, filters);

    const cursorTs = new Date(input.cursorPlacedAt).toISOString();
    const isNext = input.cursorDir === "next";
    const cTsN = baseParams.length + 1;
    const cIdN = baseParams.length + 2;
    const cursorClause = isNext
      ? `(placed_at, order_id) < ($${cTsN}::timestamptz, $${cIdN}::bigint)`
      : `(placed_at, order_id) > ($${cTsN}::timestamptz, $${cIdN}::bigint)`;
    const allClauses = [...baseClauses, cursorClause];
    const allParams = [...baseParams, cursorTs, input.cursorId];
    const where = whereSQL(allClauses);
    const dirSQL = isNext ? "DESC" : "ASC";

    const limN = allParams.length + 1;
    const [countRows, pageRows] = await Promise.all([
      query<{ n: string }>(`SELECT count(*) AS n FROM orders ${whereSQL(baseClauses)}`, baseParams),
      query<{ order_id: string }>(
        `SELECT order_id FROM orders ${where} ORDER BY placed_at ${dirSQL}, order_id ${dirSQL} LIMIT $${limN}`,
        [...allParams, pageSize],
      ),
    ]);

    const rawTotal = Number(countRows[0]?.n ?? 0);
    const approximate = rawTotal > COUNT_SENTINEL - 1;
    const total = approximate ? COUNT_SENTINEL - 1 : rawTotal;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    const idRows = isNext ? pageRows : pageRows.reverse();
    const ids = idRows.map((r) => Number(r.order_id));
    const data = await hydrateOrders(ids);
    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(whereSQL(baseClauses), baseParams);
    return result;
  } catch (err) {
    mapDbError(err, "listOrdersByCursor");
  }
}

async function hydrateOrders(ids: number[]): Promise<OrderDTO[]> {
  if (ids.length === 0) return [];

  const [orderRows, itemRows] = await Promise.all([
    query<{
      order_id: string; status: string; total: string; currency: string; notes: string | null;
      placed_at: Date; customer_id: string; region_id: number; region_code: string;
      customer_first_name: string; customer_last_name: string; customer_email: string;
    }>(`SELECT order_id, status, total, currency, notes, placed_at,
              customer_id, region_id, region_code,
              customer_first_name, customer_last_name, customer_email
       FROM orders WHERE order_id = ANY($1::bigint[])`, [ids]),
    query<{
      order_id: string; item_id: string; product_id: number; product_name: string;
      product_sku: string; quantity: number; unit_price: string; discount: string;
    }>(`SELECT order_id, item_id, product_id, product_name, product_sku,
              quantity, unit_price, discount
       FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY order_id, item_id`, [ids]),
  ]);

  const itemsByOrder = new Map<number, OrderItemDTO[]>();
  for (const r of itemRows) {
    const oid = Number(r.order_id);
    if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
    itemsByOrder.get(oid)!.push({
      id: Number(r.item_id),
      productId: r.product_id,
      quantity: r.quantity,
      unitPrice: Number(r.unit_price),
      discount: Number(r.discount),
      product: { id: r.product_id, sku: r.product_sku, name: r.product_name },
    });
  }

  const orderMap = new Map(orderRows.map((r) => [Number(r.order_id), r]));
  return ids.flatMap((id) => {
    const r = orderMap.get(id);
    if (!r) return [];
    return [{
      id,
      status: r.status as OrderStatus,
      total: Number(r.total),
      currency: r.currency,
      notes: r.notes,
      placedAt: new Date(r.placed_at).toISOString(),
      customer: {
        id: Number(r.customer_id),
        email: r.customer_email,
        firstName: r.customer_first_name,
        lastName: r.customer_last_name,
      },
      region: { id: r.region_id, code: r.region_code, name: r.region_code },
      items: itemsByOrder.get(id) ?? [],
    }];
  });
}

async function computeFacets(
  where: string,
  params: unknown[],
): Promise<OrderFacets> {
  const rows = await query<{ dim: string; key: string; n: string }>(
    `SELECT 'status' AS dim, status AS key, count(*) AS n FROM orders ${where} GROUP BY status
     UNION ALL
     SELECT 'region' AS dim, region_code AS key, count(*) AS n FROM orders ${where} GROUP BY region_code`,
    params,
  );

  const status: FacetCount[] = [];
  const region: FacetCount[] = [];
  for (const r of rows) {
    const fc: FacetCount = { value: r.key, count: Number(r.n) };
    if (r.dim === "status") status.push(fc);
    else region.push(fc);
  }
  status.sort((a, b) => b.count - a.count);
  region.sort((a, b) => b.count - a.count);
  return { status, region, approximate: false };
}

let _nextId = Date.now();
function genId(): number {
  return ++_nextId;
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (!input.customerId || !input.regionId || !Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("BAD_REQUEST", "customerId, regionId, and at least one item are required");
  }
  for (const it of input.items) {
    if (!it.productId || it.quantity <= 0 || it.unitPrice < 0) {
      throw new AppError("BAD_REQUEST", "each item needs productId, positive quantity, non-negative unitPrice");
    }
  }

  const total = input.items.reduce(
    (sum, it) => sum + it.quantity * it.unitPrice * (1 - (it.discount ?? 0)),
    0,
  );

  try {
    const [customerRows, productRows, regionRows] = await Promise.all([
      query<{ customer_id: string; first_name: string; last_name: string; email: string; region_id: number }>(
        `SELECT customer_id, first_name, last_name, email, region_id FROM customers WHERE customer_id = $1 LIMIT 1`,
        [input.customerId],
      ),
      query<{ product_id: number; sku: string; name: string; category_id: number; category_name: string }>(
        `SELECT p.product_id, p.sku, p.name, p.category_id, c.name AS category_name
         FROM products p JOIN categories c ON c.category_id = p.category_id
         WHERE p.product_id = ANY($1::int[])`,
        [input.items.map((i) => i.productId)],
      ),
      query<{ region_id: number; code: string; name: string }>(
        `SELECT region_id, code, name FROM regions WHERE region_id = $1 LIMIT 1`,
        [input.regionId],
      ),
    ]);

    const customer = customerRows[0];
    if (!customer) throw new AppError("NOT_FOUND", `customer ${input.customerId} not found`);
    const region = regionRows[0];
    if (!region) throw new AppError("NOT_FOUND", `region ${input.regionId} not found`);

    const productById = new Map(productRows.map((p) => [p.product_id, p]));

    const orderId = genId();
    const placedAt = new Date().toISOString();
    const searchText = `${customer.first_name} ${customer.last_name} ${customer.email}${input.notes ? " " + input.notes : ""}`;

    const itemRows = input.items.map((it) => {
      const p = productById.get(it.productId);
      return {
        item_id: genId(),
        order_id: orderId,
        product_id: it.productId,
        product_name: p?.name ?? "",
        product_sku: p?.sku ?? "",
        category_id: p?.category_id ?? 0,
        category_name: p?.category_name ?? "",
        quantity: it.quantity,
        unit_price: it.unitPrice,
        discount: it.discount ?? 0,
      };
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO orders (order_id, customer_id, region_id, region_code, customer_first_name, customer_last_name, customer_email, status, total, currency, notes, search_text, placed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [orderId, input.customerId, input.regionId, region.code, customer.first_name, customer.last_name, customer.email, "PENDING", total, input.currency ?? "USD", input.notes ?? null, searchText, placedAt],
      );
      for (const item of itemRows) {
        await client.query(
          `INSERT INTO order_items (item_id, order_id, product_id, product_name, product_sku, category_id, category_name, quantity, unit_price, discount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [item.item_id, item.order_id, item.product_id, item.product_name, item.product_sku, item.category_id, item.category_name, item.quantity, item.unit_price, item.discount],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const firstCategorySlug = itemRows[0]?.category_name;
    publishOrderEvent({
      id: orderId,
      total,
      customerId: input.customerId,
      placedAt,
      categorySlug: firstCategorySlug,
    }).catch(() => {});

    invalidateAggregatesCache();

    return { id: orderId, status: "PENDING", total, placedAt };
  } catch (err) {
    mapDbError(err, "createOrder");
  }
}

export function isPureDateRangeQuery(q: string | undefined, filters: ResolvedFilters): boolean {
  return (
    !q?.trim() &&
    filters.statuses.length === 0 &&
    filters.regionCodes.length === 0 &&
    filters.minTotal === null &&
    filters.maxTotal === null
  );
}

export async function getOrderCount(
  q: string | undefined,
  filters: ResolvedFilters,
): Promise<number> {
  const tokens = (q?.trim() ?? "").split(/\s+/).filter(Boolean);
  const { clauses, params } = buildWhereParts(tokens, filters);
  const where = whereSQL(clauses);
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM orders ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
