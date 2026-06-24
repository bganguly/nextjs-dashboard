CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_region_date_customer_category_cover_idx"
  ON "daily_customer_category_summary" ("regionCode", date, "customerId", "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue", status);

CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_region_status_date_customer_category_cover_idx"
  ON "daily_customer_category_summary" ("regionCode", status, date, "customerId", "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue");
