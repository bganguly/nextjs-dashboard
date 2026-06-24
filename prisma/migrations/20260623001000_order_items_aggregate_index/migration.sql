-- Supports exact chart aggregates from a filtered order-id set without reading
-- the entire order_items table.
CREATE INDEX IF NOT EXISTS "order_items_orderId_aggregate_idx"
  ON "order_items" ("orderId") INCLUDE ("productId", quantity, "unitPrice", discount);
