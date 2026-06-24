#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
export DATABASE_URL

echo "Preparing demo data and dashboard read models..."
"$ROOT_DIR/scripts/prepare-demo-data.sh"

echo "Starting dashboard on http://localhost:3004"
npm run dev
