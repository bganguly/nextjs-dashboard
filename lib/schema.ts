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

  `CREATE INDEX IF NOT EXISTS customers_region_id_idx ON customers (region_id)`,
  `CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email)`,
  `CREATE INDEX IF NOT EXISTS customers_last_name_idx ON customers (last_name)`,

  `CREATE INDEX IF NOT EXISTS products_category_id_idx ON products (category_id)`,
  `CREATE INDEX IF NOT EXISTS products_sku_idx ON products (sku)`,

  `CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders (customer_id)`,
  `CREATE INDEX IF NOT EXISTS orders_customer_id_placed_at_idx ON orders (customer_id, placed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_region_id_idx ON orders (region_id)`,
  `CREATE INDEX IF NOT EXISTS orders_region_id_placed_at_idx ON orders (region_id, placed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`,
  `CREATE INDEX IF NOT EXISTS orders_status_placed_at_idx ON orders (status, placed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_status_region_id_placed_at_idx ON orders (status, region_id, placed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_total_idx ON orders (total)`,
  `CREATE INDEX IF NOT EXISTS orders_total_placed_at_idx ON orders (total, placed_at DESC)`,

  `CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id)`,
  `CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON order_items (product_id)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_search_text_trgm
   ON orders USING GIN (search_text gin_trgm_ops)`,

  `CREATE TABLE IF NOT EXISTS order_category_facts (
    order_id      BIGINT NOT NULL,
    placed_at     TIMESTAMPTZ NOT NULL,
    date          DATE NOT NULL,
    region_id     INTEGER,
    region_code   VARCHAR(10),
    status        TEXT,
    order_total   NUMERIC(12,2),
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_items   INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS ocf_order_id_idx ON order_category_facts (order_id)`,
  `CREATE INDEX IF NOT EXISTS ocf_date_idx ON order_category_facts (date)`,
  `CREATE INDEX IF NOT EXISTS ocf_date_order_total_idx ON order_category_facts (date, order_total)`,
  `CREATE INDEX IF NOT EXISTS ocf_date_order_total_category_name_idx ON order_category_facts (date, order_total, category_name)`,
  `CREATE INDEX IF NOT EXISTS ocf_status_date_order_total_idx ON order_category_facts (status, date, order_total)`,
  `CREATE INDEX IF NOT EXISTS ocf_status_date_order_total_category_name_idx ON order_category_facts (status, date, order_total, category_name)`,
  `CREATE INDEX IF NOT EXISTS ocf_region_code_date_status_order_total_idx ON order_category_facts (region_code, date, status, order_total)`,
  `CREATE INDEX IF NOT EXISTS ocf_region_code_status_date_order_total_category_name_idx ON order_category_facts (region_code, status, date, order_total, category_name)`,

  `CREATE TABLE IF NOT EXISTS order_events (
    id           BIGSERIAL PRIMARY KEY,
    order_id     BIGINT NOT NULL,
    processed_at TIMESTAMPTZ,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id)`,

  `CREATE TABLE IF NOT EXISTS daily_summary (
    id              BIGSERIAL PRIMARY KEY,
    date            DATE NOT NULL,
    category_id     INTEGER NOT NULL,
    category_name   VARCHAR(100) NOT NULL,
    region_id       INTEGER NOT NULL,
    region_code     VARCHAR(10) NOT NULL,
    total_orders    INTEGER NOT NULL DEFAULT 0,
    total_revenue   NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items     INTEGER NOT NULL DEFAULT 0,
    avg_order_value NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, category_id, region_id)
  )`,

  `CREATE INDEX IF NOT EXISTS daily_summary_date_idx ON daily_summary (date)`,
  `CREATE INDEX IF NOT EXISTS daily_summary_category_id_idx ON daily_summary (category_id)`,
  `CREATE INDEX IF NOT EXISTS daily_summary_region_id_idx ON daily_summary (region_id)`,
  `CREATE INDEX IF NOT EXISTS daily_summary_region_code_date_idx ON daily_summary (region_code, date)`,

  `CREATE TABLE IF NOT EXISTS daily_filter_category_summary (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    region_id     INTEGER NOT NULL,
    region_code   VARCHAR(10) NOT NULL,
    status        TEXT NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, region_id, status, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS dfcs_date_status_idx ON daily_filter_category_summary (date, status)`,
  `CREATE INDEX IF NOT EXISTS dfcs_status_date_category_name_idx ON daily_filter_category_summary (status, date, category_name)`,
  `CREATE INDEX IF NOT EXISTS dfcs_date_status_region_id_idx ON daily_filter_category_summary (date, status, region_id)`,
  `CREATE INDEX IF NOT EXISTS dfcs_region_code_status_date_category_name_idx ON daily_filter_category_summary (region_code, status, date, category_name)`,
  `CREATE INDEX IF NOT EXISTS dfcs_region_code_date_status_idx ON daily_filter_category_summary (region_code, date, status)`,

  `CREATE TABLE IF NOT EXISTS daily_status_category_summary (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    status        TEXT NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, status, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS dscs_status_date_category_name_idx ON daily_status_category_summary (status, date, category_name)`,

  `CREATE TABLE IF NOT EXISTS daily_customer_category_summary (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    customer_id   BIGINT NOT NULL,
    region_id     INTEGER NOT NULL,
    region_code   VARCHAR(10) NOT NULL,
    status        TEXT NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, customer_id, region_id, status, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS dccs_customer_id_date_idx ON daily_customer_category_summary (customer_id, date)`,
  `CREATE INDEX IF NOT EXISTS dccs_date_status_idx ON daily_customer_category_summary (date, status)`,
  `CREATE INDEX IF NOT EXISTS dccs_status_date_customer_id_category_name_idx ON daily_customer_category_summary (status, date, customer_id, category_name)`,
  `CREATE INDEX IF NOT EXISTS dccs_date_region_id_idx ON daily_customer_category_summary (date, region_id)`,
  `CREATE INDEX IF NOT EXISTS dccs_date_status_region_id_idx ON daily_customer_category_summary (date, status, region_id)`,
  `CREATE INDEX IF NOT EXISTS dccs_region_code_date_idx ON daily_customer_category_summary (region_code, date)`,
  `CREATE INDEX IF NOT EXISTS dccs_region_code_date_customer_id_category_name_idx ON daily_customer_category_summary (region_code, date, customer_id, category_name)`,
  `CREATE INDEX IF NOT EXISTS dccs_region_code_status_date_customer_id_category_name_idx ON daily_customer_category_summary (region_code, status, date, customer_id, category_name)`,

  `CREATE TABLE IF NOT EXISTS daily_customer_token_category_summary (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    token         VARCHAR(255) NOT NULL,
    region_id     INTEGER NOT NULL,
    region_code   VARCHAR(10) NOT NULL,
    status        TEXT NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, token, region_id, status, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS dctcs_token_date_idx ON daily_customer_token_category_summary (token, date)`,
  `CREATE INDEX IF NOT EXISTS dctcs_token_date_status_idx ON daily_customer_token_category_summary (token, date, status)`,
  `CREATE INDEX IF NOT EXISTS dctcs_token_date_region_id_idx ON daily_customer_token_category_summary (token, date, region_id)`,
  `CREATE INDEX IF NOT EXISTS dctcs_token_date_status_region_id_idx ON daily_customer_token_category_summary (token, date, status, region_id)`,
  `CREATE INDEX IF NOT EXISTS dctcs_token_region_code_date_idx ON daily_customer_token_category_summary (token, region_code, date)`,

  `CREATE TABLE IF NOT EXISTS daily_customer_token_category_rollup (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    token         VARCHAR(255) NOT NULL,
    category_id   INTEGER NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_items   INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, token, category_id)
  )`,

  `CREATE INDEX IF NOT EXISTS dctcr_token_date_idx ON daily_customer_token_category_rollup (token, date)`,

  `CREATE TABLE IF NOT EXISTS daily_customer_token_order_summary (
    id            BIGSERIAL PRIMARY KEY,
    date          DATE NOT NULL,
    token         VARCHAR(255) NOT NULL,
    region_id     INTEGER NOT NULL,
    region_code   VARCHAR(10) NOT NULL,
    status        TEXT NOT NULL,
    total_orders  INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (date, token, region_id, status)
  )`,

  `CREATE INDEX IF NOT EXISTS dctos_token_date_idx ON daily_customer_token_order_summary (token, date)`,
  `CREATE INDEX IF NOT EXISTS dctos_token_date_status_idx ON daily_customer_token_order_summary (token, date, status)`,
  `CREATE INDEX IF NOT EXISTS dctos_token_date_region_id_idx ON daily_customer_token_order_summary (token, date, region_id)`,
  `CREATE INDEX IF NOT EXISTS dctos_token_date_status_region_id_idx ON daily_customer_token_order_summary (token, date, status, region_id)`,
  `CREATE INDEX IF NOT EXISTS dctos_token_region_code_date_idx ON daily_customer_token_order_summary (token, region_code, date)`,

  `CREATE TABLE IF NOT EXISTS search_index (
    id          BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id   INTEGER NOT NULL,
    content     TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_type, entity_id)
  )`,

  `CREATE INDEX IF NOT EXISTS search_index_entity_type_idx ON search_index (entity_type)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id         VARCHAR(128) PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    data       JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id   INTEGER NOT NULL,
    action      VARCHAR(50) NOT NULL,
    actor_id    INTEGER,
    before      JSONB,
    after       JSONB,
    order_id    BIGINT REFERENCES orders(order_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS audit_log_entity_type_entity_id_idx ON audit_log (entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON audit_log (actor_id)`,
  `CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at)`,

  `CREATE TABLE IF NOT EXISTS daily_order_count (
    date         DATE PRIMARY KEY,
    total_orders INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS count_cache (
    cache_key TEXT PRIMARY KEY,
    total     BIGINT NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function runMigrations(): Promise<void> {
  const { execute } = await import("./db");
  for (const stmt of DDL_STATEMENTS) {
    await execute(stmt);
  }
}
