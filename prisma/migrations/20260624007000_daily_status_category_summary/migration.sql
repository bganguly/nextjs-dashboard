CREATE TABLE IF NOT EXISTS "daily_status_category_summary" (
  "id" serial PRIMARY KEY,
  "date" date NOT NULL,
  "status" "OrderStatus" NOT NULL,
  "categoryId" integer NOT NULL,
  "categoryName" varchar(100) NOT NULL,
  "totalOrders" integer NOT NULL DEFAULT 0,
  "totalRevenue" numeric(14, 2) NOT NULL DEFAULT 0,
  "totalItems" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_status_category_summary_day_status_category_key"
  ON "daily_status_category_summary" ("date", "status", "categoryId");

CREATE INDEX IF NOT EXISTS "daily_status_category_summary_status_date_category_cover_idx"
  ON "daily_status_category_summary" (status, date, "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue");

INSERT INTO "daily_status_category_summary" (
  "date",
  "status",
  "categoryId",
  "categoryName",
  "totalOrders",
  "totalRevenue",
  "totalItems"
)
SELECT
  "date",
  "status",
  "categoryId",
  "categoryName",
  SUM("totalOrders")::integer,
  SUM("totalRevenue"),
  SUM("totalItems")::integer
FROM "daily_filter_category_summary"
GROUP BY
  "date",
  "status",
  "categoryId",
  "categoryName"
ON CONFLICT ("date", "status", "categoryId") DO UPDATE SET
  "categoryName" = EXCLUDED."categoryName",
  "totalOrders" = EXCLUDED."totalOrders",
  "totalRevenue" = EXCLUDED."totalRevenue",
  "totalItems" = EXCLUDED."totalItems",
  "updatedAt" = CURRENT_TIMESTAMP;
