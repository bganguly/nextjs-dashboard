-- Token-level daily rollup for fast customer keyword analytics.
-- Example: q=frank reads token='frank' rows for the selected date range instead
-- of joining every matching customer/order/item/category row live.
CREATE TABLE IF NOT EXISTS "daily_customer_token_category_summary" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "token" varchar(255) NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS "daily_customer_token_category_summary_day_token_region_status_category_key"
  ON "daily_customer_token_category_summary" ("date", "token", "regionId", "status", "categoryId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_token_date_idx"
  ON "daily_customer_token_category_summary" ("token", "date");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_token_date_status_idx"
  ON "daily_customer_token_category_summary" ("token", "date", "status");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_token_date_region_idx"
  ON "daily_customer_token_category_summary" ("token", "date", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_token_date_status_region_idx"
  ON "daily_customer_token_category_summary" ("token", "date", "status", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_token_region_code_date_idx"
  ON "daily_customer_token_category_summary" ("token", "regionCode", "date");
