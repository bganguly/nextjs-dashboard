CREATE TABLE IF NOT EXISTS "daily_filter_category_summary" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "regionId" integer NOT NULL,
  "regionCode" varchar(10) NOT NULL,
  "status" "OrderStatus" NOT NULL,
  "categoryId" integer NOT NULL,
  "categoryName" varchar(100) NOT NULL,
  "totalOrders" integer NOT NULL DEFAULT 0,
  "totalRevenue" numeric(14, 2) NOT NULL DEFAULT 0,
  "totalItems" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_filter_category_summary_day_region_status_category_key"
  ON "daily_filter_category_summary" ("date", "regionId", "status", "categoryId");

CREATE INDEX IF NOT EXISTS "daily_filter_category_summary_date_status_idx"
  ON "daily_filter_category_summary" ("date", "status");

CREATE INDEX IF NOT EXISTS "daily_filter_category_summary_date_status_region_idx"
  ON "daily_filter_category_summary" ("date", "status", "regionId");

CREATE INDEX IF NOT EXISTS "daily_filter_category_summary_region_code_date_status_idx"
  ON "daily_filter_category_summary" ("regionCode", "date", "status");

-- Ensure column exists with a default for tables pre-created by other migrations.
ALTER TABLE "daily_filter_category_summary"
  ADD COLUMN IF NOT EXISTS "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "daily_filter_category_summary"
  SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;

INSERT INTO "daily_filter_category_summary" (
  "date",
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
  "date",
  "regionId",
  "regionCode",
  "status",
  "categoryId",
  "categoryName",
  SUM("totalOrders")::integer,
  SUM("totalRevenue"),
  SUM("totalItems")::integer,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "daily_customer_category_summary"
GROUP BY
  "date",
  "regionId",
  "regionCode",
  "status",
  "categoryId",
  "categoryName"
ON CONFLICT ("date", "regionId", "status", "categoryId") DO UPDATE SET
  "regionCode" = EXCLUDED."regionCode",
  "categoryName" = EXCLUDED."categoryName",
  "totalOrders" = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems" = EXCLUDED."totalItems",
  "updatedAt" = CURRENT_TIMESTAMP;
