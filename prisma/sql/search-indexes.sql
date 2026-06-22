-- Trigram (pg_trgm) GIN indexes for the /api/orders text search (?q=).
--
-- The orders search filters with ILIKE '%q%' over customer first/last name,
-- customer email, and order notes. A plain B-tree cannot serve a leading-
-- wildcard ILIKE, so at 4M rows it degrades to a sequential scan. pg_trgm's
-- gin_trgm_ops supports ILIKE/LIKE with leading wildcards.
--
-- Prisma's `db push` / schema does not manage these (they need the pg_trgm
-- extension and a GIN access method), so apply this file once after pushing:
--
--   psql "$DIRECT_DATABASE_URL" -f prisma/sql/search-indexes.sql
--
-- All statements are idempotent and safe to re-run. CONCURRENTLY avoids locking
-- the tables while building the index on a live 4M-row database; it cannot run
-- inside a transaction block, so do not wrap this file in BEGIN/COMMIT.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS customers_first_name_trgm
  ON customers USING gin ("firstName" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS customers_last_name_trgm
  ON customers USING gin ("lastName" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS customers_email_trgm
  ON customers USING gin (email gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_notes_trgm
  ON orders USING gin (notes gin_trgm_ops);
