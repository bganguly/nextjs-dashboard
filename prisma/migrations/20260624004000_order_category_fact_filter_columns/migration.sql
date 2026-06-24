ALTER TABLE "order_category_facts"
  ADD COLUMN IF NOT EXISTS "regionId" integer,
  ADD COLUMN IF NOT EXISTS "regionCode" varchar(10),
  ADD COLUMN IF NOT EXISTS "status" "OrderStatus",
  ADD COLUMN IF NOT EXISTS "orderTotal" numeric(12, 2);

UPDATE "order_category_facts" f
SET
  "regionId" = o."regionId",
  "regionCode" = r.code,
  "status" = o.status,
  "orderTotal" = o.total
FROM orders o
JOIN regions r ON r.id = o."regionId"
WHERE o.id = f."orderId"
  AND (
    f."regionId" IS NULL
    OR f."regionCode" IS NULL
    OR f."status" IS NULL
    OR f."orderTotal" IS NULL
  );

CREATE INDEX IF NOT EXISTS "order_category_facts_date_total_idx"
  ON "order_category_facts" ("date", "orderTotal");

CREATE INDEX IF NOT EXISTS "order_category_facts_status_date_total_idx"
  ON "order_category_facts" ("status", "date", "orderTotal");

CREATE INDEX IF NOT EXISTS "order_category_facts_region_code_date_status_total_idx"
  ON "order_category_facts" ("regionCode", "date", "status", "orderTotal");
