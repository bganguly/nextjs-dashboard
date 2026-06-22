-- Efficient bulk seed via generate_series (loads millions of rows in minutes).
-- Usage: psql "$DATABASE_URL" -v orders=4000000 -f scripts/seed-large.sql
-- `orders` MUST be passed with -v. Other volumes default below.
\set ON_ERROR_STOP on
\set customers 200000
\set products 5000
\set categories 200
\set regions 50
\set summary_days 30
\set summary_cats 10
\set summary_regions 10

\echo Truncating existing data...
TRUNCATE order_items, orders, daily_summary, products, customers, categories, regions RESTART IDENTITY CASCADE;

\echo Seeding regions / categories / products / customers...
INSERT INTO regions (code, name, country, timezone)
SELECT 'R' || g, 'Region ' || g, 'US', 'America/New_York'
FROM generate_series(1, :regions) g;

INSERT INTO categories (name, slug, "createdAt", "updatedAt")
SELECT 'Category ' || g, 'category-' || g, now(), now()
FROM generate_series(1, :categories) g;

INSERT INTO products (sku, name, price, cost, stock, "categoryId", "createdAt", "updatedAt")
SELECT 'SKU-' || g, 'Product ' || g,
       round((random() * 100 + 5)::numeric, 2),
       round((random() * 50 + 2)::numeric, 2),
       (random() * 500)::int,
       1 + floor(random() * :categories)::int, now(), now()
FROM generate_series(1, :products) g;

INSERT INTO customers (email, "firstName", "lastName", "regionId", "createdAt", "updatedAt")
SELECT 'customer' || g || '@example.com',
       (ARRAY['Ava','Liam','Maya','Noah','Sara','Omar','Ivy','Leo'])[1 + floor(random() * 8)],
       (ARRAY['Banks','Carter','Diaz','Evans','Frank','Gupta','Hale','Ito'])[1 + floor(random() * 8)],
       1 + floor(random() * :regions)::int, now(), now()
FROM generate_series(1, :customers) g;

\echo Seeding :orders orders (this is the big one)...
INSERT INTO orders ("customerId", "regionId", status, total, currency, notes, "placedAt", "updatedAt")
SELECT 1 + floor(random() * :customers)::int,
       1 + floor(random() * :regions)::int,
       (ARRAY['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED'])[1 + floor(random() * 7)]::"OrderStatus",
       round((random() * 500 + 10)::numeric, 2),
       'USD',
       'order ' || g,
       now() - (random() * 30 || ' days')::interval,
       now()
FROM generate_series(1, :orders) g;

\echo Seeding order_items (1 per order)...
INSERT INTO order_items ("orderId", "productId", quantity, "unitPrice", discount)
SELECT g, 1 + floor(random() * :products)::int,
       1 + floor(random() * 3)::int,
       round((random() * 100 + 5)::numeric, 2), 0
FROM generate_series(1, :orders) g;

\echo Seeding daily_summary (for the chart)...
INSERT INTO daily_summary (date, "categoryId", "categoryName", "regionId", "regionCode",
                           "totalOrders", "totalRevenue", "totalItems", "avgOrderValue", "createdAt", "updatedAt")
SELECT (current_date - d), c, 'Category ' || c, r, 'R' || r,
       (50 + random() * 200)::int,
       round((random() * 10000 + 500)::numeric, 2),
       (100 + random() * 400)::int,
       round((random() * 200 + 30)::numeric, 2),
       now(), now()
FROM generate_series(0, :summary_days - 1) d,
     generate_series(1, :summary_cats) c,
     generate_series(1, :summary_regions) r;

\echo Final counts:
SELECT 'orders' AS tbl, count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items
UNION ALL SELECT 'customers', count(*) FROM customers
UNION ALL SELECT 'daily_summary', count(*) FROM daily_summary;
