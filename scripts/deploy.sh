#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
PROJECT_NAME="$(basename "$ROOT_DIR")"

printf '\n=== %s deploy ===\n\n' "$PROJECT_NAME"
printf '  [1] Local  — npm run dev (port 3004)\n'
printf '  [2] Cloud  — GitHub Actions → ECR → App Runner (scale-to-zero, wake on first ping)\n\n'
printf 'Choice [1/2, default 2]: '
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

for dep in aws terraform; do
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found in PATH.\n' "$dep"; exit 1; }
done

printf '[1/4] Checking AWS credentials...\n'
aws sts get-caller-identity >/dev/null
printf '  OK\n'

_GH_REPO="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null \
  | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')"
if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" ]]; then
  printf '  Syncing AWS credentials to GitHub Actions secrets (%s)...\n' "$_GH_REPO"
  _AWS_REGION="$(aws configure get region 2>/dev/null || echo "us-east-1")"
  aws configure get aws_access_key_id     | gh secret set AWS_ACCESS_KEY_ID     --repo "$_GH_REPO"
  aws configure get aws_secret_access_key | gh secret set AWS_SECRET_ACCESS_KEY --repo "$_GH_REPO"
  printf '%s' "$_AWS_REGION"              | gh secret set AWS_REGION            --repo "$_GH_REPO"
fi

printf '[2/4] Provisioning ECR + RDS (terraform apply)...\n'
cd "$INFRA_DIR"
terraform init -input=false -upgrade >/dev/null
printf '  Pruning stale state...\n'

terraform state rm aws_codebuild_project.app         2>/dev/null || true
terraform state rm aws_iam_role_policy.codebuild     2>/dev/null || true
terraform state rm aws_iam_role.codebuild            2>/dev/null || true
terraform state rm aws_s3_bucket.codebuild_src       2>/dev/null || true

_STATE_FILE="$INFRA_DIR/terraform.tfstate"
if [[ -f "$_STATE_FILE" ]]; then
  python3 -c "
import json
with open('$_STATE_FILE') as f: s = json.load(f)
for k in ('codebuild_source_bucket', 'codebuild_project_name'):
    s.get('outputs', {}).pop(k, None)
with open('$_STATE_FILE', 'w') as f: json.dump(s, f, indent=2)
" 2>/dev/null || true
fi

ECR_IMAGE_EXISTS="$(aws ecr describe-images \
  --repository-name "${TF_VAR_name_prefix:-njs-dash}-app" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)"

if [[ -z "$ECR_IMAGE_EXISTS" || "$ECR_IMAGE_EXISTS" == "None" ]]; then
  printf '  First deploy — provisioning ECR + RDS (App Runner needs an image first).\n'
  terraform apply -auto-approve -input=false \
    -target=aws_ecr_repository.app \
    -target=aws_ecr_lifecycle_policy.app \
    -target=aws_iam_role.apprunner_ecr \
    -target=aws_iam_role_policy_attachment.apprunner_ecr \
    -target=aws_apprunner_auto_scaling_configuration_version.app \
    -target=aws_s3_bucket.maintenance \
    -target=aws_s3_bucket_public_access_block.maintenance \
    -target=aws_s3_bucket_website_configuration.maintenance \
    -target=aws_s3_bucket_policy.maintenance \
    -target=aws_s3_object.maintenance_html \
    -target=aws_security_group.rds \
    -target=aws_db_subnet_group.app \
    -target=random_password.db \
    -target=aws_db_instance.app
  FIRST_DEPLOY=1
else
  terraform apply -auto-approve -input=false
  FIRST_DEPLOY=0
fi

printf '  Reading Terraform outputs...\n'
ECR_REPO="$(terraform output -raw ecr_repository_url)"

_DB_URL="$(terraform output -raw database_url 2>/dev/null || true)"
if [[ -n "$_DB_URL" ]]; then
  printf 'DATABASE_URL=%s\n' "$_DB_URL" > "$ROOT_DIR/.env.rds"
  printf '  Saved DATABASE_URL to .env.rds\n'
fi

printf '[3/4] Verifying ECR image exists...\n'
_REMOTE_SHA="$(git -C "$ROOT_DIR" ls-remote origin HEAD 2>/dev/null | cut -c1-7)"
_DEPLOY_TAG="${_REMOTE_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "latest")}"

_ecr_image_exists() {
  aws ecr describe-images \
    --repository-name "${TF_VAR_name_prefix:-njs-dash}-app" \
    --image-ids "imageTag=$1" >/dev/null 2>&1
}

printf '  Checking ECR for image %s...\n' "$_DEPLOY_TAG"
if ! _ecr_image_exists "$_DEPLOY_TAG"; then
  if _ecr_image_exists "latest"; then
    printf '  SHA %s not in ECR (image unchanged) — using latest.\n' "$_DEPLOY_TAG"
    _DEPLOY_TAG=latest
  else
    printf '  No image in ECR yet — waiting for GitHub Actions build (up to 10 min)...\n'
    _ecr_elapsed=0
    until _ecr_image_exists "latest"; do
      if (( _ecr_elapsed >= 600 )); then
        printf '  Timed out. Check Actions: https://github.com/%s/actions\n' "$_GH_REPO"
        exit 1
      fi
      sleep 15; _ecr_elapsed=$(( _ecr_elapsed + 15 ))
      printf '  ...%ds\n' "$_ecr_elapsed"
    done
    _DEPLOY_TAG=latest
  fi
fi
printf '  Image %s found in ECR.\n' "$_DEPLOY_TAG"
if [[ "$_DEPLOY_TAG" != "latest" ]]; then
  _MANIFEST="$(aws ecr batch-get-image \
    --repository-name "${TF_VAR_name_prefix:-njs-dash}-app" \
    --image-ids "imageTag=${_DEPLOY_TAG}" \
    --query 'images[0].imageManifest' --output text 2>/dev/null)"
  aws ecr put-image \
    --repository-name "${TF_VAR_name_prefix:-njs-dash}-app" \
    --image-tag latest --image-manifest "$_MANIFEST" >/dev/null 2>&1 \
    && printf '  Re-tagged %s as latest.\n' "$_DEPLOY_TAG" || true
fi

printf '[4/4] Completing infrastructure (terraform apply)...\n'
cd "$INFRA_DIR"
_AR_ARN_PRE="$(terraform output -raw apprunner_service_arn 2>/dev/null || true)"
if [[ -n "$_AR_ARN_PRE" ]]; then
  _AR_STATUS_PRE="$(aws apprunner describe-service --service-arn "$_AR_ARN_PRE" \
    --query 'Service.Status' --output text 2>/dev/null || true)"
  if [[ "$_AR_STATUS_PRE" == "CREATE_FAILED" ]]; then
    printf '  App Runner in CREATE_FAILED — tainting for recreation...\n'
    terraform taint aws_apprunner_service.app
  fi
fi
terraform apply -auto-approve -input=false
printf '  Reading Terraform outputs...\n'

APP_RUNNER_ARN="$(terraform output -raw apprunner_service_arn)"
CDN_URL="$(terraform output -raw cdn_url)"
CF_DIST_ID="$(terraform output -raw cf_distribution_id 2>/dev/null || true)"
if command -v gh >/dev/null 2>&1 && [[ -n "$_GH_REPO" && -n "$CF_DIST_ID" ]]; then
  printf '%s' "$CF_DIST_ID" | gh secret set CF_DISTRIBUTION_ID --repo "$_GH_REPO"
  printf '  Synced CF_DISTRIBUTION_ID to GitHub Actions secrets.\n'
fi

if [[ "$FIRST_DEPLOY" == "0" ]]; then
  printf '[4/4] Deploying new image to App Runner...\n'
  aws apprunner start-deployment --service-arn "$APP_RUNNER_ARN" >/dev/null
else
  printf '[4/4] Waiting for App Runner initial deployment...\n'
fi

while true; do
  SVC_STATUS="$(aws apprunner describe-service \
    --service-arn "$APP_RUNNER_ARN" \
    --query 'Service.Status' \
    --output text)"
  if [[ "$SVC_STATUS" == "RUNNING" ]]; then
    printf '  App Runner running.\n'
    if [[ -n "${CF_DIST_ID:-}" ]]; then
      printf '  Invalidating CloudFront cache...\n'
      aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" \
        --query 'Invalidation.Id' --output text
    fi
    break
  fi
  if [[ "$SVC_STATUS" == "CREATE_FAILED" || "$SVC_STATUS" == "UPDATE_FAILED" ]]; then
    printf 'ERROR: App Runner service failed (%s).\n' "$SVC_STATUS"
    exit 1
  fi
  printf '  Status: %s — waiting...\n' "$SVC_STATUS"
  sleep 20
done

AR_SERVICE_URL="$(aws apprunner describe-service \
  --service-arn "$APP_RUNNER_ARN" \
  --query 'Service.ServiceUrl' --output text)"

printf '  Waiting for container warm-up...\n'
sleep 8

printf '  Triggering backfill on App Runner...\n'
curl -sf "https://${AR_SERVICE_URL}/api/admin/backfill" >/dev/null \
  || { printf '  Could not reach backfill endpoint.\n'; }

printf '  Polling progress'
_spin='|/-\'
_i=0
while true; do
  _STATUS="$(curl -sf "https://${AR_SERVICE_URL}/api/admin/backfill/status" 2>/dev/null || echo '{}')"
  _DONE="$(printf '%s' "$_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('done', False))" 2>/dev/null)"
  _OCF="$(printf '%s' "$_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('steps',{}).get('order_category_facts','?'))" 2>/dev/null)"
  _DOC="$(printf '%s' "$_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('steps',{}).get('daily_order_count','?'))" 2>/dev/null)"
  _DS="$(printf '%s'  "$_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('steps',{}).get('daily_summary','?'))" 2>/dev/null)"
  _ERR="$(printf '%s' "$_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error') or '')" 2>/dev/null)"
  _C="${_spin:$(( _i % 4 )):1}"
  printf '\r  %s  order_category_facts:%-8s  daily_order_count:%-8s  daily_summary:%-8s' \
    "$_C" "$_OCF" "$_DOC" "$_DS"
  _i=$(( _i + 1 ))
  if [[ "$_DONE" == "True" ]]; then
    printf '\n'
    if [[ -n "$_ERR" ]]; then
      printf '  Backfill error: %s\n' "$_ERR"
    else
      printf '  Backfill complete.\n'
    fi
    break
  fi
  sleep 4
done

printf '\n  Dashboard: %s\n' "$CDN_URL"
printf '  Tear down: %s/scripts/infra-down.sh\n\n' "$ROOT_DIR"

PORTFOLIO_SCRIPT="$ROOT_DIR/../../portfolio/scripts/set-live-url.sh"
if [[ -x "$PORTFOLIO_SCRIPT" ]]; then
  bash "$PORTFOLIO_SCRIPT" nextjs "$CDN_URL"
fi
