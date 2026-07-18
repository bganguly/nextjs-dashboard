#!/usr/bin/env bash
# infra-down.sh — stop local dev or tear down AWS App Runner stack
# Usage: ./scripts/infra-down.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
NAME_PREFIX="${TF_VAR_name_prefix:-njs-dash}"
CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

_local_running=0
lsof -ti:3004 >/dev/null 2>&1 && _local_running=1 || true
_state_file="$INFRA_DIR/terraform.tfstate"
_aws_deployed=0
[[ -f "$_state_file" ]] && _aws_deployed=1 || true

printf '\n=== nextjs-dashboard — tear down ===\n\n'
printf '  [1] Local  — stop npm dev process'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Cloud  — destroy AWS App Runner + ECR + CodeBuild + CDN'
(( _aws_deployed )) && printf ' [deployed]' || printf ' [not deployed]'
printf '\n'
printf '\nChoice [1/2, default 2]: '
read -r _MODE
case "$_MODE" in
  1) _TARGET="local" ;;
  *) _TARGET="cloud" ;;
esac

# ── local ─────────────────────────────────────────────────────────────────────
if [[ "$_TARGET" == "local" ]]; then
  _pid="$(lsof -ti:3004 2>/dev/null || true)"
  if [[ -n "$_pid" ]]; then
    kill "$_pid" 2>/dev/null && green '  Stopped npm dev on :3004'
  else
    dim '  No process found on :3004.'
  fi
  green 'Done.'
  exit 0
fi

# ── AWS ───────────────────────────────────────────────────────────────────────
echo ""
echo "[1/3] Checking AWS credentials..."
command -v aws       >/dev/null 2>&1 || { red 'aws CLI not found'; exit 1; }
command -v terraform >/dev/null 2>&1 || { red 'terraform not found'; exit 1; }
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  red '  AWS credentials not configured — run: aws configure'
  exit 1
fi
dim "  Credentials: $(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null)"

[[ -f "$CREDS_FILE" ]] && source "$CREDS_FILE"
export TF_VAR_clickhouse_url="${CLICKHOUSE_URL:-placeholder}"
export TF_VAR_clickhouse_password="${CLICKHOUSE_PASSWORD:-placeholder}"

cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null

_tf() { terraform output -raw "$1" 2>/dev/null || true; }
APP_RUNNER_ARN=$(_tf apprunner_service_arn)
ECR_REPO_URL=$(_tf ecr_repository_url)
ECR_REPO_NAME="${NAME_PREFIX}-app"

printf '\n  This will destroy:\n'
printf '    App Runner service\n'
printf '    ECR repository:  %s\n' "$ECR_REPO_NAME"
printf '    CodeBuild project + S3 source bucket\n'
printf '    CloudFront CDN + S3 maintenance bucket\n'
printf '    IAM roles\n'
printf '\n  Proceed? [Y/n]: '
read -r _CONFIRM
[[ "${_CONFIRM:-y}" =~ ^[Yy]$ ]] || { red 'Aborted.'; exit 1; }

echo ""
echo "[2/3] Pausing App Runner and flushing ECR images..."
if [[ -n "$APP_RUNNER_ARN" ]]; then
  _svc_status=$(aws apprunner describe-service \
    --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' --output text 2>/dev/null || true)
  if [[ "$_svc_status" == "RUNNING" ]]; then
    aws apprunner pause-service --service-arn "$APP_RUNNER_ARN" --no-cli-pager >/dev/null 2>/dev/null || true
    printf '  Waiting for App Runner to pause...\n'
    aws apprunner wait service-updated --service-arn "$APP_RUNNER_ARN" --no-cli-pager 2>/dev/null || true
    green '  App Runner paused'
  else
    dim "  App Runner status: ${_svc_status:-unknown} — skipping pause"
  fi
else
  dim '  App Runner ARN not found — skipping'
fi

_ids=$(aws ecr list-images --repository-name "$ECR_REPO_NAME" \
  --query 'imageIds[*]' --output json --no-cli-pager 2>/dev/null || echo '[]')
if [[ "$_ids" != "[]" && "$_ids" != "" ]]; then
  aws ecr batch-delete-image --repository-name "$ECR_REPO_NAME" \
    --image-ids "$_ids" --no-cli-pager >/dev/null 2>/dev/null \
    && green "  ECR images deleted from $ECR_REPO_NAME" \
    || dim   "  ECR delete skipped"
else
  dim "  ECR repository already empty"
fi

echo ""
echo "[3/3] Running terraform destroy..."
terraform destroy -auto-approve -input=false

rm -f "$CREDS_FILE"
green '  .clickhouse-creds removed'

green '\nAWS infrastructure torn down.'
printf '  Redeploy: ./scripts/deploy.sh\n'
