CREATE INDEX IF NOT EXISTS "daily_customer_category_summary_status_date_customer_category_cover_idx"
  ON "daily_customer_category_summary" (status, date, "customerId", "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue", "regionCode");
