-- Token-level daily order-count rollup for exact list pagination totals.
-- This is separate from the category rollup so list totals count each order
-- once, even if an order has items in multiple categories.
CREATE TABLE IF NOT EXISTS "daily_customer_token_order_summary" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "token" varchar(255) NOT NULL,
  "regionId" integer NOT NULL,
  "regionCode" varchar(10) NOT NULL,
  "status" "OrderStatus" NOT NULL,
  "totalOrders" integer NOT NULL DEFAULT 0,
  "totalRevenue" numeric(14, 2) NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_customer_token_order_summary_day_token_region_status_key"
  ON "daily_customer_token_order_summary" ("date", "token", "regionId", "status");

CREATE INDEX IF NOT EXISTS "daily_customer_token_order_summary_token_date_idx"
  ON "daily_customer_token_order_summary" ("token", "date");

CREATE INDEX IF NOT EXISTS "daily_customer_token_order_summary_token_date_status_idx"
  ON "daily_customer_token_order_summary" ("token", "date", "status");

CREATE INDEX IF NOT EXISTS "daily_customer_token_order_summary_token_date_region_idx"
  ON "daily_customer_token_order_summary" ("token", "date", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_order_summary_token_date_status_region_idx"
  ON "daily_customer_token_order_summary" ("token", "date", "status", "regionId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_order_summary_token_region_code_date_idx"
  ON "daily_customer_token_order_summary" ("token", "regionCode", "date");
