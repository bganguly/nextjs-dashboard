#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

START_TS="$(date +%s)"
DATABASE_URL="${DATABASE_URL:-$("$ROOT_DIR/scripts/database-url.sh")}"
export DATABASE_URL

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

phase() {
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
}

psql_retry() {
  local attempt max_attempts
  max_attempts="${PSQL_MAX_ATTEMPTS:-5}"
  attempt=1

  while true; do
    if psql "$DATABASE_URL" "$@"; then
      return 0
    fi

    if (( attempt >= max_attempts )); then
      return 1
    fi

    printf 'psql failed; retrying in 10s (%s/%s)...\n' "$attempt" "$max_attempts" >&2
    sleep 10
    attempt=$((attempt + 1))
  done
}

run_sql() {
  psql_retry -v ON_ERROR_STOP=1 "$@"
}

order_days() {
  psql_retry -Atqc 'SELECT DISTINCT "placedAt"::date FROM orders ORDER BY 1'
}

summary_days() {
  psql_retry -Atqc 'SELECT DISTINCT date FROM daily_customer_category_summary ORDER BY 1'
}

phase "Rebuilding dashboard read models from orders."

phase "Truncating read-model tables."
run_sql <<'SQL'
TRUNCATE
  daily_customer_token_order_summary,
  daily_customer_token_category_rollup,
  daily_customer_token_category_summary,
  daily_status_category_summary,
  daily_filter_category_summary,
  daily_customer_category_summary,
  order_category_facts,
  daily_summary
RESTART IDENTITY;
SQL

phase "daily_summary by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   daily_summary %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO daily_summary (
  date, "categoryId", "categoryName", "regionId", "regionCode",
  "totalOrders", "totalRevenue", "totalItems", "avgOrderValue", "createdAt", "updatedAt"
)
SELECT
  o."placedAt"::date,
  cat.id,
  cat.name,
  o."regionId",
  r.code,
  count(DISTINCT o.id)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
  coalesce(sum(oi.quantity), 0)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0) / greatest(count(DISTINCT o.id), 1),
  now(),
  now()
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
WHERE o."placedAt" >= :'work_day'::date
  AND o."placedAt" < :'work_day'::date + interval '1 day'
GROUP BY o."placedAt"::date, cat.id, cat.name, o."regionId", r.code;
SQL
done < <(order_days)

phase "order_category_facts by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   order_category_facts %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO order_category_facts (
  "orderId", "placedAt", date, "regionId", "regionCode", status, "orderTotal",
  "categoryId", "categoryName", "totalItems", "totalRevenue"
)
SELECT
  o.id,
  o."placedAt",
  o."placedAt"::date,
  o."regionId",
  r.code,
  o.status,
  o.total,
  cat.id,
  cat.name,
  coalesce(sum(oi.quantity), 0)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0)
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
WHERE o."placedAt" >= :'work_day'::date
  AND o."placedAt" < :'work_day'::date + interval '1 day'
GROUP BY o.id, o."placedAt", o."regionId", r.code, o.status, o.total, cat.id, cat.name;
SQL
done < <(order_days)

phase "daily_customer_category_summary by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   daily_customer_category_summary %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO daily_customer_category_summary (
  date, "customerId", "regionId", "regionCode", status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  o."placedAt"::date,
  o."customerId",
  o."regionId",
  r.code,
  o.status,
  cat.id,
  cat.name,
  count(DISTINCT o.id)::int,
  coalesce(sum(oi.quantity * oi."unitPrice" * (1 - oi.discount)), 0),
  coalesce(sum(oi.quantity), 0)::int,
  now(),
  now()
FROM orders o
JOIN order_items oi ON oi."orderId" = o.id
JOIN products p ON p.id = oi."productId"
JOIN categories cat ON cat.id = p."categoryId"
JOIN regions r ON r.id = o."regionId"
WHERE o."placedAt" >= :'work_day'::date
  AND o."placedAt" < :'work_day'::date + interval '1 day'
GROUP BY o."placedAt"::date, o."customerId", o."regionId", r.code, o.status, cat.id, cat.name;
SQL
done < <(order_days)

phase "daily_filter_category_summary by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   daily_filter_category_summary %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO daily_filter_category_summary (
  date, "regionId", "regionCode", status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  "regionId",
  "regionCode",
  status,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_customer_category_summary
WHERE date = :'work_day'::date
GROUP BY date, "regionId", "regionCode", status, "categoryId", "categoryName";
SQL
done < <(summary_days)

phase "daily_status_category_summary"
run_sql <<'SQL'
INSERT INTO daily_status_category_summary (
  date, status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  status,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_filter_category_summary
GROUP BY date, status, "categoryId", "categoryName";
SQL

phase "daily_customer_token_category_summary by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   daily_customer_token_category_summary %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO daily_customer_token_category_summary (
  date, token, "regionId", "regionCode", status, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  ds.date,
  t.token,
  ds."regionId",
  ds."regionCode",
  ds.status,
  ds."categoryId",
  ds."categoryName",
  sum(ds."totalOrders")::int,
  sum(ds."totalRevenue"),
  sum(ds."totalItems")::int,
  now(),
  now()
FROM daily_customer_category_summary ds
JOIN customers c ON c.id = ds."customerId"
CROSS JOIN LATERAL (
  SELECT DISTINCT token
  FROM unnest(ARRAY[
    lower(c."firstName"),
    lower(c."lastName"),
    lower(c.email),
    lower(split_part(c.email, '@', 1))
  ]) AS token
  WHERE token <> ''
) t
WHERE ds.date = :'work_day'::date
GROUP BY ds.date, t.token, ds."regionId", ds."regionCode", ds.status, ds."categoryId", ds."categoryName";
SQL
done < <(summary_days)

phase "daily_customer_token_category_rollup"
run_sql <<'SQL'
INSERT INTO daily_customer_token_category_rollup (
  date, token, "categoryId", "categoryName",
  "totalOrders", "totalRevenue", "totalItems", "createdAt", "updatedAt"
)
SELECT
  date,
  token,
  "categoryId",
  "categoryName",
  sum("totalOrders")::int,
  sum("totalRevenue"),
  sum("totalItems")::int,
  now(),
  now()
FROM daily_customer_token_category_summary
GROUP BY date, token, "categoryId", "categoryName";
SQL

phase "daily_customer_token_order_summary by day"
while IFS= read -r day; do
  [[ -z "$day" ]] && continue
  printf '[%s]   daily_customer_token_order_summary %s\n' "$(elapsed)" "$day"
  run_sql -v work_day="$day" <<'SQL'
INSERT INTO daily_customer_token_order_summary (
  date, token, "regionId", "regionCode", status,
  "totalOrders", "totalRevenue", "createdAt", "updatedAt"
)
SELECT
  o."placedAt"::date,
  t.token,
  o."regionId",
  r.code,
  o.status,
  count(*)::int,
  sum(o.total),
  now(),
  now()
FROM orders o
JOIN customers c ON c.id = o."customerId"
JOIN regions r ON r.id = o."regionId"
CROSS JOIN LATERAL (
  SELECT DISTINCT token
  FROM unnest(ARRAY[
    lower(c."firstName"),
    lower(c."lastName"),
    lower(c.email),
    lower(split_part(c.email, '@', 1))
  ]) AS token
  WHERE token <> ''
) t
WHERE o."placedAt" >= :'work_day'::date
  AND o."placedAt" < :'work_day'::date + interval '1 day'
GROUP BY o."placedAt"::date, t.token, o."regionId", r.code, o.status;
SQL
done < <(order_days)

phase "Read-model counts"
run_sql <<'SQL'
SELECT 'orders' AS table_name, count(*) FROM orders
UNION ALL SELECT 'daily_summary', count(*) FROM daily_summary
UNION ALL SELECT 'order_category_facts', count(*) FROM order_category_facts
UNION ALL SELECT 'daily_customer_category_summary', count(*) FROM daily_customer_category_summary
UNION ALL SELECT 'daily_filter_category_summary', count(*) FROM daily_filter_category_summary
UNION ALL SELECT 'daily_status_category_summary', count(*) FROM daily_status_category_summary
UNION ALL SELECT 'daily_customer_token_category_summary', count(*) FROM daily_customer_token_category_summary
UNION ALL SELECT 'daily_customer_token_category_rollup', count(*) FROM daily_customer_token_category_rollup
UNION ALL SELECT 'daily_customer_token_order_summary', count(*) FROM daily_customer_token_order_summary
ORDER BY table_name;
SQL

printf '\n[%s] Dashboard read models are rebuilt.\n' "$(elapsed)"
