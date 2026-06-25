#!/usr/bin/env bash
set -euo pipefail

# Bake the current demo database (schema + seeded orders + rebuilt read models)
# into a single pg_dump -Fc snapshot and upload it to a PRIVATE S3 object under
# YOUR AWS credentials. prepare-demo-data.sh then restores from it in a few
# minutes instead of re-seeding + rebuilding from scratch (~15-20 min).
#
# This is a maintainer step. A developer cloning from GitHub does NOT need it and
# does NOT get access to the snapshot: without S3 read credentials they simply
# fall back to the full seed path in prepare-demo-data.sh.
#
# Usage:
#   DEMO_SNAPSHOT_S3_URI=s3://my-private-bucket/dash/demo.dump ./scripts/bake-demo-snapshot.sh
#
# The bucket must be private and live under your own account. Standard-IA is the
# default storage class: the snapshot is written once and read rarely, so IA's
# lower storage cost fits while keeping millisecond first-byte latency (unlike
# Glacier, whose retrieval delay would defeat the fast-demo goal).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

S3_URI="${DEMO_SNAPSHOT_S3_URI:-}"
STORAGE_CLASS="${DEMO_SNAPSHOT_STORAGE_CLASS:-STANDARD_IA}"

if [[ -z "$S3_URI" ]]; then
  echo "Set DEMO_SNAPSHOT_S3_URI to a private S3 object, e.g." >&2
  echo "  DEMO_SNAPSHOT_S3_URI=s3://my-private-bucket/dash/demo.dump $0" >&2
  exit 1
fi

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql aws

if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"; then
  echo "No database configured — run ./scripts/infra-up.sh first." >&2
  exit 1
fi
export DATABASE_URL

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS credentials are not configured for this shell; cannot upload the snapshot." >&2
  exit 1
fi

DUMP_FILE="$(mktemp -t dash-demo.XXXXXX.dump)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "Dumping database (pg_dump -Fc) to a local snapshot..."
pg_dump --format=custom --no-owner --no-privileges --file "$DUMP_FILE" "$DATABASE_URL"
echo "Snapshot size: $(du -h "$DUMP_FILE" | cut -f1)"

echo "Uploading to $S3_URI (storage class: $STORAGE_CLASS)..."
aws s3 cp "$DUMP_FILE" "$S3_URI" --storage-class "$STORAGE_CLASS"

echo "Done. prepare-demo-data.sh will restore from this snapshot when"
echo "DEMO_SNAPSHOT_S3_URI=$S3_URI is set and your AWS credentials can read it."
