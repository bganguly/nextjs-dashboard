\set ON_ERROR_STOP on

\echo Rebuilding dashboard read models from orders...

TRUNCATE
  daily_customer_token_order_summary,
  daily_customer_token_category_rollup,
  daily_customer_token_category_summary,
  daily_status_category_summary,
  daily_filter_category_summary,
  daily_customer_category_summary,
  order_category_facts,
  daily_summary
RESTART IDENTITY;

\echo   daily_summary
INSERT INTO daily_summary (
  date, "categoryId", "categoryName", "regionId", "regionCode",
  "totalOrders", "totalRevenue", "totalItems", "avgOrderValue", "createdAt", "updatedAt"
)
SELECT
  o."placedAt"::date,
  cat.id,
  cat.name,
  o."regionId",
  r.code,
  count(DISTINCT o.id)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
  coalesce(sum(oi.quantity), 0)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) / greatest(count(DISTINCT o.id), 1),
  now(),
  now()
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code;

\echo   order_category_facts
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
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
GROUP BY o.id, o."placedAt", o."regionId", r.code, o.status, o.total, cat.id, cat.name;

\echo   daily_customer_category_summary
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
  count(DISTINCT o.id)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
  coalesce(sum(oi.quantity), 0)::int,
  now(),
  now()
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
GROUP BY o."placedAt"::date, o."customerId", o."regionId", r.code, o.status, cat.id, cat.name;

\echo   daily_filter_category_summary
INSERT INTO daily_filter_category_summary (
  date, "regionId", "regionCode", status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  "regionId",
  "regionCode",
  status,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_customer_category_summary
GROUP BY date, "regionId", "regionCode", status, "categoryId", "categoryName";

\echo   daily_status_category_summary
INSERT INTO daily_status_category_summary (
  date, status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  status,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_filter_category_summary
GROUP BY date, status, "categoryId", "categoryName";

\echo   daily_customer_token_category_summary
INSERT INTO daily_customer_token_category_summary (
  date, token, "regionId", "regionCode", status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  ds.date,
  t.token,
  ds."regionId",
  ds."regionCode",
  ds.status,
  ds."categoryId",
  ds."categoryName",
  sum(ds."totalOrders")::int,
  sum(ds."totalRevenue"),
  sum(ds."totalItems")::int,
  now(),
  now()
FROM daily_customer_category_summary ds
JOIN customers c ON c.id = ds."customerId"
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
GROUP BY ds.date, t.token, ds."regionId", ds."regionCode", ds.status, ds."categoryId", ds."categoryName";

\echo   daily_customer_token_category_rollup
INSERT INTO daily_customer_token_category_rollup (
  date, token, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  token,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_customer_token_category_summary
GROUP BY date, token, "categoryId", "categoryName";

\echo   daily_customer_token_order_summary
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
  count(*)::int,
  sum(o.total),
  now(),
  now()
FROM orders o
JOIN customers c ON c.id = o."customerId"
JOIN regions r ON r.id = o."regionId"
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
GROUP BY o."placedAt"::date, t.token, o."regionId", r.code, o.status;

\echo Read-model counts:
SELECT 'orders' AS table_name, count(*) FROM orders
UNION ALL SELECT 'daily_summary', count(*) FROM daily_summary
UNION ALL SELECT 'order_category_facts', count(*) FROM order_category_facts
UNION ALL SELECT 'daily_customer_category_summary', count(*) FROM daily_customer_category_summary
UNION ALL SELECT 'daily_filter_category_summary', count(*) FROM daily_filter_category_summary
UNION ALL SELECT 'daily_status_category_summary', count(*) FROM daily_status_category_summary
UNION ALL SELECT 'daily_customer_token_category_summary', count(*) FROM daily_customer_token_category_summary
UNION ALL SELECT 'daily_customer_token_category_rollup', count(*) FROM daily_customer_token_category_rollup
UNION ALL SELECT 'daily_customer_token_order_summary', count(*) FROM daily_customer_token_order_summary
ORDER BY table_name;
