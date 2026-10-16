#!/usr/bin/env bash
# Deploy SwapUp to the denovo-erp VM → https://swapup.104-197-168-25.sslip.io
#
# Builds LOCALLY in a clean copy (never on the VM — a next build there swaps and
# takes co-tenants down; never in the repo — a running dev server owns .next),
# ships the compiled app, installs production deps on the VM (better-sqlite3 is
# native and must be built for linux), and restarts pm2 "swapup".
set -euo pipefail
VM=${VM:-ammar@104.197.168.25}
KEY=${KEY:-$HOME/.ssh/denovo_gcp}
PUBLIC=${PUBLIC:-https://swapup.104-197-168-25.sslip.io}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${BUILD:-/private/tmp/claude-501/swapup-deploy}
SSH_OPTS="-i $KEY -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=15"
SSH=(ssh $SSH_OPTS "$VM")

echo "▸ gates: domain tests + typecheck"
(cd "$ROOT" && npm test >/dev/null && npx tsc --noEmit -p .)

echo "▸ build in $BUILD (webpack, never turbopack — its chunks break better-sqlite3 on the VM)"
mkdir -p "$BUILD"
rsync -a --delete --exclude node_modules --exclude .next --exclude data --exclude .git --exclude '.env*' --exclude '.claude' "$ROOT/" "$BUILD/"
rsync -a --delete "$ROOT/node_modules/" "$BUILD/node_modules/"
(cd "$BUILD" && rm -rf .next && npx next build --webpack)
if ls "$BUILD/.next/server/chunks" 2>/dev/null | grep -q '\[turbopack\]'; then echo "turbopack chunks found — refusing to ship" >&2; exit 1; fi

echo "▸ ship"
"${SSH[@]}" "mkdir -p ~/swapup/data"
rsync -az --delete -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude data --exclude .git --exclude '.env*' --exclude '.next/cache' --exclude '.claude' \
  "$BUILD/" "$VM:~/swapup/"

echo "▸ production deps on the VM"
"${SSH[@]}" "cd ~/swapup && npm install --omit=dev --no-audit --no-fund --loglevel=error"

echo "▸ env (secret minted once, then reused — rotating it signs everyone out)"
"${SSH[@]}" 'sudo test -f /etc/swapup.env || { S=$(openssl rand -hex 32); printf "NODE_ENV=production\nPORT=4500\nSWAPUP_SESSION_SECRET=%s\n" "$S" | sudo tee /etc/swapup.env >/dev/null; sudo chown root:ammar /etc/swapup.env; sudo chmod 640 /etc/swapup.env; echo minted; }'

echo "▸ downloads folder for the Android apps (outside the app dir)"
"${SSH[@]}" 'set -e; sudo mkdir -p /var/www/swapup-downloads; sudo chown ammar:ammar /var/www/swapup-downloads
  sudo grep -q "^SWAPUP_DOWNLOADS_DIR=" /etc/swapup.env || echo "SWAPUP_DOWNLOADS_DIR=/var/www/swapup-downloads" | sudo tee -a /etc/swapup.env >/dev/null
  sudo grep -q "^SWAPUP_PUBLIC_URL=" /etc/swapup.env || echo "SWAPUP_PUBLIC_URL=https://swapup.104-197-168-25.sslip.io" | sudo tee -a /etc/swapup.env >/dev/null'
MOBILE_DIST=${MOBILE_DIST:-$ROOT/../swapup-mobile/dist}
if ls "$MOBILE_DIST"/swapup-*.apk >/dev/null 2>&1; then
  echo "  uploading APKs from $MOBILE_DIST"
  rsync -az -e "ssh $SSH_OPTS" "$MOBILE_DIST"/swapup-*.apk "$MOBILE_DIST"/swapup-*.json "$VM:/var/www/swapup-downloads/"
fi

echo "▸ pm2"
"${SSH[@]}" "cd ~/swapup && chmod +x deploy/start.sh deploy/patch-caddy.sh && (pm2 describe swapup >/dev/null 2>&1 && pm2 restart swapup --update-env || pm2 start deploy/start.sh --name swapup --interpreter bash) && pm2 save >/dev/null"

echo "▸ caddy"
"${SSH[@]}" "bash ~/swapup/deploy/patch-caddy.sh"

echo "▸ health"
for i in $(seq 1 20); do
  code=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4500/login" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "  local :4500/login → $code"
pub=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC/login" || true)
echo "  $PUBLIC/login → $pub"
[ "$code" = "200" ] && [ "$pub" = "200" ] && echo "✓ deployed" || { echo "✗ health check failed" >&2; exit 1; }
