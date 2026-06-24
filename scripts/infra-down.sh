#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
START_TS="$(date +%s)"

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

step() {
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
  printf '    ETA: %s\n' "$2"
}

step "1/3 Checking local dependency: terraform." "< 1 min"
"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform

cd "$INFRA_DIR"
step "2/3 Initializing Terraform providers/state." "< 1 min"
terraform init -input=false
step "3/3 Destroying AWS infra: RDS, security group, subnets, route table, internet gateway, and VPC." "5-10 min when RDS exists; usually < 2 min when already absent"
terraform destroy -auto-approve

rm -f "$ROOT_DIR/.env.rds"
echo "RDS + networking destroyed or already absent; .env.rds removed (billing stopped)."
