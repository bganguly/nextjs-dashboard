-- Per-order category facts used by visible text/note/id searches to build chart
-- aggregates without joining order_items/products/categories at request time.
CREATE TABLE IF NOT EXISTS "order_category_facts" (
  "orderId" integer NOT NULL,
  "placedAt" timestamp(3) NOT NULL,
  "date" date NOT NULL,
  "categoryId" integer NOT NULL,
  "categoryName" varchar(100) NOT NULL,
  "totalItems" integer NOT NULL DEFAULT 0,
  "totalRevenue" numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY ("orderId", "categoryId")
);

CREATE INDEX IF NOT EXISTS "order_category_facts_order_id_idx"
  ON "order_category_facts" ("orderId");

CREATE INDEX IF NOT EXISTS "order_category_facts_date_idx"
  ON "order_category_facts" ("date");

INSERT INTO "order_category_facts" (
  "orderId", "placedAt", "date", "categoryId", "categoryName", "totalItems", "totalRevenue"
)
SELECT
  o.id,
  o."placedAt",
  o."placedAt"::date,
  cat.id,
  cat.name,
  coalesce(sum(oi.quantity), 0)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)
FROM "orders" o
JOIN "order_items" oi ON oi."orderId" = o.id
JOIN "products" p ON p.id = oi."productId"
JOIN "categories" cat ON cat.id = p."categoryId"
GROUP BY o.id, o."placedAt", cat.id, cat.name
ON CONFLICT ("orderId", "categoryId")
DO UPDATE SET
  "placedAt" = EXCLUDED."placedAt",
  "date" = EXCLUDED."date",
  "categoryName" = EXCLUDED."categoryName",
  "totalItems" = EXCLUDED."totalItems",
  "totalRevenue" = EXCLUDED."totalRevenue";
