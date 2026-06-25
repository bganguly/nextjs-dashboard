-- Backfill exact chart aggregates for visible customer-name token searches with
-- status/region filters. Plain token searches can use the denormalized rollup,
-- but token + status/region needs the status/region-expanded summary.
INSERT INTO "daily_customer_token_category_summary" (
  "date",
  "token",
  "regionId",
  "regionCode",
  "status",
  "categoryId",
  "categoryName",
  "totalOrders",
  "totalRevenue",
  "totalItems",
  "createdAt",
  "updatedAt"
)
SELECT
  ds."date",
  t.token,
  ds."regionId",
  ds."regionCode",
  ds."status",
  ds."categoryId",
  ds."categoryName",
  SUM(ds."totalOrders")::integer,
  SUM(ds."totalRevenue"),
  SUM(ds."totalItems")::integer,
  now(),
  now()
FROM "daily_customer_category_summary" ds
JOIN customers c ON c.id = ds."customerId"
CROSS JOIN LATERAL (
  SELECT DISTINCT token
  FROM unnest(ARRAY[
    lower(c."firstName"),
    lower(c."lastName")
  ]) AS token
  WHERE token <> ''
) t
GROUP BY
  ds."date",
  t.token,
  ds."regionId",
  ds."regionCode",
  ds."status",
  ds."categoryId",
  ds."categoryName"
ON CONFLICT ("date", "token", "regionId", "status", "categoryId") DO UPDATE SET
  "regionCode" = EXCLUDED."regionCode",
  "categoryName" = EXCLUDED."categoryName",
  "totalOrders" = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems" = EXCLUDED."totalItems",
  "updatedAt" = now();

INSERT INTO "daily_customer_token_category_rollup" (
  "date",
  "token",
  "categoryId",
  "categoryName",
  "totalOrders",
  "totalRevenue",
  "totalItems",
  "createdAt",
  "updatedAt"
)
SELECT
  "date",
  "token",
  "categoryId",
  "categoryName",
  SUM("totalOrders")::integer,
  SUM("totalRevenue"),
  SUM("totalItems")::integer,
  now(),
  now()
FROM "daily_customer_token_category_summary"
GROUP BY "date", "token", "categoryId", "categoryName"
ON CONFLICT ("date", "token", "categoryId") DO UPDATE SET
  "categoryName" = EXCLUDED."categoryName",
  "totalOrders" = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems" = EXCLUDED."totalItems",
  "updatedAt" = now();
