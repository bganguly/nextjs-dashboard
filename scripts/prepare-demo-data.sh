#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

START_TS="$(date +%s)"
DEMO_ORDER_COUNT="${DEMO_ORDER_COUNT:-4000000}"
SEED_BATCH_SIZE="${SEED_BATCH_SIZE:-500000}"
STEP_TS="$START_TS"

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

step() {
  STEP_TS="$(date +%s)"
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
  printf '    ETA: %s\n' "$2"
}

step_done() {
  local now
  now="$(date +%s)"
  printf '    Done in %ss; total elapsed %s.\n' "$((now - STEP_TS))" "$(elapsed)"
}

table_count() {
  local table="$1"
  psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM $table"
}

print_summary() {
  local label="$1"
  printf '\n%s\n' "$label"
  psql "$DATABASE_URL" -P pager=off -x <<'SQL'
SELECT
  (SELECT count(*) FROM orders) AS orders,
  (SELECT count(*) FROM customers) AS customers,
  (SELECT count(*) FROM order_items) AS order_items,
  (SELECT count(*) FROM daily_summary) AS daily_summary,
  (SELECT count(*) FROM order_category_facts) AS order_category_facts,
  (SELECT count(*) FROM daily_customer_category_summary) AS daily_customer_category_summary,
  (SELECT count(*) FROM daily_customer_token_category_summary) AS daily_customer_token_category_summary,
  (SELECT count(*) FROM daily_customer_token_order_summary) AS daily_customer_token_order_summary;
SQL
}

apply_dashboard_sql_migrations() {
  local migration
  while IFS= read -r migration; do
    printf '    applying %s\n' "${migration#"$ROOT_DIR"/}"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
}

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
export DATABASE_URL

step "1/5 Applying Prisma schema." "< 1 min"
npx prisma db push
step_done

step "2/5 Checking demo order volume." "< 10 sec"
ORDER_COUNT="$(table_count orders)"
echo "Found $ORDER_COUNT order(s)."
print_summary "Current data summary:"
step_done

if [[ "$ORDER_COUNT" == "0" ]]; then
  step "3/5 Seeding full demo data: $DEMO_ORDER_COUNT orders." "~30 sec per 500k-row batch on db.m5.large; full prep usually ~12-20 min"
  psql "$DATABASE_URL" \
    -v orders="$DEMO_ORDER_COUNT" \
    -v batch_size="$SEED_BATCH_SIZE" \
    -f "$ROOT_DIR/scripts/seed-large.sql"
  print_summary "Data summary after seeding:"
else
  step "3/5 Full demo order data already present." "< 10 sec"
  echo "Keeping existing orders and rebuilding read models from them."
fi
step_done

step "4/5 Applying dashboard SQL migrations and indexes." "1-10 min, depending on table size"
apply_dashboard_sql_migrations
step_done

step "5/5 Rebuilding dashboard read models from current orders." "minutes on a multi-million-row database"
psql "$DATABASE_URL" -f "$ROOT_DIR/scripts/rebuild-dashboard-read-models.sql"
print_summary "Final data and read-model summary:"
step_done

printf '\n[%s] Demo data and dashboard read models are ready.\n' "$(elapsed)"
