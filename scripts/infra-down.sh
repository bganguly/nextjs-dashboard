#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform

cd "$INFRA_DIR"
terraform init -input=false
terraform destroy -auto-approve

rm -f "$ROOT_DIR/.env.rds"
echo "RDS + networking destroyed; .env.rds removed (billing stopped)."
