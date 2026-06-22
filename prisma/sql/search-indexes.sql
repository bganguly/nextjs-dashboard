-- Trigram (pg_trgm) GIN indexes for the /api/orders text search (?q=) —
-- CONCURRENT variant for applying to an already-populated, live database
-- without taking a write lock.
--
-- The migration prisma/migrations/.../migration.sql contains the same indexes
-- with plain CREATE INDEX (transaction-safe for `prisma migrate deploy`). Use
-- THIS file instead when adding the indexes to a large production table:
--
--   psql "$DIRECT_DATABASE_URL" -f prisma/sql/search-indexes.sql
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so do not
-- wrap this file in BEGIN/COMMIT. All statements are idempotent.
--
-- The combined customer index must match the search predicate in
-- lib/services/orders.service.ts exactly, or the planner will not use it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_customers_trgm" ON "customers"
  USING gin (("firstName" || ' ' || "lastName" || ' ' || email) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_notes_trgm" ON "orders"
  USING gin (notes gin_trgm_ops);
