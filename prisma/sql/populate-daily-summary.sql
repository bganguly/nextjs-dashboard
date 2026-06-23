-- One-time backfill of daily_summary from the orders + order_items join.
-- Safe to re-run: upserts on the unique (date, categoryId, regionId) constraint.
-- On 4M orders this takes a few minutes; run during low-traffic window.

INSERT INTO daily_summary (date, "categoryId", "categoryName", "regionId", "regionCode",
                           "totalOrders", "totalRevenue", "totalItems", "avgOrderValue",
                           "createdAt", "updatedAt")
SELECT
  o."placedAt"::date                                           AS date,
  cat.id                                                       AS "categoryId",
  cat.name                                                     AS "categoryName",
  o."regionId"                                                 AS "regionId",
  r.code                                                       AS "regionCode",
  count(DISTINCT o.id)::int                                    AS "totalOrders",
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) AS "totalRevenue",
  coalesce(sum(oi.quantity), 0)::int                           AS "totalItems",
  CASE WHEN count(DISTINCT o.id) > 0
       THEN coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)
            / count(DISTINCT o.id)
       ELSE 0
  END                                                          AS "avgOrderValue",
  now()                                                        AS "createdAt",
  now()                                                        AS "updatedAt"
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p     ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r      ON r.id = o."regionId"
GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code
ON CONFLICT (date, "categoryId", "regionId")
DO UPDATE SET
  "totalOrders"  = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems"   = EXCLUDED."totalItems",
  "avgOrderValue"= EXCLUDED."avgOrderValue",
  "updatedAt"    = now();
