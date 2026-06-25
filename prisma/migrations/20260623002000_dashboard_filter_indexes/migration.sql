-- Composite indexes for the dashboard's common filter combinations.
-- Single-column indexes exist, but 30-day filtered list/aggregate queries need
-- indexes that keep the date range close to status/region/total predicates.

CREATE INDEX IF NOT EXISTS "orders_status_placedAt_idx"
  ON "orders" ("status", "placedAt");

CREATE INDEX IF NOT EXISTS "orders_regionId_placedAt_idx"
  ON "orders" ("regionId", "placedAt");

CREATE INDEX IF NOT EXISTS "orders_status_regionId_placedAt_idx"
  ON "orders" ("status", "regionId", "placedAt");

CREATE INDEX IF NOT EXISTS "orders_total_placedAt_idx"
  ON "orders" ("total", "placedAt");

CREATE INDEX IF NOT EXISTS "daily_summary_regionCode_date_idx"
  ON "daily_summary" ("regionCode", "date");
