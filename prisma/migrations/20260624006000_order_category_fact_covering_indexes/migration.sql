CREATE INDEX IF NOT EXISTS "order_category_facts_date_total_category_cover_idx"
  ON "order_category_facts" ("date", "orderTotal", "categoryName")
  INCLUDE ("totalItems", "totalRevenue", status, "regionCode");

CREATE INDEX IF NOT EXISTS "order_category_facts_status_date_total_category_cover_idx"
  ON "order_category_facts" (status, "date", "orderTotal", "categoryName")
  INCLUDE ("totalItems", "totalRevenue", "regionCode");

CREATE INDEX IF NOT EXISTS "order_category_facts_region_status_date_total_category_cover_idx"
  ON "order_category_facts" ("regionCode", status, "date", "orderTotal", "categoryName")
  INCLUDE ("totalItems", "totalRevenue");
