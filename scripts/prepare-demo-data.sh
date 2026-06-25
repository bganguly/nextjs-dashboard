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
  psql_retry -Atqc "SELECT count(*) FROM $table"
}

print_summary() {
  local label="$1"
  printf '\n%s\n' "$label"
  psql_retry -P pager=off -x <<'SQL'
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

# Fast path: restore a pre-baked pg_dump snapshot from a PRIVATE S3 object
# instead of seeding + rebuilding from scratch. Returns 0 only on a successful
# restore; any missing config, missing credentials, or missing object returns 1
# so the caller falls back to the full seed path. A developer cloning from
# GitHub has no S3 access and always falls back — this is intentional.
restore_from_snapshot() {
  local s3_uri="${DEMO_SNAPSHOT_S3_URI:-}"
  [[ -n "$s3_uri" ]] || return 1

  command -v aws >/dev/null 2>&1 || { echo "aws CLI not found; skipping snapshot restore." >&2; return 1; }
  command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore not found; skipping snapshot restore." >&2; return 1; }

  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "No AWS credentials for this shell; skipping snapshot restore (will seed instead)." >&2
    return 1
  fi
  if ! aws s3 ls "$s3_uri" >/dev/null 2>&1; then
    echo "Snapshot $s3_uri not readable with current credentials; skipping (will seed instead)." >&2
    return 1
  fi

  local dump_file
  dump_file="$(mktemp -t dash-demo.XXXXXX.dump)"
  if ! aws s3 cp "$s3_uri" "$dump_file"; then
    echo "Failed to download $s3_uri; skipping (will seed instead)." >&2
    rm -f "$dump_file"
    return 1
  fi

  echo "Restoring snapshot with pg_restore (parallel)..."
  if ! pg_restore --no-owner --no-privileges --clean --if-exists \
      --jobs "${PG_RESTORE_JOBS:-4}" --dbname "$DATABASE_URL" "$dump_file"; then
    echo "pg_restore reported errors; falling back to full seed." >&2
    rm -f "$dump_file"
    return 1
  fi
  rm -f "$dump_file"
  return 0
}

apply_dashboard_sql_migrations() {
  local migration
  while IFS= read -r migration; do
    printf '    applying %s\n' "${migration#"$ROOT_DIR"/}"
    psql_retry -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
}

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

# Resolve DATABASE_URL; if nothing is configured yet, bring the infra up once
# and retry so this step works straight after a fresh checkout.
if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"; then
  echo "No database configured yet — running ./scripts/infra-up.sh to provision it." >&2
  "$ROOT_DIR/scripts/infra-up.sh"
  DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
fi
export DATABASE_URL

# If a pre-baked snapshot is configured and reachable, restore it and skip the
# whole seed + rebuild pipeline (minutes instead of ~15-20 min).
if restore_from_snapshot; then
  print_summary "Data and read-model summary after snapshot restore:"
  printf '\n[%s] Restored demo data from snapshot; dashboard read models are ready.\n' "$(elapsed)"
  exit 0
fi

step "1/5 Applying Prisma schema." "< 1 min"
npx prisma db push
step_done

step "2/5 Checking demo order volume." "< 10 sec"
ORDER_COUNT="$(table_count orders)"
echo "Found $ORDER_COUNT order(s)."
print_summary "Current data summary:"
step_done

if [[ "$ORDER_COUNT" == "0" ]]; then
  step "3/5 Seeding full demo data: $DEMO_ORDER_COUNT orders." "batched progress every $SEED_BATCH_SIZE rows on db.m5.xlarge"
  psql_retry \
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

step "5/5 Rebuilding dashboard read models from current orders." "batched by day with per-phase progress"
"$ROOT_DIR/scripts/rebuild-dashboard-read-models.sh"
print_summary "Final data and read-model summary:"
step_done

printf '\n[%s] Demo data and dashboard read models are ready.\n' "$(elapsed)"
