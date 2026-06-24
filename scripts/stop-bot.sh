#!/usr/bin/env bash
# Stop the detached Telegram status bot.
set -euo pipefail
cd "$(dirname "$0")/.."

PIDFILE="scripts/bot.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "stopped bot (pid $PID)"
  else
    echo "no live process for pid ${PID:-<none>}"
  fi
  rm -f "$PIDFILE"
else
  echo "no pidfile (not tracked as running)"
fi

# Safety net: reap any stray bot process not captured by the pidfile.
pkill -f "scripts/telegram-bot.ts" 2>/dev/null || true
