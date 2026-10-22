#!/usr/bin/env bash
# Deploy SwapUp to the denovo-erp VM → https://swapup.104-197-168-25.sslip.io
#
# Builds LOCALLY in a clean copy (never on the VM — a next build there swaps and
# takes co-tenants down; never in the repo — a running dev server owns .next),
# ships the compiled app, installs production deps on the VM (better-sqlite3 is
# native and must be built for linux), and restarts pm2 "swapup".
#
# Rollback: before anything ships, the live release is kept on the VM (~/swapup-prev; deploy/vm.sh keep).
# If the ship, the install or the restart fails, or the new build then does not answer on the VM
# (/login 200 and the API's JSON; deploy/vm.sh health), the kept release is put back and pm2 restarted,
# and this script exits 1 either way. Caddy, the browser apps and the APKs are touched only once the new
# build answers, so a rolled-back deploy leaves them as they were.
#
# Tests: FAKE_SSH=<script> sends every VM command (ssh's and rsync's) through that script, to a folder
# standing in for the VM (deploy/deploy.test.ts), and VM must then be a .invalid host, which can never be
# a real machine. In that mode the gates and the next build are not run (FAKE_BUILD=<folder> is shipped as
# the build), and nothing that needs root on the VM (/etc/swapup.env, /var/www, Caddy) or the public site
# is touched.
set -euo pipefail
VM=${VM:-ammar@104.197.168.25}
KEY=${KEY:-$HOME/.ssh/denovo_gcp}
PUBLIC=${PUBLIC:-https://swapup.104-197-168-25.sslip.io}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${BUILD:-/private/tmp/claude-501/swapup-deploy}
SSH_OPTS="-i $KEY -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=15"
FAKE=${FAKE_SSH:+1}
if [ -n "$FAKE" ]; then
  case $VM in *.invalid) ;; *) echo "FAKE_SSH is for tests: VM must be a .invalid host, not $VM" >&2; exit 2 ;; esac
  [ -d "${FAKE_BUILD:-}" ] || { echo "FAKE_SSH needs FAKE_BUILD=<folder>, the build to ship" >&2; exit 2; }
fi
SSH=("${FAKE_SSH:-ssh}" $SSH_OPTS "$VM")
RSH="${FAKE_SSH:-ssh} $SSH_OPTS"
VMSH=(env VM="$VM" KEY="$KEY" bash "$ROOT/deploy/vm.sh")

# On the way out: the release guard's temp folder goes, and a deploy that stops after the ship but before
# the new build answers on the VM (ARMED) puts the release kept before it back — and exits 1 either way.
LIVE_MANIFESTS=""
ARMED=0
STAGE=""
on_exit() {
  local rc=$?
  [ -z "$LIVE_MANIFESTS" ] || rm -rf "$LIVE_MANIFESTS"
  [ "$ARMED" = 1 ] || exit $rc
  ARMED=0
  echo "▸ rollback — the deploy stopped at $STAGE"
  if "${VMSH[@]}" rollback; then
    echo "✗ ROLLED BACK: the deploy stopped at $STAGE, so the release kept before it is running again and answers. Caddy, the browser apps and the APKs were not touched. The database is as the new build left it (migrations only add; the backup from before this deploy: ${SWAPUP_DB_BACKUP:-in ~/swapup-backups})." >&2
  else
    echo "✗ DOWN: the deploy stopped at $STAGE and the rollback did not bring the release before it back — the site is down. Look at pm2 logs swapup on the VM (the database backup from before this deploy: ${SWAPUP_DB_BACKUP:-in ~/swapup-backups})." >&2
  fi
  exit 1
}
trap on_exit EXIT

if [ -n "$FAKE" ]; then
  echo "▸ FAKE_SSH ($VM): the gates and the build are not run — shipping $FAKE_BUILD"
else
  echo "▸ gates: domain tests + typecheck"
  (cd "$ROOT" && npm test >/dev/null && npx tsc --noEmit -p .)

  # No bundled price file, ever (owner, 2026-10-18: PriceIQ live, no snapshot). Prices come from
  # PriceIQ's API or an uploaded partner rate card — never a CSV in the app, never a typed price.
  echo "▸ gate: no bundled price file"
  stray=$(cd "$ROOT" && find app components lib public -type f -name '*.csv' 2>/dev/null || true)
  if [ -n "$stray" ]; then echo "✗ a CSV in the app — prices come from PriceIQ live, not a bundled file:" >&2; echo "$stray" >&2; exit 1; fi

  # The release guard (deploy/release-guard.sh, no override): every browser build and APK that would
  # ship is clean, built from swapup-mobile's HEAD, and no APK reuses a versionCode live on /downloads.
  # The live manifests are read off the VM first (none yet → nothing to compare against).
  MOBILE=${MOBILE:-$ROOT/../swapup-mobile}
  echo "▸ gate: release guard (browser builds + APKs)"
  LIVE_MANIFESTS=$(mktemp -d)
  scp -q $SSH_OPTS "$VM:/var/www/swapup-downloads/swapup-*.json" "$LIVE_MANIFESTS/" 2>/dev/null || echo "  no live APK manifests on the VM yet"
  bash "$ROOT/deploy/release-guard.sh" "$MOBILE" "${WEB_DIST:-$MOBILE/dist-web}" "${MOBILE_DIST:-$MOBILE/dist}" "$LIVE_MANIFESTS"

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
  # stdin — never a command line, never echoed. No key yet → skipped, loudly: trade-ins are then priced
  # from the partner's rate card only until one is added.
  echo "▸ gate: PriceIQ answers on the VM"
  priceiq_env_defaults
  "${SSH[@]}" "bash -s -- $PRICEIQ_DEFAULT_BASE" <<'REMOTE'
F=/etc/swapup.env
val() { sudo test -f "$F" && sudo sed -n "s/^$1=//p" "$F" | tail -n1 | tr -d "\"' \r\t"; }
BASE=$(val PRICEIQ_BASE_URL); BASE=${BASE:-$1}; BASE=${BASE%/}
KEY=$(val PRICEIQ_API_KEY)
if [ -z "$KEY" ]; then
  echo "  ⚠ PRICEIQ_API_KEY is not in $F — gate SKIPPED. Trade-ins are priced from the rate card only until a read-only key is added."
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

  # Gate: the live site can price a trade-in. Since 0.9.1 nobody types a price (owner, 2026-10-19), so
  # with no active rate card AND no PriceIQ key every trade-in would read "No market price yet". Read
  # only (deploy/vm.sh prices); it stops with one sentence saying where the rate cards are.
  echo "▸ gate: the live site can price a trade-in"
  "${VMSH[@]}" prices
fi

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

if [ -n "$FAKE" ]; then
  BUILD=$FAKE_BUILD
else
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
fi

# Every deploy leaves a timestamped copy of the live database in ~/swapup-backups on the VM, taken
# before anything ships (a new build migrates the database when it starts). deploy/release.sh takes it
# itself and says so in SWAPUP_DB_BACKUP.
echo "▸ live database backup"
if [ -n "${SWAPUP_DB_BACKUP:-}" ]; then
  echo "  taken by release.sh: $SWAPUP_DB_BACKUP"
else
  "${VMSH[@]}" backup "swapup-pre-$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")-$(date -u +%Y%m%dT%H%M%SZ).db"
fi

# The rollback: the release that answers now is kept on the VM first. From the ship until the new build
# answers on the VM, anything that fails (the ship, npm install, the env, the restart, the health check)
# puts it back and exits 1 (on_exit, above).
echo "▸ keep the live release for a rollback"
"${VMSH[@]}" keep

echo "▸ ship"
STAGE="the ship"
ARMED=1
"${SSH[@]}" "mkdir -p ~/swapup/data"
rsync -az --delete -e "$RSH" \
  --exclude node_modules --exclude data --exclude .git --exclude '.env*' --exclude '.next/cache' --exclude '.claude' \
  "$BUILD/" "$VM:~/swapup/"

echo "▸ production deps on the VM"
STAGE="npm install on the VM"
"${SSH[@]}" "cd ~/swapup && npm install --omit=dev --no-audit --no-fund --loglevel=error"

if [ -z "$FAKE" ]; then
  STAGE="the env file and folders on the VM"
  echo "▸ env (secret minted once, then reused — rotating it signs everyone out)"
  "${SSH[@]}" 'sudo test -f /etc/swapup.env || { S=$(openssl rand -hex 32); printf "NODE_ENV=production\nPORT=4500\nSWAPUP_SESSION_SECRET=%s\n" "$S" | sudo tee /etc/swapup.env >/dev/null; sudo chown root:ammar /etc/swapup.env; sudo chmod 640 /etc/swapup.env; echo minted; }'
  gradeiq_env_defaults # a first deploy mints the file above, after the gate ran on the defaults
  priceiq_env_defaults

  echo "▸ folders for the Android apps and the browser apps (outside the app dir; Caddy serves /app/<app>/)"
  "${SSH[@]}" 'set -e; sudo mkdir -p /var/www/swapup-downloads; sudo chown ammar:ammar /var/www/swapup-downloads
    sudo grep -q "^SWAPUP_DOWNLOADS_DIR=" /etc/swapup.env || echo "SWAPUP_DOWNLOADS_DIR=/var/www/swapup-downloads" | sudo tee -a /etc/swapup.env >/dev/null
    sudo grep -q "^SWAPUP_PUBLIC_URL=" /etc/swapup.env || echo "SWAPUP_PUBLIC_URL=https://swapup.104-197-168-25.sslip.io" | sudo tee -a /etc/swapup.env >/dev/null'
  "${SSH[@]}" 'set -e; sudo mkdir -p /var/www/swapup-web/store /var/www/swapup-web/check
    sudo chown ammar:ammar /var/www/swapup-web /var/www/swapup-web/store /var/www/swapup-web/check
    sudo grep -q "^SWAPUP_WEB_DIR=" /etc/swapup.env || echo "SWAPUP_WEB_DIR=/var/www/swapup-web" | sudo tee -a /etc/swapup.env >/dev/null'
fi

echo "▸ pm2"
STAGE="the pm2 restart"
"${VMSH[@]}" restart

echo "▸ health on the VM (/login and the API)"
STAGE="the health check (the new build does not answer on the VM)"
"${VMSH[@]}" health
ARMED=0

if [ -n "$FAKE" ]; then
  echo "✓ deployed (FAKE_SSH: Caddy, the uploads and the public site not touched)"
  exit 0
fi

echo "▸ caddy"
"${SSH[@]}" "bash ~/swapup/deploy/patch-caddy.sh"

# The APKs and the browser apps go up only now that the new server answers, so a rolled-back deploy
# leaves the ones that match the release still running.
echo "▸ Android apps"
MOBILE_DIST=${MOBILE_DIST:-$ROOT/../swapup-mobile/dist}
if ls "$MOBILE_DIST"/swapup-*.apk >/dev/null 2>&1; then
  echo "  uploading APKs from $MOBILE_DIST"
  rsync -az -e "$RSH" "$MOBILE_DIST"/swapup-*.apk "$MOBILE_DIST"/swapup-*.json "$VM:/var/www/swapup-downloads/"
fi

echo "▸ browser versions of the apps"
for app in "${WEB_APPS[@]+"${WEB_APPS[@]}"}"; do
  echo "  uploading the $app browser build from $WEB_DIST/$app"
  rsync -az --delete -e "$RSH" "$WEB_DIST/$app/" "$VM:/var/www/swapup-web/$app/"
done
[ ${#WEB_APPS[@]} -gt 0 ] || echo "  no $WEB_DIST/<app>/index.html — browser versions not uploaded (the pages say \"not published yet\")"

echo "▸ public health"
pub=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC/login" || true)
echo "  $PUBLIC/login → $pub"
web_ok=1
for app in "${WEB_APPS[@]+"${WEB_APPS[@]}"}"; do
  w=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC/app/$app/" || true)
  echo "  $PUBLIC/app/$app/ → $w"
  [ "$w" = "200" ] || web_ok=0
done
[ "$pub" = "200" ] && [ "$web_ok" = "1" ] && echo "✓ deployed" || { echo "✗ health check failed on $PUBLIC — the new build answers on the VM, so it was not rolled back: look at Caddy and /var/www/swapup-web" >&2; exit 1; }
