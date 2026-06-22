#!/usr/bin/env bash
# Control where the agent routes questions/decisions: desktop (in-session) or
# telegram, optionally for a time window. Default is desktop.
#
#   scripts/notify-mode.sh status
#   scripts/notify-mode.sh telegram --until 3pm     # or --until 15:00
#   scripts/notify-mode.sh telegram --for 90m       # or --for 2h
#   scripts/notify-mode.sh telegram                 # on, no expiry
#   scripts/notify-mode.sh desktop                  # back to desktop
set -euo pipefail
cd "$(dirname "$0")/.."
MODE_FILE="scripts/.notify-mode.json"
cmd="${1:-status}"; shift || true

case "$cmd" in
  status)
    python3 - "$MODE_FILE" <<'PY'
import sys, json, datetime
try: s = json.load(open(sys.argv[1]))
except Exception: s = {"channel": "desktop", "until": None}
now = datetime.datetime.now().astimezone()
eff = s.get("channel", "desktop")
until = s.get("until")
if eff == "telegram" and until and now >= datetime.datetime.fromisoformat(until):
    eff = "desktop"
print(f"effective: {eff}")
print(f"config: {json.dumps(s)}")
PY
    ;;
  desktop|off)
    echo '{"channel":"desktop","until":null}' > "$MODE_FILE"
    echo "notify -> desktop (in-session)";;
  telegram|on)
    python3 - "$MODE_FILE" "$@" <<'PY'
import sys, json, datetime, re
f, args = sys.argv[1], sys.argv[2:]
until = None
now = datetime.datetime.now().astimezone()
i = 0
while i < len(args):
    if args[i] == "--until" and i + 1 < len(args):
        t = args[i+1].strip().lower(); i += 2
        m = re.match(r'^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$', t)
        if m:
            h = int(m.group(1)); mm = int(m.group(2) or 0); ap = m.group(3)
            if ap == 'pm' and h < 12: h += 12
            if ap == 'am' and h == 12: h = 0
            cand = now.replace(hour=h, minute=mm, second=0, microsecond=0)
            if cand <= now: cand += datetime.timedelta(days=1)
            until = cand.isoformat()
    elif args[i] == "--for" and i + 1 < len(args):
        d = args[i+1].strip().lower(); i += 2
        m = re.match(r'^(\d+)\s*(m|min|minutes|h|hr|hour|hours)$', d)
        if m:
            n = int(m.group(1))
            until = (now + datetime.timedelta(minutes=n*60 if m.group(2).startswith('h') else n)).isoformat()
    else:
        i += 1
json.dump({"channel": "telegram", "until": until}, open(f, "w"))
print("notify -> telegram", ("until " + until) if until else "(on, no expiry)")
PY
    ;;
  *)
    echo "usage: notify-mode.sh [status | telegram [--until 3pm|--for 90m] | desktop]";;
esac
