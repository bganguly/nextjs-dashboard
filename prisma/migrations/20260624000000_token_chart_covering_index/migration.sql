-- Cover dense name-search chart queries from the token/category summary table.
-- This lets /api/aggregates?q=<name> group by date/category using an index-only
-- scan instead of fetching hundreds of thousands of heap rows.
CREATE INDEX IF NOT EXISTS "daily_customer_token_category_summary_chart_cover_idx"
  ON "daily_customer_token_category_summary" (token, date, "categoryName")
  INCLUDE ("totalOrders", "totalItems", "totalRevenue", status, "regionCode");
