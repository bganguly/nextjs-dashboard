#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Resolve DATABASE_URL; if nothing is configured yet, bring the infra up once
# and retry so a fresh checkout "just works" without manual steps.
if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"; then
  echo "No database configured yet — running ./scripts/infra-up.sh to provision it." >&2
  "$ROOT_DIR/scripts/infra-up.sh"
  DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
fi
export DATABASE_URL

echo "Starting dashboard on http://localhost:3004"
npm run dev
