-- Indexes to keep /api/orders fast at ~4M rows: sort-by-total / sort-by-customer
-- and pg_trgm-backed text search.
--
-- NOTE: this migration uses plain (non-CONCURRENT) CREATE INDEX so it is
-- transaction-safe for `prisma migrate deploy`. On a large, live table the
-- non-concurrent build takes a brief write lock. To add these to an already-
-- populated production DB without locking, run prisma/sql/search-indexes.sql
-- (CREATE INDEX CONCURRENTLY) instead, outside a transaction.

-- B-tree indexes (also declared in schema.prisma via @@index).
CREATE INDEX IF NOT EXISTS "orders_total_idx" ON "orders" ("total");
CREATE INDEX IF NOT EXISTS "customers_lastName_idx" ON "customers" ("lastName");

-- Trigram search. ILIKE '%q%' cannot use a B-tree; pg_trgm's gin_trgm_ops can.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Combined index over the exact expression the orders search filters on
-- (customer first name + last name + email). The query MUST use this same
-- expression (see lib/services/orders.service.ts) for the index to apply.
CREATE INDEX IF NOT EXISTS "idx_customers_trgm" ON "customers"
  USING gin (("firstName" || ' ' || "lastName" || ' ' || email) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_orders_notes_trgm" ON "orders"
  USING gin (notes gin_trgm_ops);
