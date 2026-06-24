-- Per-day, per-customer/category rollup for fast exact dashboard aggregates
-- when filtering by customer text, status, region, and date.
CREATE TABLE IF NOT EXISTS "daily_customer_category_summary" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "customerId" integer NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS "daily_customer_category_summary_day_customer_region_status_category_key"
  ON "daily_customer_category_summary" ("date", "customerId", "regionId", "status", "categoryId");

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_customer_date_idx"
  ON "daily_customer_category_summary" ("customerId", "date");

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_date_status_idx"
  ON "daily_customer_category_summary" ("date", "status");

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_date_region_idx"
  ON "daily_customer_category_summary" ("date", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_date_status_region_idx"
  ON "daily_customer_category_summary" ("date", "status", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_region_code_date_idx"
  ON "daily_customer_category_summary" ("regionCode", "date");
