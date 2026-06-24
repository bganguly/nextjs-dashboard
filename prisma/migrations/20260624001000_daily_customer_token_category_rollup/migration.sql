-- Pre-aggregated token/date/category chart table for plain name searches.
-- This avoids scanning region/status-expanded token summary rows when the chart
-- has no status or region filter.
CREATE TABLE IF NOT EXISTS "daily_customer_token_category_rollup" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "token" varchar(255) NOT NULL,
  "categoryId" integer NOT NULL,
  "categoryName" varchar(100) NOT NULL,
  "totalOrders" integer NOT NULL DEFAULT 0,
  "totalRevenue" numeric(14,2) NOT NULL DEFAULT 0,
  "totalItems" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_customer_token_category_rollup_day_token_category_key"
  ON "daily_customer_token_category_rollup" ("date", "token", "categoryId");

CREATE INDEX IF NOT EXISTS "daily_customer_token_category_rollup_token_date_idx"
  ON "daily_customer_token_category_rollup" ("token", "date");

INSERT INTO "daily_customer_token_category_rollup" (
  "date", "token", "categoryId", "categoryName", "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  "date",
  "token",
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM "daily_customer_token_category_summary"
GROUP BY "date", "token", "categoryId", "categoryName"
ON CONFLICT ("date", "token", "categoryId")
DO UPDATE SET
  "categoryName" = EXCLUDED."categoryName",
  "totalOrders" = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems" = EXCLUDED."totalItems",
  "updatedAt" = now();
