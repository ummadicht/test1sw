#!/usr/bin/env bash
# Runs ON the VM. Appends the SwapUp site block once, validates, reloads, and
# restores the previous file if anything fails. Idempotent.
set -euo pipefail
CF=/etc/caddy/Caddyfile
BLOCK="$HOME/swapup/deploy/caddy-swapup.caddy"
HOSTNAME_LINE="swapup.104-197-168-25.sslip.io {"
if sudo grep -qF "$HOSTNAME_LINE" "$CF"; then echo "caddy: block already present"; exit 0; fi
BAK="$CF.bak-swapup-$(date +%Y%m%d%H%M%S)"
sudo cp "$CF" "$BAK"
sudo sh -c "cat '$BLOCK' >> '$CF'"
LOG=$(mktemp)
if sudo caddy validate --config "$CF" --adapter caddyfile >"$LOG" 2>&1; then
  sudo systemctl reload caddy
  echo "caddy: block added and reloaded (backup $BAK)"
else
  sudo cp "$BAK" "$CF"
  echo "caddy: VALIDATION FAILED — restored $BAK" >&2
  tail -5 "$LOG" >&2
  exit 1
fi
