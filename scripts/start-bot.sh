#!/usr/bin/env bash
# Start the Telegram status bot detached (survives the VS Code pane closing).
# No-op if it's already running.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE="scripts/bot.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    echo "already running (pid $PID)"
    exit 0
  fi
fi

# Prefer the locally-installed tsx binary (gives a killable node PID); fall
# back to npx. (Spec said ts-node; tsx is the runner actually installed.)
RUNNER="npx tsx"
if [ -x node_modules/.bin/tsx ]; then
  RUNNER="node_modules/.bin/tsx"
fi

nohup $RUNNER scripts/telegram-bot.ts > bot.log 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$PIDFILE"
echo "started bot (pid $NEWPID) -> bot.log"
