-- Supports exact aggregate recomputation for customer keyword searches by
-- letting the planner fetch matching customers' orders inside a date range.
CREATE INDEX IF NOT EXISTS "orders_customer_placedAt_idx"
  ON "orders" ("customerId", "placedAt");
