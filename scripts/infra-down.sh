#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
START_TS="$(date +%s)"

elapsed() { local now; now="$(date +%s)"; printf '%ss' "$((now - START_TS))"; }
step()    { printf '\n[%s] %s\n    ETA: %s\n' "$(elapsed)" "$1" "$2"; }

# ── Detect independent workspace state ───────────────────────────────────────
_local_running=0
_lite_count=0
_full_count=0

if lsof -ti:3004 >/dev/null 2>&1 || [[ -f "$ROOT_DIR/scripts/aggregates-worker.pid" ]]; then
  _local_running=1
fi

_tf_ws_count() {
  local state_file="$INFRA_DIR/terraform.tfstate.d/$1/terraform.tfstate"
  [[ -f "$state_file" ]] || { printf '0'; return; }
  python3 -c "import json; d=json.load(open('$state_file')); print(sum(len(r.get('instances',[])) for r in d.get('resources',[])))" 2>/dev/null || printf '0'
}
_lite_count=$(_tf_ws_count lite)
_full_count=$(_tf_ws_count full)

# ── Show menu with detected state ────────────────────────────────────────────
printf '\n=== nextjs-dashboard teardown ===\n\n'
printf '  [1] Local  — stop local dev server'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Lite   — destroy AWS lite (EC2 t3.micro + RDS db.t3.micro)'
(( _lite_count > 0 )) && printf ' [%s resources active]' "$_lite_count" || printf ' [not deployed]'
printf '\n'
printf '  [3] Full   — destroy AWS full (EC2 t3.small + RDS db.t3.large)'
(( _full_count > 0 )) && printf ' [%s resources active]' "$_full_count" || printf ' [not deployed]'
printf '\n'
printf '\nChoice [1/2/3]: '
read -r _MODE
case "$_MODE" in
  2) _TARGET="remote"; _WORKSPACE="lite" ;;
  3) _TARGET="remote"; _WORKSPACE="full" ;;
  *) _TARGET="local"  ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# LOCAL
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$_TARGET" == "local" ]]; then
  if lsof -ti:3004 >/dev/null 2>&1; then
    printf '\nStopping Next.js on :3004...\n'
    kill "$(lsof -ti:3004)" 2>/dev/null || true
  fi
  "$ROOT_DIR/scripts/stop-aggregates-worker.sh" 2>/dev/null || true
  printf 'Local processes stopped.\n'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# REMOTE (AWS)
# ══════════════════════════════════════════════════════════════════════════════
_WORKSPACE="${_WORKSPACE:-full}"
case "$_WORKSPACE" in
  lite) NAME_PREFIX="dash-lite" ;;
  *)    NAME_PREFIX="dash-full" ;;
esac
DB_INSTANCE_ID="${NAME_PREFIX}-db"
DB_SUBNET_GROUP="${NAME_PREFIX}-subnet-group"
TF_VAR_name_prefix="$NAME_PREFIX"
DEPLOY_WORKSPACE="$_WORKSPACE"

_P_EC2_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${TF_VAR_name_prefix}-app" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text 2>/dev/null | grep -v '^None$' | grep -v '^$' || true)
_P_EC2_STATE="not deployed"
if [[ -n "$_P_EC2_ID" ]]; then
  _P_EC2_STATE=$(aws ec2 describe-instances --instance-ids "$_P_EC2_ID" \
    --query "Reservations[0].Instances[0].State.Name" \
    --output text 2>/dev/null || echo "unknown")
fi
_P_RDS_STATE=$(aws rds describe-db-instances \
  --db-instance-identifier "${TF_VAR_name_prefix}-db" \
  --query "DBInstances[0].DBInstanceStatus" \
  --output text 2>/dev/null || echo "not deployed")
_SCHED_UP_STATE=$(aws scheduler get-schedule \
  --name "${TF_VAR_name_prefix}-start-ec2" \
  --query "State" --output text 2>/dev/null || echo "NOT_CREATED")

_update_schedules() {
  local _state="$1" _sched _cur _expr _tz _tgt
  for _sched in "${TF_VAR_name_prefix}-start-ec2" \
                "${TF_VAR_name_prefix}-stop-ec2"; do
    if ! _cur=$(aws scheduler get-schedule --name "$_sched" --output json 2>/dev/null); then
      printf '  (schedule %s not found — run a full deploy first)\n' "$_sched"
      continue
    fi
    _expr=$(printf '%s' "$_cur" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['ScheduleExpression'])" 2>/dev/null || true)
    _tz=$(printf '%s' "$_cur" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ScheduleExpressionTimezone','America/Los_Angeles'))" 2>/dev/null || echo "America/Los_Angeles")
    _tgt=$(printf '%s' "$_cur" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d['Target']))" 2>/dev/null || true)
    if [[ -z "$_expr" || -z "$_tgt" ]]; then
      printf '  ERROR: could not parse schedule %s\n' "$_sched"
      continue
    fi
    if aws scheduler update-schedule \
        --name "$_sched" \
        --state "$_state" \
        --schedule-expression "$_expr" \
        --schedule-expression-timezone "$_tz" \
        --flexible-time-window '{"Mode":"OFF"}' \
        --target "$_tgt" \
        --no-cli-pager >/dev/null 2>&1; then
      printf '  %-45s → %s\n' "$_sched" "$_state"
    else
      printf '  ERROR: failed to update %s\n' "$_sched"
    fi
  done
}

printf '\n  EC2: %-12s  RDS: %s\n' "$_P_EC2_STATE" "$_P_RDS_STATE"
printf '  Auto-schedule: starts 8 am \xc2\xb7 stops 5 pm \xc2\xb7 weekdays Pacific \xc2\xb7 state=%s\n' "$_SCHED_UP_STATE"
printf '  [1] Start now  [2] Stop now  [3] Suspend schedule  [4] Resume schedule  [enter] Tear down: '
read -r _PRE_ACTION
case "${_PRE_ACTION:-}" in
  1)
    if [[ -n "$_P_EC2_ID" ]]; then
      if [[ "$_P_EC2_STATE" == "running" ]]; then
        printf '  EC2 is already running — triggering app startup via SSM...\n'
        aws ssm send-command \
          --instance-ids "$_P_EC2_ID" \
          --document-name "AWS-RunShellScript" \
          --parameters '{"commands":["bash /app/scripts/app-startup.sh"],"executionTimeout":["120"]}' \
          --no-cli-pager >/dev/null 2>&1 \
          && printf '  SSM command sent.\n' \
          || printf '  SSM send failed — run app-startup.sh manually via SSH.\n'
      else
        printf '  Starting EC2 (%s)...\n' "$_P_EC2_ID"
        aws ec2 start-instances --instance-ids "$_P_EC2_ID" --no-cli-pager >/dev/null
      fi
    else
      printf '  EC2 not found — nothing to start (deploy first).\n'
    fi
    exit 0
    ;;
  2)
    if [[ -n "$_P_EC2_ID" ]]; then
      printf '  Stopping EC2 (%s)...\n' "$_P_EC2_ID"
      aws ec2 stop-instances --instance-ids "$_P_EC2_ID" --no-cli-pager >/dev/null
      printf '  Stopped — EBS storage still billed; no EC2 compute charges. RDS continues running.\n'
    else
      printf '  EC2 not found — nothing to stop.\n'
    fi
    exit 0
    ;;
  3)
    if [[ "$_SCHED_UP_STATE" == "NOT_CREATED" ]]; then
      printf '  Scheduler jobs not yet created \xe2\x80\x94 run a full deploy first.\n'; exit 1
    fi
    if [[ "$_SCHED_UP_STATE" == "DISABLED" ]]; then
      printf '  Schedule is already DISABLED \xe2\x80\x94 nothing to do.\n'; exit 0
    fi
    if [[ "$_P_EC2_STATE" != "stopped" ]]; then
      printf '  EC2 (%s) still running — stop it too? [y/N] ' "$_P_EC2_STATE"
      read -r _STOP_TOO
      if [[ "$_STOP_TOO" =~ ^[Yy]$ ]]; then
        [[ -n "$_P_EC2_ID" ]] && aws ec2 stop-instances --instance-ids "$_P_EC2_ID" --no-cli-pager >/dev/null || true
        printf '  Stop initiated. RDS continues running.\n'
      fi
    fi
    _update_schedules "DISABLED"
    printf '  Schedule suspended.\n'
    exit 0
    ;;
  4)
    if [[ "$_SCHED_UP_STATE" == "NOT_CREATED" ]]; then
      printf '  Scheduler jobs not yet created \xe2\x80\x94 run a full deploy first.\n'; exit 1
    fi
    if [[ "$_SCHED_UP_STATE" == "ENABLED" ]]; then
      printf '  Schedule is already ENABLED \xe2\x80\x94 nothing to do.\n'; exit 0
    fi
    _update_schedules "ENABLED"
    printf '  Schedule resumed \xe2\x80\x94 EC2 will start at next 8 am weekday run. RDS runs 24/7.\n'
    exit 0
    ;;
esac

_ws_count_var="_${_WORKSPACE}_count"
if (( ${!_ws_count_var} == 0 )); then
  printf '\nNo Terraform state found for workspace "%s" — nothing to destroy.\n' "$_WORKSPACE"
  exit 0
fi

step "1/4 Checking dependencies: terraform and aws CLI." "< 1 min"
"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform aws

cd "$INFRA_DIR"

if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
  for _candidate in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub ~/.ssh/id_ecdsa.pub; do
    if [[ -f "$(eval echo "$_candidate")" ]]; then
      export TF_VAR_ssh_public_key_path="$_candidate"
      break
    fi
  done
  if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
    _tmp_key="$(mktemp)"
    ssh-keygen -t ed25519 -N "" -f "$_tmp_key" -q
    export TF_VAR_ssh_public_key_path="${_tmp_key}.pub"
    _cleanup_tmp_key=1
  fi
fi

step "2/4 Initializing Terraform." "< 1 min"
terraform init -input=false
terraform workspace select "$_WORKSPACE" 2>/dev/null \
  || terraform workspace new "$_WORKSPACE" 2>/dev/null \
  || terraform workspace select "$_WORKSPACE"
printf '    workspace: %s\n' "$_WORKSPACE"

step "3/4 Destroying AWS infra: EC2, RDS, VPC, networking." "5-10 min when resources exist; < 2 min if already absent"
terraform destroy -auto-approve

[[ -n "${_cleanup_tmp_key:-}" ]] && rm -f "$_tmp_key" "${_tmp_key}.pub" || true

step "4/4 Clearing any residual RDS resources outside Terraform state." "5-10 min only if stale RDS instance exists"
_rds_status="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || true)"
if [[ -n "$_rds_status" && "$_rds_status" != "None" ]]; then
  if [[ "$_rds_status" != "deleting" ]]; then
    echo "Deleting residual RDS instance $DB_INSTANCE_ID (status: $_rds_status)."
    aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" \
      --skip-final-snapshot --delete-automated-backups >/dev/null
  fi
  echo "Waiting for $DB_INSTANCE_ID to be deleted..."
  aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID"
fi

if aws rds describe-db-subnet-groups --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1; then
  echo "Deleting residual RDS subnet group $DB_SUBNET_GROUP."
  aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP"
fi

rm -f "$ROOT_DIR/.env.rds"
printf '\n[%s] AWS infra destroyed; .env.rds removed (billing stopped).\n' "$(elapsed)"

QUICKORDER_DIR="$(cd "$ROOT_DIR/../websockets-quickorder" 2>/dev/null && pwd || true)"
QUICKORDER_DOWN="${QUICKORDER_DIR}/scripts/infra-down.sh"
if [[ -f "$QUICKORDER_DOWN" ]]; then
  printf '\n  Chaining Quick Order (%s) teardown...\n' "$_WORKSPACE"
  DEPLOY_MODE="$_WORKSPACE" bash "$QUICKORDER_DOWN"
fi

PORTFOLIO_SET_LIVE="$(cd "$ROOT_DIR/../../portfolio/scripts" 2>/dev/null && pwd || true)/set-live-url.sh"
if [[ -f "$PORTFOLIO_SET_LIVE" ]]; then
  printf '\n  Marking nextjs/%s offline in portfolio...\n' "$_WORKSPACE"
  bash "$PORTFOLIO_SET_LIVE" --down --tier "$_WORKSPACE" nextjs
fi
