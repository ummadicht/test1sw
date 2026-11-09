#!/usr/bin/env bash
# Runs ON the VM. Installs (or REPLACES) the SwapUp site block, validates,
# reloads, and restores the previous file if anything fails. Idempotent.
set -euo pipefail
CF=/etc/caddy/Caddyfile
BLOCK="$HOME/swapup/deploy/caddy-swapup.caddy"
BAK="$CF.bak-swapup-$(date +%Y%m%d%H%M%S)"
sudo cp "$CF" "$BAK"
TMP=$(mktemp)
sudo cat "$CF" | python3 -c '
import sys
cf = sys.stdin.read()
block = open(sys.argv[1]).read()
host = "swapup.104-197-168-25.sslip.io {"
marker = "# SwapUp — repair-or-upgrade trade-in desk"
if host in cf:
    start = cf.index(host)
    # include the comment header that precedes the block, if present
    m = cf.rfind(marker, 0, start)
    if m != -1 and cf[m:start].count("\n") <= 4:
        start = cf.rfind("\n", 0, m) + 1
    # find the matching closing brace
    i = cf.index("{", cf.index(host)); depth = 0
    for j in range(i, len(cf)):
        if cf[j] == "{": depth += 1
        elif cf[j] == "}":
            depth -= 1
            if depth == 0: end = j + 1; break
    cf = cf[:start].rstrip("\n") + "\n" + block.rstrip("\n") + "\n" + cf[end:].lstrip("\n")
else:
    cf = cf.rstrip("\n") + "\n" + block
sys.stdout.write(cf)
' "$BLOCK" > "$TMP"
sudo cp "$TMP" "$CF"
LOG=$(mktemp)
if sudo caddy validate --config "$CF" --adapter caddyfile >"$LOG" 2>&1; then
  sudo systemctl reload caddy
  echo "caddy: SwapUp block installed and reloaded (backup $BAK)"
else
  sudo cp "$BAK" "$CF"
  echo "caddy: VALIDATION FAILED — restored $BAK" >&2
  tail -5 "$LOG" >&2
  exit 1
fi
