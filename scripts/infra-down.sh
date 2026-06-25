#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
START_TS="$(date +%s)"
NAME_PREFIX="${TF_VAR_name_prefix:-dash-test}"
DB_INSTANCE_ID="${NAME_PREFIX}-db"
DB_SUBNET_GROUP="${NAME_PREFIX}-subnet-group"

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

step() {
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
  printf '    ETA: %s\n' "$2"
}

rds_instance_status() {
  aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text 2>/dev/null || true
}

delete_residual_rds_instance() {
  local status
  status="$(rds_instance_status)"
  if [[ -z "$status" || "$status" == "None" ]]; then
    echo "No residual RDS instance named $DB_INSTANCE_ID found."
    return
  fi

  if [[ "$status" != "deleting" ]]; then
    echo "Deleting residual RDS instance $DB_INSTANCE_ID (status: $status)."
    aws rds delete-db-instance \
      --db-instance-identifier "$DB_INSTANCE_ID" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null
  else
    echo "Residual RDS instance $DB_INSTANCE_ID is already deleting."
  fi

  echo "Waiting for residual RDS instance $DB_INSTANCE_ID to be deleted."
  aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID"
}

delete_residual_db_subnet_group() {
  if ! aws rds describe-db-subnet-groups \
    --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1; then
    echo "No residual RDS subnet group named $DB_SUBNET_GROUP found."
    return
  fi

  echo "Deleting residual RDS subnet group $DB_SUBNET_GROUP."
  aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP"
}

step "1/4 Checking local dependencies: terraform and aws CLI." "< 1 min"
"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform aws

cd "$INFRA_DIR"
step "2/4 Initializing Terraform providers/state." "< 1 min"
terraform init -input=false
step "3/4 Destroying Terraform-managed AWS infra: RDS, security group, subnets, route table, internet gateway, and VPC." "5-10 min when RDS exists; usually < 2 min when already absent"
terraform destroy -auto-approve

step "4/4 Clearing residual named RDS resources outside Terraform state." "5-10 min only if AWS still has an old RDS instance"
delete_residual_rds_instance
delete_residual_db_subnet_group

rm -f "$ROOT_DIR/.env.rds"
echo "RDS + networking destroyed or already absent; .env.rds removed (billing stopped)."
