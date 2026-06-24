#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.rds"
INFRA_DIR="$ROOT_DIR/infra"

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "$DATABASE_URL"
  exit 0
fi

if [[ -f "$ENV_FILE" ]]; then
  value="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  if [[ -n "$value" ]]; then
    echo "$value"
    exit 0
  fi
fi

if command -v terraform >/dev/null 2>&1 && [[ -d "$INFRA_DIR" ]]; then
  cd "$INFRA_DIR"
  if terraform output -raw database_url >/tmp/dashboard-database-url.$$ 2>/dev/null; then
    cat /tmp/dashboard-database-url.$$
    rm -f /tmp/dashboard-database-url.$$
    exit 0
  fi
  rm -f /tmp/dashboard-database-url.$$
fi

cat >&2 <<'MSG'
DATABASE_URL was not found.

Run:
  ./scripts/infra-up.sh

That creates or repairs the AWS RDS Postgres infra and writes .env.rds.
MSG
exit 1
