#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
export DATABASE_URL

echo "Starting dashboard on http://localhost:3004"
npm run dev
