#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

START_TS="$(date +%s)"
DEMO_ORDER_COUNT="${DEMO_ORDER_COUNT:-4000000}"

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

step() {
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
  printf '    ETA: %s\n' "$2"
}

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
export DATABASE_URL

step "1/5 Applying Prisma schema." "< 1 min"
npx prisma db push

step "2/5 Applying dashboard SQL migrations and indexes." "1-10 min, depending on table size"
npx prisma migrate deploy

step "3/5 Checking demo order volume." "< 10 sec"
ORDER_COUNT="$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM orders")"
echo "Found $ORDER_COUNT order(s)."

if [[ "$ORDER_COUNT" == "0" ]]; then
  step "4/5 Seeding full demo data: $DEMO_ORDER_COUNT orders." "several minutes for millions of rows"
  psql "$DATABASE_URL" -v orders="$DEMO_ORDER_COUNT" -f "$ROOT_DIR/scripts/seed-large.sql"
else
  step "4/5 Full demo order data already present." "< 10 sec"
  echo "Keeping existing orders and rebuilding read models from them."
fi

step "5/5 Rebuilding dashboard read models from current orders." "minutes on a multi-million-row database"
psql "$DATABASE_URL" -f "$ROOT_DIR/scripts/rebuild-dashboard-read-models.sql"

printf '\n[%s] Demo data and dashboard read models are ready.\n' "$(elapsed)"
