#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.rds"
INFRA_DIR="$ROOT_DIR/infra"

# Prisma's `postgresql` datasource and the raw `pg` driver both require a
# standard postgres URL. A leftover `prisma+postgres://` proxy URL (from
# `prisma dev` / Prisma Postgres) is the classic footgun: it sits in the shell
# environment, silently shadows the real RDS URL, and turns every query into a
# 500. Treat anything that isn't a postgres:// URL as not-a-URL so we fall
# through to .env.rds / terraform instead of trusting it.
is_standard_pg_url() {
  [[ "$1" =~ ^postgres(ql)?:// ]]
}

# Strip surrounding whitespace and any trailing CR (CRLF-edited .env.rds), then
# emit exactly one clean line so callers capturing $(...) never inherit blanks.
emit() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

# 1. An explicit, VALID override in the environment wins. A wrong-scheme value
#    is reported and ignored rather than allowed to shadow the real URL.
if [[ -n "${DATABASE_URL:-}" ]]; then
  if is_standard_pg_url "$DATABASE_URL"; then
    emit "$DATABASE_URL"
    exit 0
  fi
  printf 'database-url.sh: ignoring DATABASE_URL=%q — not a postgresql:// URL; falling back to .env.rds.\n' \
    "$DATABASE_URL" >&2
fi

# 2. The URL written by scripts/infra-up.sh.
if [[ -f "$ENV_FILE" ]]; then
  value="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  if [[ -n "$value" ]] && is_standard_pg_url "$value"; then
    emit "$value"
    exit 0
  fi
fi

# 3. Straight from terraform outputs.
if command -v terraform >/dev/null 2>&1 && [[ -d "$INFRA_DIR" ]]; then
  cd "$INFRA_DIR"
  if terraform output -raw database_url >/tmp/dashboard-database-url.$$ 2>/dev/null; then
    value="$(cat /tmp/dashboard-database-url.$$)"
    rm -f /tmp/dashboard-database-url.$$
    if is_standard_pg_url "$value"; then
      emit "$value"
      exit 0
    fi
  fi
  rm -f /tmp/dashboard-database-url.$$
fi

cat >&2 <<'MSG'
DATABASE_URL was not found (or every candidate had a non-postgresql:// scheme).

Run:
  ./scripts/infra-up.sh

That creates or repairs the AWS RDS Postgres infra and writes .env.rds.
MSG
exit 1
