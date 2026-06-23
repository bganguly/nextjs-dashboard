import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
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
import { publishOrderEvent } from "./stream.service";
import { updateDailySummary } from "./aggregates.service";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT: OrderSortField = "placedAt";
const DEFAULT_DIR: SortDir = "desc";

// Stop counting matches at this bound; a broad result reports an approximate
// total/totalPages instead of paying for an exact count over millions of rows.
const COUNT_CAP = 10_000;
// Max customers we enumerate for the index-friendly `customerId = ANY(ids)`
// text plan. Above this a query is "broad text" and we fall back to the
// sort-index walk (which only the densest, unbounded queries reach).
const TEXT_MATCH_CAP = 50_000;
// Upper bound on rows scanned for facet counts.
const FACET_CAP = 50_000;

const ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
];

/** Prisma orderBy clauses for the unfiltered path. */
const ORDER_BY: Record<OrderSortField, (dir: SortDir) => Prisma.OrderOrderByWithRelationInput> = {
  placedAt: (dir) => ({ placedAt: dir }),
  total: (dir) => ({ total: dir }),
  status: (dir) => ({ status: dir }),
  customer: (dir) => ({ customer: { lastName: dir } }),
};

// Raw-SQL sort expressions for the search/filter path. Keyed by the validated
// whitelist, so these fragments are never attacker-controlled. `customer`
// requires the customers join (see pageNeedsJoin).
const SORT_SQL: Record<OrderSortField, string> = {
  placedAt: 'o."placedAt"',
  total: "o.total",
  status: "o.status",
  customer: 'c."lastName"',
};

function normalizeSort(sort: string | null | undefined): OrderSortField {
  return sort != null && sort in ORDER_BY ? (sort as OrderSortField) : DEFAULT_SORT;
}

function normalizeDir(dir: string | null | undefined): SortDir {
  return dir === "asc" || dir === "desc" ? dir : DEFAULT_DIR;
}

/** Strip LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[%_]/g, "");
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

// ---------- Filters ----------

export interface ResolvedFilters {
  statuses: OrderStatus[];
  regionIds: number[] | null; // null = no region filter; [] = filter that matches nothing
  from: Date | null;
  to: Date | null;
  minTotal: number | null;
  maxTotal: number | null;
  hasAny: boolean;
}

function parseList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseDateBoundary(value: string | null | undefined, edge: "start" | "end"): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AppError("BAD_REQUEST", `invalid date filter: ${value}`);
  }
  // A date-only `to` should include the whole day. Use UTC end-of-day so it is
  // symmetric with a date-only `from`, which `new Date("YYYY-MM-DD")` parses as
  // UTC midnight — otherwise the two bounds straddle different timezones and the
  // final day's rows get dropped on non-UTC hosts.
  if (edge === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

function parseNumber(value: number | null | undefined, name: string): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AppError("BAD_REQUEST", `invalid ${name}`);
  return n;
}

export async function resolveFilters(input: OrderFilterInput): Promise<ResolvedFilters> {
  const statuses = parseList(input.status).filter((s): s is OrderStatus =>
    (ORDER_STATUSES as readonly string[]).includes(s),
  );

  const regionCodes = parseList(input.regionCode);
  let regionIds: number[] | null = null;
  if (regionCodes.length) {
    const regions = await prisma.region.findMany({
      where: { code: { in: regionCodes } },
      select: { id: true },
    });
    regionIds = regions.map((r) => r.id); // [] when no code matches -> empty result
  }

  const from = parseDateBoundary(input.from, "start");
  const to = parseDateBoundary(input.to, "end");
  const minTotal = parseNumber(input.minTotal, "minTotal");
  const maxTotal = parseNumber(input.maxTotal, "maxTotal");

  const hasAny =
    statuses.length > 0 ||
    regionIds !== null ||
    from !== null ||
    to !== null ||
    minTotal !== null ||
    maxTotal !== null;

  return { statuses, regionIds, from, to, minTotal, maxTotal, hasAny };
}

/**
 * SQL conditions for the resolved filters — all on `orders` columns (indexable),
 * referencing the `o` alias. Reused by the aggregates service so both endpoints
 * apply identical filter semantics.
 */
export function buildFilterConditions(f: ResolvedFilters): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (f.statuses.length) c.push(Prisma.sql`o.status = ANY(${f.statuses}::text[]::"OrderStatus"[])`);
  if (f.regionIds !== null) c.push(Prisma.sql`o."regionId" = ANY(${f.regionIds})`);
  if (f.from) c.push(Prisma.sql`o."placedAt" >= ${f.from}`);
  if (f.to) c.push(Prisma.sql`o."placedAt" <= ${f.to}`);
  if (f.minTotal !== null) c.push(Prisma.sql`o.total >= ${f.minTotal}`);
  if (f.maxTotal !== null) c.push(Prisma.sql`o.total <= ${f.maxTotal}`);
  return c;
}

// ---------- List ----------

export async function listOrders(input: OrderListInput): Promise<OrderListResult> {
  const page = Math.max(Math.trunc(input.page ?? 1) || 1, 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const sort = normalizeSort(input.sort);
  const dir = normalizeDir(input.dir);
  const q = input.q?.trim();
  const offset = (page - 1) * pageSize;

  try {
    const filters = await resolveFilters(input);

    // --- Unfiltered path: every sort field is B-tree indexed, so Prisma's
    // index-backed findMany + exact count is fast even at deep offsets.
    if (!q && !filters.hasAny) {
      const orderBy: Prisma.OrderOrderByWithRelationInput[] = [ORDER_BY[sort](dir), { id: dir }];
      const [rows, total] = await Promise.all([
        prisma.order.findMany({ skip: offset, take: pageSize, orderBy, include: orderInclude }),
        prisma.order.count(),
      ]);
      const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
      const result: OrderListResult = {
        data: rows.map(toOrderDTO),
        page,
        pageSize,
        total,
        totalPages,
        approximate: false,
      };
      if (input.facets) result.facets = await computeFacets(Prisma.empty, false);
      return result;
    }

    // --- Search / filter path (raw SQL so the trgm + B-tree indexes apply and
    // the count stays capped).
    const filterConds = buildFilterConditions(filters);
    const customerJoin = Prisma.sql`JOIN customers c ON c.id = o."customerId"`;

    // Text predicate. We enumerate matching customers through the trgm index
    // (fast even for tens of thousands) so the orders filter can use
    // orders_customerId_idx. Only a query matching > TEXT_MATCH_CAP customers is
    // "broad text", where enumeration isn't worth it and we match by expression.
    let textCond: Prisma.Sql | null = null;
    let broadText = false;
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      const custRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM customers
        WHERE ("firstName" || ' ' || "lastName" || ' ' || email) ILIKE ${pattern}        LIMIT ${TEXT_MATCH_CAP + 1}`);
      broadText = custRows.length > TEXT_MATCH_CAP;
      textCond = broadText
        ? Prisma.sql`((c."firstName" || ' ' || c."lastName" || ' ' || c.email) ILIKE ${pattern} OR o.notes ILIKE ${pattern})`
        : Prisma.sql`(o."customerId" = ANY(${custRows.map((r) => r.id)}) OR o.notes ILIKE ${pattern})`;
    }

    const conds = [...(textCond ? [textCond] : []), ...filterConds];
    const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
    // The customers join is needed wherever the predicate references `c`.
    const filterWhereJoin = broadText ? customerJoin : Prisma.empty;

    // Is the result bounded by selective filters alone (regardless of q breadth)?
    const filterBounded =
      filters.hasAny &&
      filterConds.length > 0 &&
      (await cappedCount(Prisma.empty, Prisma.sql`WHERE ${Prisma.join(filterConds, " AND ")}`)) <=
        COUNT_CAP;

    const sortSql = Prisma.raw(SORT_SQL[sort]);
    const dirSql = Prisma.raw(dir === "asc" ? "ASC" : "DESC");

    // The sort-index walk only short-circuits when the matching set is large,
    // dense, and aligned to the sort. Otherwise filter-first (materialize the
    // matches, then sort) so a sparse/customer-sorted result stays fast.
    const selectiveText = Boolean(q) && !broadText;
    const useWalk = sort !== "customer" && !selectiveText && !filterBounded;

    const pageJoin = broadText || sort === "customer" ? customerJoin : Prisma.empty;

    const pageQuery = useWalk
      ? Prisma.sql`
          SELECT o.id
          FROM orders o ${pageJoin}
          ${whereSql}
          ORDER BY ${sortSql} ${dirSql}, o.id ${dirSql}
          LIMIT ${pageSize} OFFSET ${offset}`
      : Prisma.sql`
          WITH m AS MATERIALIZED (
            SELECT o.id AS id, ${sortSql} AS sortkey
            FROM orders o ${pageJoin}
            ${whereSql}
          )
          SELECT id FROM m ORDER BY sortkey ${dirSql}, id ${dirSql}
          LIMIT ${pageSize} OFFSET ${offset}`;

    const [idRows, counted] = await Promise.all([
      prisma.$queryRaw<{ id: number }[]>(pageQuery),
      cappedCount(filterWhereJoin, whereSql),
    ]);

    const approximate = counted > COUNT_CAP;
    const total = approximate ? COUNT_CAP : counted;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const data = await hydrateOrders(idRows.map((r) => r.id));

    const result: OrderListResult = { data, page, pageSize, total, totalPages, approximate };
    if (input.facets) result.facets = await computeFacets(whereSql, broadText);
    return result;
  } catch (err) {
    mapDbError(err, "listOrders");
  }
}

/** count(*) over the filter, bounded by COUNT_CAP + 1 so it never scans millions. */
async function cappedCount(join: Prisma.Sql, whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS count FROM (
      SELECT 1 FROM orders o ${join} ${whereSql} LIMIT ${COUNT_CAP + 1}
    ) capped`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Sidebar facet counts (per status, per region) for the current filter set.
 * Bounded by FACET_CAP rows; `approximate` is set when the set is larger.
 */
async function computeFacets(whereSql: Prisma.Sql, needsJoin: boolean): Promise<OrderFacets> {
  const join = needsJoin ? Prisma.sql`JOIN customers c ON c.id = o."customerId"` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ dim: string; key: string | null; n: bigint }[]>(Prisma.sql`
    WITH base AS (
      SELECT o.status, o."regionId" FROM orders o ${join} ${whereSql} LIMIT ${FACET_CAP + 1}
    )
    SELECT 'status' AS dim, status::text AS key, count(*)::bigint AS n FROM base GROUP BY status
    UNION ALL
    SELECT 'region' AS dim, "regionId"::text AS key, count(*)::bigint AS n FROM base GROUP BY "regionId"`);

  const status: FacetCount[] = [];
  const regionCount = new Map<number, number>();
  let baseSize = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.dim === "status") {
      status.push({ value: r.key ?? "UNKNOWN", count: n });
      baseSize += n; // every order has a status, so this sums to |base|
    } else if (r.key != null) {
      regionCount.set(Number(r.key), n);
    }
  }

  const regionIds = [...regionCount.keys()];
  const regions = regionIds.length
    ? await prisma.region.findMany({ where: { id: { in: regionIds } }, select: { id: true, code: true } })
    : [];
  const codeById = new Map(regions.map((r) => [r.id, r.code]));
  const region: FacetCount[] = regionIds.map((id) => ({
    value: codeById.get(id) ?? String(id),
    count: regionCount.get(id)!,
  }));

  status.sort((a, b) => b.count - a.count);
  region.sort((a, b) => b.count - a.count);
  return { status, region, approximate: baseSize > FACET_CAP };
}

/** Load full order DTOs for the given ids, preserving the id ordering. */
async function hydrateOrders(ids: number[]): Promise<OrderDTO[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.order.findMany({ where: { id: { in: ids } }, include: orderInclude });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is OrderWithRelations => r != null)
    .map(toOrderDTO);
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
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
    });
    publishOrderEvent({
      id: created.id,
      total: Number(created.total),
      customerId: created.customerId,
      placedAt: created.placedAt.toISOString(),
    }).catch(() => {});
    updateDailySummary(created.id).catch(() => {});
    return {
      id: created.id,
      status: created.status,
      total: Number(created.total),
      placedAt: created.placedAt.toISOString(),
    };
  } catch (err) {
    mapDbError(err, "createOrder");
  }
}
