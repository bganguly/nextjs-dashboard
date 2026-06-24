#!/usr/bin/env bash
# Write a heartbeat for the testing worktree.
#   Usage: scripts/heartbeat.sh "what I'm doing now"
# Appends "<ISO-UTC>\t<msg>" to ../STATUS/testing.log (append-only history)
# and overwrites ../STATUS/testing-current.txt with the single-line status.
set -euo pipefail
cd "$(dirname "$0")/.."

WT="testing"
STATUS_DIR="../STATUS"
mkdir -p "$STATUS_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MSG="${*:-(no message)}"

printf '%s\t%s\n' "$TS" "$MSG" >> "$STATUS_DIR/$WT.log"
printf '%s\n' "$MSG" > "$STATUS_DIR/$WT-current.txt"
echo "heartbeat($WT): $MSG"
