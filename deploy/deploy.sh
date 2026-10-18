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

# No bundled price file, ever (owner, 2026-10-18: PriceIQ live, no snapshot). Prices come from
# PriceIQ's API, an uploaded partner rate card or a quote staff type in — never a CSV in the app.
echo "▸ gate: no bundled price file"
stray=$(cd "$ROOT" && find app components lib public -type f -name '*.csv' 2>/dev/null || true)
if [ -n "$stray" ]; then echo "✗ a CSV in the app — prices come from PriceIQ live, not a bundled file:" >&2; echo "$stray" >&2; exit 1; fi

# GradeIQ is the grading engine under SwapUp Check (docs/GRADEIQ-INTEGRATION.md).
# Defaults go into /etc/swapup.env only where a line is missing — an operator's
# value (e.g. GRADEIQ_ENABLED=0, the labelled kill switch) is never overwritten.
GRADEIQ_DEFAULTS="GRADEIQ_BASE_URL=http://127.0.0.1:3700/apps/gradeiq GRADEIQ_PUBLIC_URL=https://swapmore.com/apps/gradeiq GRADEIQ_CLIENT=swapmore-in GRADEIQ_CHANNEL=retail GRADEIQ_ENABLED=1"
gradeiq_env_defaults() {
  "${SSH[@]}" "sudo test -f /etc/swapup.env || exit 0
    for kv in $GRADEIQ_DEFAULTS; do
      sudo grep -q \"^\${kv%%=*}=\" /etc/swapup.env || { echo \"\$kv\" | sudo tee -a /etc/swapup.env >/dev/null; echo \"  added \$kv\"; }
    done"
}

# Gate: from the VM, an unknown GradeIQ session must answer 404 {"error":"not
# found"} — GradeIQ's own JSON, not an HTML 404 page (a wrong basePath also
# returns 404). Anything else and SwapUp Check would run without its grader.
echo "▸ gate: GradeIQ answers on the VM"
gradeiq_env_defaults
"${SSH[@]}" 'F=/etc/swapup.env
  # start.sh SOURCES the file, so GRADEIQ_ENABLED="0" (quoted) or a trailing space is still the kill switch.
  val() { sudo test -f $F && sudo sed -n "s/^$1=//p" $F | tail -n1 | tr -d "\"'\'' \r\t"; }
  BASE=$(val GRADEIQ_BASE_URL); BASE=${BASE:-http://127.0.0.1:3700/apps/gradeiq}
  if [ "$(val GRADEIQ_ENABLED)" = "0" ]; then echo "  GRADEIQ_ENABLED=0 in $F — camera grading is switched off by the operator; gate skipped"; exit 0; fi
  out=$(curl -s -m 10 -w "\n%{http_code}" "$BASE/api/sessions/00000000-0000-4000-8000-000000000000" || true)
  code=$(printf "%s" "$out" | tail -n1); body=$(printf "%s" "$out" | sed "\$d" | head -c 200)
  echo "  $BASE/api/sessions/<unknown> → $code $body"
  if [ "$code" = "404" ] && printf "%s" "$body" | grep -q "\"error\":\"not found\""; then exit 0; fi
  echo "✗ GradeIQ is not answering at $BASE (expected 404 {\"error\":\"not found\"}). Start pm2 gradeiq or fix GRADEIQ_BASE_URL in $F." >&2
  exit 1'

# PriceIQ (lib/server/priceiq.ts): the refurbished market price by grade, asked server to server
# with a read-only key. The address is a default added only where the line is missing; the key is
# minted on PriceIQ and put in /etc/swapup.env by hand — this script never writes it or prints it
# (at most its last 4 characters).
PRICEIQ_DEFAULT_BASE=http://127.0.0.1:4301/apps/priceiq
priceiq_env_defaults() {
  "${SSH[@]}" "sudo test -f /etc/swapup.env || exit 0
    sudo grep -q '^PRICEIQ_BASE_URL=' /etc/swapup.env || { echo 'PRICEIQ_BASE_URL=$PRICEIQ_DEFAULT_BASE' | sudo tee -a /etc/swapup.env >/dev/null; echo '  added PRICEIQ_BASE_URL=$PRICEIQ_DEFAULT_BASE'; }"
}

# Gate: from the VM, PriceIQ must answer 200 with graded prices for a known phone (the contract's
# acceptance phone, Galaxy S23 Ultra 256GB) with the key in /etc/swapup.env. The key reaches curl on
# stdin — never a command line, never echoed. No key yet → skipped, loudly: every trade-in then says
# "No market price yet — enter a quote" until one is added.
echo "▸ gate: PriceIQ answers on the VM"
priceiq_env_defaults
"${SSH[@]}" "bash -s -- $PRICEIQ_DEFAULT_BASE" <<'REMOTE'
F=/etc/swapup.env
val() { sudo test -f "$F" && sudo sed -n "s/^$1=//p" "$F" | tail -n1 | tr -d "\"' \r\t"; }
BASE=$(val PRICEIQ_BASE_URL); BASE=${BASE:-$1}; BASE=${BASE%/}
KEY=$(val PRICEIQ_API_KEY)
if [ -z "$KEY" ]; then
  echo "  ⚠ PRICEIQ_API_KEY is not in $F — gate SKIPPED. Trade-ins say \"No market price yet — enter a quote\" until a read-only key is added."
  exit 0
fi
out=$(printf 'Authorization: Bearer %s\n' "$KEY" | curl -s -m 10 -H @- -w '\n%{http_code}' "$BASE/api/market-grades?brand=Samsung&model=Galaxy%20S23%20Ultra&storageGb=256&market=IN" || true)
code=$(printf '%s' "$out" | tail -n1)
body=$(printf '%s' "$out" | sed '$d')
grades=$(printf '%s' "$body" | grep -o '"lowMinor"' | wc -l | tr -d ' ')
week=$(printf '%s' "$body" | grep -o '"week":"[^"]*"' | head -n1)
echo "  $BASE/api/market-grades (Galaxy S23 Ultra 256GB) → $code, ${grades:-0} grades ${week:-(no week)} (key …${KEY: -4})"
if [ "$code" = "200" ] && [ "${grades:-0}" -gt 0 ]; then exit 0; fi
echo "✗ PriceIQ did not answer 200 with graded prices at $BASE (401 = the key; 404 = the refurbished drop is not re-imported with grades)." >&2
exit 1
REMOTE

# The browser versions of the two apps (Expo web exports, swapup-mobile
# dist-web/<app>/). Caddy serves them at /app/<app>/, so each export must load
# its scripts from /app/<app>/_expo/… (baseUrl) — a root /_expo/… path would
# 404 and leave a blank page. Checked here, before anything ships.
WEB_DIST=${WEB_DIST:-$ROOT/../swapup-mobile/dist-web}
WEB_APPS=()
for app in store check; do
  if [ -f "$WEB_DIST/$app/index.html" ]; then
    if ! grep -q "/app/$app/_expo/" "$WEB_DIST/$app/index.html"; then
      echo "✗ $WEB_DIST/$app/index.html does not load its scripts from /app/$app/_expo/ — export it with baseUrl /app/$app" >&2
      exit 1
    fi
    WEB_APPS+=("$app")
  fi
done

echo "▸ build in $BUILD (webpack, never turbopack — its chunks break better-sqlite3 on the VM)"
mkdir -p "$BUILD"
rsync -a --delete --exclude node_modules --exclude .next --exclude data --exclude .git --exclude '.env*' --exclude '.claude' --exclude /public/app "$ROOT/" "$BUILD/"
# Never a CSV in what ships (the research snapshots in scripts/ stay on this Mac). Deleted from the
# build copy rather than excluded, so one left there by an older build can't ride along, and the
# ship's --delete then removes any still on the VM.
find "$BUILD" -path "$BUILD/node_modules" -prune -o -name '*.csv' -type f -print -delete | sed 's/^/  not shipped: /'
if find "$BUILD" -path "$BUILD/node_modules" -prune -o -name '*.csv' -type f -print | grep -q .; then echo "✗ a CSV is still in the build — refusing to ship" >&2; exit 1; fi
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
gradeiq_env_defaults # a first deploy mints the file above, after the gate ran on the defaults
priceiq_env_defaults

echo "▸ downloads folder for the Android apps (outside the app dir)"
"${SSH[@]}" 'set -e; sudo mkdir -p /var/www/swapup-downloads; sudo chown ammar:ammar /var/www/swapup-downloads
  sudo grep -q "^SWAPUP_DOWNLOADS_DIR=" /etc/swapup.env || echo "SWAPUP_DOWNLOADS_DIR=/var/www/swapup-downloads" | sudo tee -a /etc/swapup.env >/dev/null
  sudo grep -q "^SWAPUP_PUBLIC_URL=" /etc/swapup.env || echo "SWAPUP_PUBLIC_URL=https://swapup.104-197-168-25.sslip.io" | sudo tee -a /etc/swapup.env >/dev/null'
MOBILE_DIST=${MOBILE_DIST:-$ROOT/../swapup-mobile/dist}
if ls "$MOBILE_DIST"/swapup-*.apk >/dev/null 2>&1; then
  echo "  uploading APKs from $MOBILE_DIST"
  rsync -az -e "ssh $SSH_OPTS" "$MOBILE_DIST"/swapup-*.apk "$MOBILE_DIST"/swapup-*.json "$VM:/var/www/swapup-downloads/"
fi

echo "▸ browser versions of the apps (outside the app dir; Caddy serves /app/<app>/)"
"${SSH[@]}" 'set -e; sudo mkdir -p /var/www/swapup-web/store /var/www/swapup-web/check
  sudo chown ammar:ammar /var/www/swapup-web /var/www/swapup-web/store /var/www/swapup-web/check
  sudo grep -q "^SWAPUP_WEB_DIR=" /etc/swapup.env || echo "SWAPUP_WEB_DIR=/var/www/swapup-web" | sudo tee -a /etc/swapup.env >/dev/null'
for app in "${WEB_APPS[@]+"${WEB_APPS[@]}"}"; do
  echo "  uploading the $app browser build from $WEB_DIST/$app"
  rsync -az --delete -e "ssh $SSH_OPTS" "$WEB_DIST/$app/" "$VM:/var/www/swapup-web/$app/"
done
[ ${#WEB_APPS[@]} -gt 0 ] || echo "  no $WEB_DIST/<app>/index.html — browser versions not uploaded (the pages say \"not published yet\")"

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
web_ok=1
for app in "${WEB_APPS[@]+"${WEB_APPS[@]}"}"; do
  w=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC/app/$app/" || true)
  echo "  $PUBLIC/app/$app/ → $w"
  [ "$w" = "200" ] || web_ok=0
done
[ "$code" = "200" ] && [ "$pub" = "200" ] && [ "$web_ok" = "1" ] && echo "✓ deployed" || { echo "✗ health check failed" >&2; exit 1; }
