export const DDL_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,

  `CREATE TABLE IF NOT EXISTS categories (
    category_id  INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,
    parent_id    INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS regions (
    region_id  INTEGER PRIMARY KEY,
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    country    TEXT NOT NULL,
    timezone   TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS customers (
    customer_id  BIGINT PRIMARY KEY,
    email        TEXT NOT NULL,
    first_name   TEXT NOT NULL,
    last_name    TEXT NOT NULL,
    phone        TEXT,
    region_id    INTEGER NOT NULL REFERENCES regions(region_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS products (
    product_id   INTEGER PRIMARY KEY,
    sku          TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    price        NUMERIC(10,2) NOT NULL,
    cost         NUMERIC(10,2) NOT NULL,
    stock        INTEGER NOT NULL DEFAULT 0,
    category_id  INTEGER NOT NULL REFERENCES categories(category_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS orders (
    order_id             BIGINT PRIMARY KEY,
    customer_id          BIGINT NOT NULL REFERENCES customers(customer_id),
    region_id            INTEGER NOT NULL REFERENCES regions(region_id),
    region_code          TEXT NOT NULL,
    customer_first_name  TEXT NOT NULL,
    customer_last_name   TEXT NOT NULL,
    customer_email       TEXT NOT NULL,
    status               TEXT NOT NULL,
    total                NUMERIC(12,2) NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'USD',
    notes                TEXT,
    search_text          TEXT NOT NULL DEFAULT '',
    placed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS order_items (
    item_id       BIGINT PRIMARY KEY,
    order_id      BIGINT NOT NULL REFERENCES orders(order_id),
    product_id    INTEGER NOT NULL,
    product_name  TEXT NOT NULL,
    product_sku   TEXT NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    unit_price    NUMERIC(10,2) NOT NULL,
    discount      NUMERIC(5,2) NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS orders_placed_at_idx ON orders (placed_at DESC, order_id DESC)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_search_text_trgm
   ON orders USING GIN (search_text gin_trgm_ops)`,
];

export async function runMigrations(): Promise<void> {
  const { execute } = await import("./db");
  for (const stmt of DDL_STATEMENTS) {
    await execute(stmt);
  }
}
