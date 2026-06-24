import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type { AggregateQueryInput, CategoryAggregate, DailyAggregate } from "@/lib/types";
import {
  buildFilterConditions,
  escapeLike,
  getNotesHaveMatches,
  getTextProbe,
  getTokenProbe,
  normalizeStatusList,
  resolveFilters,
} from "./orders.service";

const DEFAULT_TOP_CATEGORIES = 5;
const OTHER_BUCKET = "Others";
const AGG_TEXT_MATCH_CAP = 50_000;

interface AggRow {
  day: string;
  category: string;
  total_orders: bigint;
  total_items: bigint;
  total_revenue: Prisma.Decimal | string | number | null;
}

function canUseDailySummary(input: AggregateQueryInput): boolean {
  const noQ = !input.q || input.q.trim() === "";
  const noStatus = !input.status || input.status.trim() === "";
  const noMinTotal = input.minTotal == null;
  const noMaxTotal = input.maxTotal == null;
  return noQ && noStatus && noMinTotal && noMaxTotal;
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function searchToken(q: string | null | undefined): string | null {
  const token = q?.trim().toLowerCase();
  return token && /^[a-z0-9._@-]+$/.test(token) ? token : null;
}

export async function getDailyAggregates(input: AggregateQueryInput): Promise<DailyAggregate[]> {
  if (!input.from || !input.to) {
    throw new AppError("BAD_REQUEST", "from and to dates are required (YYYY-MM-DD)");
  }

  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  try {
    const rows = canUseDailySummary(input)
      ? await fastPath(input)
      : (await customerTokenSummaryPath(input)) ??
        ((await noTextMatches(input)) ? [] : null) ??
          (await noteOnlySummaryPath(input)) ??
          (await customerSummaryPath(input)) ??
          (await filterSummaryPath(input)) ??
          (await factFilterPath(input)) ??
          (await slowPath(input));
    return rowsToDailyAggregates(rows, topN);
  } catch (err) {
    mapDbError(err, "getDailyAggregates");
  }
}

async function noTextMatches(input: AggregateQueryInput): Promise<boolean> {
  const q = input.q?.trim();
  if (!q) return false;

  const probe = await getTextProbe(q);
  return probe.customerRows.length === 0 && !probe.notesHaveMatches;
}

async function noteOnlySummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q || input.minTotal != null || input.maxTotal != null) return null;

  const probe =
    /^\d+$/.test(q)
      ? {
          pattern: `%${escapeLike(q)}%`,
          customerRows: [],
          notesHaveMatches: await getNotesHaveMatches(q),
        }
      : await getTextProbe(q);
  if (probe.customerRows.length > 0 || !probe.notesHaveMatches) return null;

  const filters = await resolveFilters(input);
  const filterConds = buildFilterConditions(filters);
  const andFilters = filterConds.length
    ? Prisma.sql`AND ${Prisma.join(filterConds, " AND ")}`
    : Prisma.empty;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH matching_orders AS MATERIALIZED (
      SELECT o.id
      FROM orders o
      WHERE o.notes ILIKE ${probe.pattern}
      ${andFilters}
    )
    SELECT
      to_char(f.date, 'YYYY-MM-DD')           AS day,
      f."categoryName"                        AS category,
      count(*)::bigint                        AS total_orders,
      coalesce(sum(f."totalItems"), 0)::bigint AS total_items,
      coalesce(sum(f."totalRevenue"), 0)       AS total_revenue
    FROM matching_orders mo
    JOIN order_category_facts f ON f."orderId" = mo.id
    GROUP BY day, f."categoryName"
    ORDER BY day ASC, f."categoryName" ASC`);
}

async function customerTokenSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  if (input.minTotal != null || input.maxTotal != null) return null;
  const token = searchToken(input.q);
  if (!token) return null;
  const tokenProbe = await getTokenProbe(token);
  if (!tokenProbe.tokenOrderReady) return null;

  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);

  if (status.length === 0 && regionCodes.length === 0) {
    const rollupRows = await customerTokenRollupPath(input, token);
    if (rollupRows) return rollupRows;
  }

  const tokenReady = await prisma.$queryRaw<{ ready: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM daily_customer_token_category_summary
      WHERE token = ${token}
      LIMIT 1
    ) AS ready`);
  if (!tokenReady[0]?.ready) {
    return exactVisibleTokenCustomerSummaryPath(input, token, status, regionCodes);
  }

  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.token = ${token}`,
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD') AS day,
      ds."categoryName"              AS category,
      SUM(ds."totalOrders")::bigint  AS total_orders,
      SUM(ds."totalItems")::bigint   AS total_items,
      SUM(ds."totalRevenue")         AS total_revenue
    FROM daily_customer_token_category_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
  if (rows.length > 0) return rows;

  // If the order-level token summary says rows exist, an empty category summary
  // means the chart summary is incomplete rather than the filtered result being
  // empty. Fall back to the exact path so the UI never shows list rows with an
  // empty chart just because a read model is missing data.
  if (await tokenOrderSummaryHasMatches(input, token, status, regionCodes)) {
    return exactVisibleTokenCustomerSummaryPath(input, token, status, regionCodes);
  }
  return [];
}

async function tokenOrderSummaryHasMatches(
  input: AggregateQueryInput,
  token: string,
  status: string[],
  regionCodes: string[],
): Promise<boolean> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.token = ${token}`,
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);

  const rows = await prisma.$queryRaw<{ has_matches: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM daily_customer_token_order_summary ds
      WHERE ${Prisma.join(conds, " AND ")}
      LIMIT 1
    ) AS has_matches`);
  return Boolean(rows[0]?.has_matches);
}

async function exactVisibleTokenCustomerSummaryPath(
  input: AggregateQueryInput,
  token: string,
  status: string[],
  regionCodes: string[],
): Promise<AggRow[] | null> {
  const filteredConds: Prisma.Sql[] = [
    Prisma.sql`date >= ${input.from}::date`,
    Prisma.sql`date <= ${input.to}::date`,
  ];
  if (status.length) {
    filteredConds.push(Prisma.sql`status = ANY(${status}::text[]::"OrderStatus"[])`);
  }
  if (regionCodes.length) {
    filteredConds.push(Prisma.sql`"regionCode" = ANY(${regionCodes})`);
  }

  const filterWhere = Prisma.sql`WHERE ${Prisma.join(filteredConds, " AND ")}`;
  const rows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH filtered AS MATERIALIZED (
      SELECT date, "customerId", "categoryName", "totalOrders", "totalItems", "totalRevenue"
      FROM daily_customer_category_summary
      ${filterWhere}
    ),
    grouped AS (
      SELECT
        f.date                         AS date,
        f."categoryName"               AS category,
        SUM(f."totalOrders")::bigint   AS total_orders,
        SUM(f."totalItems")::bigint    AS total_items,
        SUM(f."totalRevenue")          AS total_revenue
      FROM filtered f
      JOIN customers c ON c.id = f."customerId"
      WHERE lower(c."firstName") = ${token}
         OR lower(c."lastName") = ${token}
      GROUP BY f.date, f."categoryName"
    )
    SELECT
      to_char(date, 'YYYY-MM-DD') AS day,
      category,
      total_orders,
      total_items,
      total_revenue
    FROM grouped
    ORDER BY date ASC, category ASC`);

  if (!(await getNotesHaveMatches(token))) return rows.length ? rows : null;

  const filters = await resolveFilters(input);
  const filterConds = buildFilterConditions(filters);
  const andFilters = filterConds.length
    ? Prisma.sql`AND ${Prisma.join(filterConds, " AND ")}`
    : Prisma.empty;
  const noteRows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH matching_orders AS MATERIALIZED (
      SELECT o.id
      FROM orders o
      JOIN customers c ON c.id = o."customerId"
      WHERE o.notes ILIKE ${`%${escapeLike(token)}%`}
        AND NOT (
          lower(c."firstName") = ${token}
          OR lower(c."lastName") = ${token}
        )
        ${andFilters}
    )
    SELECT
      to_char(f.date, 'YYYY-MM-DD')           AS day,
      f."categoryName"                        AS category,
      count(*)::bigint                        AS total_orders,
      coalesce(sum(f."totalItems"), 0)::bigint AS total_items,
      coalesce(sum(f."totalRevenue"), 0)       AS total_revenue
    FROM matching_orders mo
    JOIN order_category_facts f ON f."orderId" = mo.id
    GROUP BY day, f."categoryName"`);

  const merged = [...rows, ...noteRows];
  return merged.length ? merged : null;
}

async function customerTokenRollupPath(
  input: AggregateQueryInput,
  token: string,
): Promise<AggRow[] | null> {
  const topN =
    input.topCategories != null && input.topCategories > 0
      ? Math.trunc(input.topCategories)
      : DEFAULT_TOP_CATEGORIES;

  const [notesHaveMatches, rows] = await Promise.all([
    getNotesHaveMatches(token),
    prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH grouped AS (
      SELECT
        ds.date                       AS date,
        ds."categoryName"             AS category,
        SUM(ds."totalOrders")::bigint AS total_orders,
        SUM(ds."totalItems")::bigint  AS total_items,
        SUM(ds."totalRevenue")        AS total_revenue
      FROM daily_customer_token_category_rollup ds
      WHERE ds.token = ${token}
        AND ds.date >= ${input.from}::date
        AND ds.date <= ${input.to}::date
      GROUP BY ds.date, ds."categoryName"
    ),
    ranked AS (
      SELECT
        *,
        row_number() OVER (
          PARTITION BY date
          ORDER BY total_revenue DESC, category ASC
        ) AS rn
      FROM grouped
    ),
    bucketed AS (
      SELECT
        date,
        CASE WHEN rn <= ${topN} THEN category ELSE ${OTHER_BUCKET} END AS category,
        total_orders,
        total_items,
        total_revenue
      FROM ranked
    )
    SELECT
      to_char(date, 'YYYY-MM-DD') AS day,
      category,
      SUM(total_orders)::bigint   AS total_orders,
      SUM(total_items)::bigint    AS total_items,
      SUM(total_revenue)          AS total_revenue
    FROM bucketed
    GROUP BY date, category
    ORDER BY date ASC, category ASC`),
  ]);

  if (rows.length === 0) return null;
  if (!notesHaveMatches) return rows;

  const noteRows = await prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH matching_orders AS MATERIALIZED (
      SELECT o.id
      FROM orders o
      JOIN customers c ON c.id = o."customerId"
      WHERE o.notes ILIKE ${`%${escapeLike(token)}%`}
        AND NOT (
          lower(c."firstName") = ${token}
          OR lower(c."lastName") = ${token}
        )
        AND o."placedAt" >= ${input.from}::date
        AND o."placedAt" <= ${input.to}::date
    )
    SELECT
      to_char(f.date, 'YYYY-MM-DD')           AS day,
      f."categoryName"                        AS category,
      count(*)::bigint                        AS total_orders,
      coalesce(sum(f."totalItems"), 0)::bigint AS total_items,
      coalesce(sum(f."totalRevenue"), 0)       AS total_revenue
    FROM matching_orders mo
    JOIN order_category_facts f ON f."orderId" = mo.id
    GROUP BY day, f."categoryName"`);

  return [...rows, ...noteRows];
}

async function customerSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const q = input.q?.trim();
  if (!q || input.minTotal != null || input.maxTotal != null) return null;

  const probe = await getTextProbe(q);
  if (probe.notesHaveMatches) return null;

  const custRows =
    probe.customerRows.length > 5_000
      ? await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
          SELECT id FROM customers
          WHERE ("firstName" || ' ' || "lastName") ILIKE ${probe.pattern}
          LIMIT ${AGG_TEXT_MATCH_CAP + 1}`)
      : probe.customerRows;
  if (custRows.length === 0 || custRows.length > AGG_TEXT_MATCH_CAP) return null;

  const customerIds = custRows.map((r) => r.id);
  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);

  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
    Prisma.sql`ds."customerId" = ANY(${customerIds})`,
  ];
  if (status.length) conds.push(Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD') AS day,
      ds."categoryName"              AS category,
      SUM(ds."totalOrders")::bigint  AS total_orders,
      SUM(ds."totalItems")::bigint   AS total_items,
      SUM(ds."totalRevenue")         AS total_revenue
    FROM daily_customer_category_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

async function filterSummaryPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ || input.minTotal != null || input.maxTotal != null) return null;

  const status = normalizeStatusList(input.status);
  if (status.length === 0) return null;

  const regionCodes = parseCsv(input.regionCode);
  if (regionCodes.length === 0) {
    return prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT
        to_char(ds.date, 'YYYY-MM-DD') AS day,
        ds."categoryName"              AS category,
        SUM(ds."totalOrders")::bigint  AS total_orders,
        SUM(ds."totalItems")::bigint   AS total_items,
        SUM(ds."totalRevenue")         AS total_revenue
      FROM daily_status_category_summary ds
      WHERE ds.date >= ${input.from}::date
        AND ds.date <= ${input.to}::date
        AND ds.status = ANY(${status}::text[]::"OrderStatus"[])
      GROUP BY ds.date, ds."categoryName"
      ORDER BY ds.date ASC, ds."categoryName" ASC`);
  }

  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
    Prisma.sql`ds.status = ANY(${status}::text[]::"OrderStatus"[])`,
  ];
  if (regionCodes.length) {
    conds.push(Prisma.sql`ds."regionCode" = ANY(${regionCodes})`);
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD') AS day,
      ds."categoryName"              AS category,
      SUM(ds."totalOrders")::bigint  AS total_orders,
      SUM(ds."totalItems")::bigint   AS total_items,
      SUM(ds."totalRevenue")         AS total_revenue
    FROM daily_filter_category_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

async function factFilterPath(input: AggregateQueryInput): Promise<AggRow[] | null> {
  const noQ = !input.q || input.q.trim() === "";
  if (!noQ) return null;
  const hasTotalFilter = input.minTotal != null || input.maxTotal != null;
  if (!hasTotalFilter) return null;

  const status = normalizeStatusList(input.status);
  const regionCodes = parseCsv(input.regionCode);
  const conds: Prisma.Sql[] = [
    Prisma.sql`f.date >= ${input.from}::date`,
    Prisma.sql`f.date <= ${input.to}::date`,
  ];
  if (status.length) conds.push(Prisma.sql`f.status = ANY(${status}::text[]::"OrderStatus"[])`);
  if (regionCodes.length) conds.push(Prisma.sql`f."regionCode" = ANY(${regionCodes})`);
  if (input.minTotal != null) conds.push(Prisma.sql`f."orderTotal" >= ${input.minTotal}`);
  if (input.maxTotal != null) conds.push(Prisma.sql`f."orderTotal" <= ${input.maxTotal}`);

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(f.date, 'YYYY-MM-DD')           AS day,
      f."categoryName"                        AS category,
      count(*)::bigint                        AS total_orders,
      coalesce(sum(f."totalItems"), 0)::bigint AS total_items,
      coalesce(sum(f."totalRevenue"), 0)       AS total_revenue
    FROM order_category_facts f
    ${whereSql}
    GROUP BY f.date, f."categoryName"
    ORDER BY f.date ASC, f."categoryName" ASC`);
}

async function fastPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`ds.date >= ${input.from}::date`,
    Prisma.sql`ds.date <= ${input.to}::date`,
  ];

  if (input.regionCode) {
    const codes = input.regionCode
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (codes.length) {
      conds.push(Prisma.sql`ds."regionCode" = ANY(${codes})`);
    }
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    SELECT
      to_char(ds.date, 'YYYY-MM-DD')    AS day,
      ds."categoryName"                  AS category,
      SUM(ds."totalOrders")::bigint      AS total_orders,
      SUM(ds."totalItems")::bigint       AS total_items,
      SUM(ds."totalRevenue")             AS total_revenue
    FROM daily_summary ds
    ${whereSql}
    GROUP BY ds.date, ds."categoryName"
    ORDER BY ds.date ASC, ds."categoryName" ASC`);
}

async function slowPath(input: AggregateQueryInput): Promise<AggRow[]> {
  const filters = await resolveFilters(input);
  const conds = buildFilterConditions(filters);

  const whereSql = conds.length
    ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
    : Prisma.empty;
  const andFilters = conds.length
    ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}`
    : Prisma.empty;

  const q = input.q?.trim();
  let matchingOrders: Prisma.Sql;
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const custRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT id FROM customers
      WHERE ("firstName" || ' ' || "lastName") ILIKE ${pattern}
      LIMIT ${AGG_TEXT_MATCH_CAP + 1}`);

    if (custRows.length > AGG_TEXT_MATCH_CAP) {
      matchingOrders = Prisma.sql`
        SELECT o.id, o."placedAt"
        FROM orders o
        JOIN customers c ON c.id = o."customerId"
        WHERE ((c."firstName" || ' ' || c."lastName") ILIKE ${pattern}
          OR o.notes ILIKE ${pattern})
        ${andFilters}`;
    } else {
      const customerIds = custRows.map((r) => r.id);
      const customerMatches = customerIds.length
        ? Prisma.sql`
            SELECT o.id, o."placedAt"
            FROM unnest(${customerIds}::int[]) AS matched_customer(id)
            JOIN LATERAL (
              SELECT o.id, o."placedAt"
              FROM orders o
              WHERE o."customerId" = matched_customer.id
              ${andFilters}
            ) o ON true`
        : Prisma.sql`SELECT id, "placedAt" FROM orders WHERE false`;

      const denseCustomerSearch = customerIds.length > 5_000;
      matchingOrders =
        q.length >= 3 && !denseCustomerSearch
          ? Prisma.sql`
              ${customerMatches}
              UNION
              SELECT o.id, o."placedAt"
              FROM orders o
              WHERE o.notes ILIKE ${pattern}
              ${andFilters}`
          : customerMatches;
    }
  } else {
    matchingOrders = Prisma.sql`
      SELECT o.id, o."placedAt"
      FROM orders o
      ${whereSql}`;
  }

  return prisma.$queryRaw<AggRow[]>(Prisma.sql`
    WITH matching_orders AS MATERIALIZED (
      ${matchingOrders}
    )
    SELECT
      to_char(mo."placedAt", 'YYYY-MM-DD')                               AS day,
      cat.name                                                           AS category,
      count(DISTINCT mo.id)::bigint                                      AS total_orders,
      coalesce(sum(oi.quantity), 0)::bigint                              AS total_items,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) AS total_revenue
    FROM matching_orders mo
    JOIN order_items oi ON oi."orderId" = mo.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    GROUP BY day, cat.name
    ORDER BY day ASC, cat.name ASC`);
}

function rowsToDailyAggregates(rows: AggRow[], topN: number): DailyAggregate[] {
  const byDate = new Map<string, DailyAggregate>();
  for (const r of rows) {
    let entry = byDate.get(r.day);
    if (!entry) {
      entry = {
        date: r.day,
        categories: {},
        totals: { totalOrders: 0, totalRevenue: 0, totalItems: 0 },
      };
      byDate.set(r.day, entry);
    }

    const totalOrders = Number(r.total_orders);
    const totalRevenue = Number(r.total_revenue ?? 0);
    const totalItems = Number(r.total_items);
    const cat: CategoryAggregate = {
      totalOrders,
      totalRevenue,
      totalItems,
      avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    };
    entry.categories[r.category] = cat;
    entry.totals.totalOrders += totalOrders;
    entry.totals.totalRevenue += totalRevenue;
    entry.totals.totalItems += totalItems;
  }

  return Array.from(byDate.values()).map((day) => capToTopCategories(day, topN));
}

function capToTopCategories(day: DailyAggregate, topN: number): DailyAggregate {
  const entries = Object.entries(day.categories).sort(
    ([, a], [, b]) => b.totalRevenue - a.totalRevenue,
  );
  if (entries.length <= topN) return day;

  const top = entries.slice(0, topN);
  const rest = entries.slice(topN);

  const other = rest.reduce<CategoryAggregate>(
    (acc, [, c]) => ({
      totalOrders: acc.totalOrders + c.totalOrders,
      totalRevenue: acc.totalRevenue + c.totalRevenue,
      totalItems: acc.totalItems + c.totalItems,
      avgOrderValue: 0,
    }),
    { totalOrders: 0, totalRevenue: 0, totalItems: 0, avgOrderValue: 0 },
  );
  other.avgOrderValue = other.totalOrders > 0 ? other.totalRevenue / other.totalOrders : 0;

  const categories: Record<string, CategoryAggregate> = Object.fromEntries(top);
  categories[OTHER_BUCKET] = other;
  return { ...day, categories };
}

/**
 * Incrementally upsert daily_summary rows for a single order. Fire-and-forget
 * from createOrder so the summary stays in sync without a full backfill.
 */
export async function updateDailySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_summary (date, "categoryId", "categoryName", "regionId", "regionCode",
                               "totalOrders", "totalRevenue", "totalItems", "avgOrderValue",
                               "createdAt", "updatedAt")
    SELECT
      o."placedAt"::date,
      cat.id,
      cat.name,
      o."regionId",
      r.code,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code
    ON CONFLICT (date, "categoryId", "regionId")
    DO UPDATE SET
      "totalOrders"  = daily_summary."totalOrders" + 1,
      "totalRevenue" = daily_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_summary."totalItems" + EXCLUDED."totalItems",
      "avgOrderValue"= (daily_summary."totalRevenue" + EXCLUDED."totalRevenue")
                       / (daily_summary."totalOrders" + 1),
      "updatedAt"    = now()`);
}

export async function updateOrderCategoryFacts(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO order_category_facts (
      "orderId", "placedAt", date, "regionId", "regionCode", status, "orderTotal",
      "categoryId", "categoryName", "totalItems", "totalRevenue"
    )
    SELECT
      o.id,
      o."placedAt",
      o."placedAt"::date,
      o."regionId",
      r.code,
      o.status,
      o.total,
      cat.id,
      cat.name,
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o.id, o."placedAt", o."regionId", r.code, o.status, o.total, cat.id, cat.name
    ON CONFLICT ("orderId", "categoryId")
    DO UPDATE SET
      "placedAt" = EXCLUDED."placedAt",
      date = EXCLUDED.date,
      "regionId" = EXCLUDED."regionId",
      "regionCode" = EXCLUDED."regionCode",
      status = EXCLUDED.status,
      "orderTotal" = EXCLUDED."orderTotal",
      "categoryName" = EXCLUDED."categoryName",
      "totalItems" = EXCLUDED."totalItems",
      "totalRevenue" = EXCLUDED."totalRevenue"`);
}

export async function updateDailyCustomerCategorySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_category_summary (
      date, "customerId", "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o."customerId",
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o."customerId", o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, "customerId", "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyFilterCategorySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_filter_category_summary (
      date, "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_filter_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_filter_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_filter_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyStatusCategorySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_status_category_summary (
      date, status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, o.status, cat.id, cat.name
    ON CONFLICT (date, status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_status_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_status_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_status_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyCustomerTokenCategorySummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_token_category_summary (
      date, token, "regionId", "regionCode", status, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      t.token,
      o."regionId",
      r.code,
      o.status,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN customers c   ON c.id = o."customerId"
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    JOIN regions r      ON r.id = o."regionId"
    CROSS JOIN LATERAL (
      SELECT DISTINCT token
      FROM unnest(ARRAY[
        lower(c."firstName"),
        lower(c."lastName"),
        lower(c.email),
        lower(split_part(c.email, '@', 1))
      ]) AS token
      WHERE token <> ''
    ) t
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, t.token, o."regionId", r.code, o.status, cat.id, cat.name
    ON CONFLICT (date, token, "regionId", status, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_token_category_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_token_category_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_token_category_summary."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyCustomerTokenCategoryRollup(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_token_category_rollup (
      date, token, "categoryId", "categoryName",
      "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      t.token,
      cat.id,
      cat.name,
      1,
      coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
      coalesce(sum(oi.quantity), 0)::int,
      now(),
      now()
    FROM orders o
    JOIN customers c    ON c.id = o."customerId"
    JOIN order_items oi ON oi."orderId" = o.id
    JOIN products p     ON p.id = oi."productId"
    JOIN categories cat ON cat.id = p."categoryId"
    CROSS JOIN LATERAL (
      SELECT DISTINCT token
      FROM unnest(ARRAY[
        lower(c."firstName"),
        lower(c."lastName"),
        lower(c.email),
        lower(split_part(c.email, '@', 1))
      ]) AS token
      WHERE token <> ''
    ) t
    WHERE o.id = ${orderId}
    GROUP BY o."placedAt"::date, t.token, cat.id, cat.name
    ON CONFLICT (date, token, "categoryId")
    DO UPDATE SET
      "totalOrders"  = daily_customer_token_category_rollup."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_token_category_rollup."totalRevenue" + EXCLUDED."totalRevenue",
      "totalItems"   = daily_customer_token_category_rollup."totalItems" + EXCLUDED."totalItems",
      "updatedAt"    = now()`);
}

export async function updateDailyCustomerTokenOrderSummary(orderId: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO daily_customer_token_order_summary (
      date, token, "regionId", "regionCode", status,
      "totalOrders", "totalRevenue", "createdAt", "updatedAt"
    )
    SELECT
      o."placedAt"::date,
      t.token,
      o."regionId",
      r.code,
      o.status,
      1,
      o.total,
      now(),
      now()
    FROM orders o
    JOIN customers c ON c.id = o."customerId"
    JOIN regions r   ON r.id = o."regionId"
    CROSS JOIN LATERAL (
      SELECT DISTINCT token
      FROM unnest(ARRAY[
        lower(c."firstName"),
        lower(c."lastName"),
        lower(c.email),
        lower(split_part(c.email, '@', 1))
      ]) AS token
      WHERE token <> ''
    ) t
    WHERE o.id = ${orderId}
    ON CONFLICT (date, token, "regionId", status)
    DO UPDATE SET
      "totalOrders"  = daily_customer_token_order_summary."totalOrders" + EXCLUDED."totalOrders",
      "totalRevenue" = daily_customer_token_order_summary."totalRevenue" + EXCLUDED."totalRevenue",
      "updatedAt"    = now()`);
}
