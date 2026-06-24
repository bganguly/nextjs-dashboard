#!/usr/bin/env bash
# Restart the detached Telegram status bot (stop, then start).
set -euo pipefail
DIR="$(dirname "$0")"

"$DIR/stop-bot.sh" || true
sleep 1
"$DIR/start-bot.sh"
