CREATE INDEX IF NOT EXISTS "daily_filter_category_summary_status_date_category_cover_idx"
  ON "daily_filter_category_summary" (status, date, "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue", "regionCode");

CREATE INDEX IF NOT EXISTS "daily_filter_category_summary_region_status_date_category_cover_idx"
  ON "daily_filter_category_summary" ("regionCode", status, date, "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue");
