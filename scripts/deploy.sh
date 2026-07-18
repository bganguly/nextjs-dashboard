#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"
printf '  [1] Local  — npm run dev (port 3004)\n'
printf '  [2] Cloud  — CodeBuild → ECR → App Runner (scale-to-zero, wake on first ping)\n\n'
printf 'Choice [1/2]: '
read -r DEPLOY_TARGET
case "${DEPLOY_TARGET:-2}" in
  1)
    cd "$ROOT_DIR"
    npm install --prefer-offline || npm install
    exec npm run dev
    ;;
  2) ;;
  *) printf 'Invalid choice.\n'; exit 1 ;;
esac

CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

_prompt_creds() {
  printf 'ClickHouse hostname (e.g. abc123.us-east-1.aws.clickhouse.cloud): '
  read -r CH_HOSTNAME
  printf 'ClickHouse password: '
  read -rs CLICKHOUSE_PASSWORD
  printf '\n'
  export CLICKHOUSE_URL="https://${CH_HOSTNAME}:8443"
  export CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
  export CLICKHOUSE_PASSWORD
  printf 'Save credentials for future deploys? [Y/n]: '
  read -r SAVE_CREDS
  SAVE_CREDS="${SAVE_CREDS:-Y}"
  if [[ "$SAVE_CREDS" =~ ^[Yy] ]]; then
    printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
      "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
    chmod 600 "$CREDS_FILE"
    printf '  Saved to .clickhouse-creds\n\n'
  fi
}

if [[ -n "${CLICKHOUSE_URL:-}" && -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
  printf 'Using CLICKHOUSE_URL from environment: %s\n\n' "$CLICKHOUSE_URL"
elif [[ -f "$CREDS_FILE" ]]; then
  source "$CREDS_FILE"
  printf 'Loaded saved endpoint: %s. Use it? [Y/n]: ' "${CLICKHOUSE_URL:-}"
  read -r USE_SAVED
  USE_SAVED="${USE_SAVED:-Y}"
  if [[ ! "$USE_SAVED" =~ ^[Yy] ]]; then
    unset CLICKHOUSE_URL CLICKHOUSE_PASSWORD
    _prompt_creds
  elif [[ -z "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
    printf 'New password? [Enter to keep saved]: '
    read -rs NEW_PASS
    printf '\n'
    if [[ -n "$NEW_PASS" ]]; then
      CLICKHOUSE_PASSWORD="$NEW_PASS"
      export CLICKHOUSE_PASSWORD
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
      printf '  Password updated in .clickhouse-creds\n\n'
    fi
  fi
else
  _prompt_creds
fi

export TF_VAR_clickhouse_url="${CLICKHOUSE_URL}"
export TF_VAR_clickhouse_password="${CLICKHOUSE_PASSWORD}"

for dep in aws terraform; do
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found in PATH.\n' "$dep"; exit 1; }
done

printf '[1/5] Checking AWS credentials...\n'
aws sts get-caller-identity >/dev/null
printf '  OK\n'

printf '[2/5] Provisioning ECR + CodeBuild (terraform apply)...\n'
cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null

ECR_IMAGE_EXISTS="$(aws ecr describe-images \
  --repository-name "${TF_VAR_name_prefix:-njs-dash}-app" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"

if [[ -z "$ECR_IMAGE_EXISTS" || "$ECR_IMAGE_EXISTS" == "None" ]]; then
  printf '  First deploy — provisioning ECR + CodeBuild only (App Runner needs an image first).\n'
  terraform apply -auto-approve -input=false \
    -target=aws_ecr_repository.app \
    -target=aws_ecr_lifecycle_policy.app \
    -target=aws_s3_bucket.codebuild_src \
    -target=aws_iam_role.codebuild \
    -target=aws_iam_role_policy.codebuild \
    -target=aws_codebuild_project.app \
    -target=aws_iam_role.apprunner_ecr \
    -target=aws_iam_role_policy_attachment.apprunner_ecr \
    -target=aws_apprunner_auto_scaling_configuration_version.app \
    -target=aws_s3_bucket.maintenance \
    -target=aws_s3_bucket_public_access_block.maintenance \
    -target=aws_s3_bucket_website_configuration.maintenance \
    -target=aws_s3_bucket_policy.maintenance \
    -target=aws_s3_object.maintenance_html
  FIRST_DEPLOY=1
else
  terraform apply -auto-approve -input=false
  FIRST_DEPLOY=0
fi

ECR_REPO="$(terraform output -raw ecr_repository_url)"
SRC_BUCKET="$(terraform output -raw codebuild_source_bucket)"
CB_PROJECT="$(terraform output -raw codebuild_project_name)"

printf '[3/5] Building Docker image via CodeBuild...\n'
TMPZIP="/tmp/${PROJECT_NAME}-source.zip"
cd "$ROOT_DIR"
zip -qr "$TMPZIP" . \
  --exclude ".git/*" \
  --exclude "node_modules/*" \
  --exclude ".next/*" \
  --exclude "infra/.terraform/*" \
  --exclude "infra/terraform.tfstate*" \
  --exclude ".env*" \
  --exclude ".clickhouse-creds"
aws s3 cp "$TMPZIP" "s3://${SRC_BUCKET}/source.zip" --quiet
rm -f "$TMPZIP"

BUILD_ID="$(aws codebuild start-build \
  --project-name "$CB_PROJECT" \
  --environment-variables-override \
    name=CLICKHOUSE_URL,value="$CLICKHOUSE_URL",type=PLAINTEXT \
    name=CLICKHOUSE_PASSWORD,value="${CLICKHOUSE_PASSWORD:-}",type=PLAINTEXT \
  --query 'build.id' --output text)"
printf '  Build %s started...\n' "$BUILD_ID"

while true; do
  STATUS="$(aws codebuild batch-get-builds \
    --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' \
    --output text)"
  if [[ "$STATUS" == "SUCCEEDED" ]]; then
    printf '  Build succeeded.\n'
    break
  fi
  if [[ "$STATUS" == "FAILED" || "$STATUS" == "FAULT" || "$STATUS" == "STOPPED" || "$STATUS" == "TIMED_OUT" ]]; then
    printf 'ERROR: CodeBuild failed (%s). Check logs:\n' "$STATUS"
    aws codebuild batch-get-builds --ids "$BUILD_ID" \
      --query 'builds[0].logs.deepLink' --output text
    exit 1
  fi
  printf '  Status: %s — waiting...\n' "$STATUS"
  sleep 20
done

printf '[4/5] Completing infrastructure (terraform apply)...\n'
cd "$INFRA_DIR"
terraform apply -auto-approve -input=false

APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
CDN_URL="$(terraform output -raw cdn_url)"

if [[ "$FIRST_DEPLOY" == "0" ]]; then
  printf '[5/5] Deploying new image to App Runner...\n'
  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
else
  printf '[5/5] Waiting for App Runner initial deployment...\n'
fi

while true; do
  SVC_STATUS="$(aws apprunner describe-service \
    --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' \
    --output text)"
  if [[ "$SVC_STATUS" == "RUNNING" ]]; then
    printf '  App Runner running.\n'
    break
  fi
  if [[ "$SVC_STATUS" == "CREATE_FAILED" || "$SVC_STATUS" == "UPDATE_FAILED" ]]; then
    printf 'ERROR: App Runner service failed (%s).\n' "$SVC_STATUS"
    exit 1
  fi
  printf '  Status: %s — waiting...\n' "$SVC_STATUS"
  sleep 20
done

printf '\n  Dashboard: %s\n' "$CDN_URL"
printf '  Tear down: %s/scripts/infra-down.sh\n\n' "$ROOT_DIR"

PORTFOLIO_SCRIPT="$ROOT_DIR/../../portfolio/scripts/set-live-url.sh"
if [[ -x "$PORTFOLIO_SCRIPT" ]]; then
  bash "$PORTFOLIO_SCRIPT" nextjs "$CDN_URL"
fi
