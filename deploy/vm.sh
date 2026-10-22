#!/usr/bin/env bash
# What a release asks of the VM, in one place (deploy/release.sh and deploy/deploy.sh both use it):
#
#   vm.sh prices            READ ONLY. Can the live site price a trade-in? Since 0.9.1 nobody types a
#                           price, so with no active rate card AND no PriceIQ key every trade-in reads
#                           "No market price yet". Then it stops (exit 1) with one plain sentence.
#                           Prints counts and set/not set — never a price, never the key.
#   vm.sh backup <name.db>  Copies the live database (SQLite online backup, then quick_check) to
#                           ~/swapup-backups/<name.db>, readable by the VM user only. Prints the path.
#   vm.sh sentences         READ ONLY. How many cases still store a sentence SwapUp has retired
#                           (REWORDED_QUOTE_TEXTS in lib/server/seed.ts, reworded on every boot); exit 1 when any.
#   vm.sh manifests         READ ONLY. The APK manifests live on /downloads, one line each: <app> <sha256> <versionCode>.
#
# The rollback (deploy.sh uses these four around the restart):
#   vm.sh health            Does the app answer on the VM? GET /login → 200 (a page; it reads the database) and
#                           GET /api/signup/programmes → 200 with its JSON (a route handler), asked up to
#                           HEALTH_TRIES times, HEALTH_WAIT seconds apart. Exit 1 when it never does.
#   vm.sh keep              Before a ship: copies the live app (everything but data/ and .next/cache) to
#                           ~/swapup-prev — only when it answers, so a release that is down never replaces the
#                           one kept before it. ~/swapup-prev.kept names the release kept, once the copy is whole.
#   vm.sh restart           pm2 restart swapup (pm2 start the first time).
#   vm.sh rollback          Puts ~/swapup-prev back in ~/swapup (never data/, .env files or .next/cache), restarts
#                           pm2 and asks the health check. Exit 1 when nothing was kept or it does not answer
#                           either. The database is left as it is: migrations only add, so the build before runs on it.
#
# FAKE_SSH=<script> sends every command through that script instead of ssh (deploy/release.test.ts and
# deploy/deploy.test.ts run this against a folder that stands in for the VM). The script receives ssh's arguments.
set -euo pipefail
VM=${VM:-ammar@104.197.168.25}
KEY=${KEY:-$HOME/.ssh/denovo_gcp}
VM_APP=${VM_APP:-swapup}                  # the app, under the VM user's home
VM_BACKUPS=${VM_BACKUPS:-swapup-backups}  # database backups, under the VM user's home
VM_ENV_FILE=${VM_ENV_FILE:-/etc/swapup.env}
VM_DOWNLOADS=${VM_DOWNLOADS:-/var/www/swapup-downloads}
VM_PREV=${VM_PREV:-swapup-prev}          # the release before, kept for a rollback, under the VM user's home
APP_PORT=${APP_PORT:-4500}               # where pm2 "swapup" listens on the VM (PORT in /etc/swapup.env)
HEALTH_TRIES=${HEALTH_TRIES:-20}         # the health check asks this many times…
HEALTH_WAIT=${HEALTH_WAIT:-2}            # …this many seconds apart
RATE_CARDS=${RATE_CARDS:-~/projects/swapup-ops/rate-cards}
SSH=("${FAKE_SSH:-ssh}" -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=15 "$VM")

# One script on the VM for every question; $1 = what to do, then its own arguments. stdin is the script
# itself, so nothing in it may read stdin (each node gets its own heredoc; pm2 gets /dev/null).
remote() {
  local what=$1
  shift
  "${SSH[@]}" "bash -s -- $(printf '%q ' "$what" "$VM_APP" "$VM_BACKUPS" "$VM_ENV_FILE" "$VM_DOWNLOADS" "$VM_PREV" "$APP_PORT" "$HEALTH_TRIES" "$HEALTH_WAIT" "$@")" <<'REMOTE'
set -euo pipefail
what=$1 APP=$2 BACKUPS=$3 ENVF=$4 DL=$5 PREV=$6 PORT=$7 TRIES=$8 WAIT=$9
shift 9
cd "$HOME"
DB="$HOME/$APP/data/swapup.db"
KEPT="$HOME/$PREV.kept"
# Does the app answer on :$PORT? /login 200, and the API's JSON from a route handler. $GOT says what came back.
answers() {
  local login out
  login=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)
  out=$(curl -s -m 5 -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/signup/programmes" || true)
  GOT="/login $login · /api/signup/programmes ${out##*$'\n'}"
  [ "$login" = 200 ] && [ "${out##*$'\n'}" = 200 ] && [[ $out == *'"programmes":'* ]]
}
healthy() {
  local i
  for i in $(seq 1 "$1"); do
    answers && return 0
    [ "$i" = "$1" ] || sleep "$WAIT"
  done
  return 1
}
# A release, as people say it: package.json's version and the build's id.
release_of() {
  printf '%s (build %s)\n' "$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n1)" "$(cat "$1/.next/BUILD_ID" 2>/dev/null || echo '?')"
}
restart_app() {
  (cd "$HOME/$APP" && chmod +x deploy/start.sh deploy/patch-caddy.sh &&
    { pm2 describe swapup >/dev/null 2>&1 && pm2 restart swapup --update-env || pm2 start deploy/start.sh --name swapup --interpreter bash; } &&
    pm2 save >/dev/null) </dev/null >&2
}
# Is NAME set to something in the env file? yes/no only — the value never leaves this function.
envset() {
  local v=""
  if [ -r "$ENVF" ]; then v=$(sed -n "s/^$1=//p" "$ENVF" | tail -n1 | tr -d "\"' \r\t")
  elif [ -e "$ENVF" ]; then v=$(sudo -n sed -n "s/^$1=//p" "$ENVF" 2>/dev/null | tail -n1 | tr -d "\"' \r\t") || v=""
  fi
  [ -n "$v" ] && echo yes || echo no
}
case $what in
  prices)
    key=$(envset PRICEIQ_API_KEY)
    if [ ! -f "$DB" ]; then echo "db=none cards=0 key=$key"; exit 0; fi
    cards=$(cd "$HOME/$APP" && node - "$DB" <<'JS'
const D = require(process.cwd() + "/node_modules/better-sqlite3");
const db = new D(process.argv[2], { readonly: true, fileMustExist: true });
const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rate_cards'").get();
console.log(t ? db.prepare("SELECT COUNT(*) n FROM rate_cards WHERE active = 1").get().n : 0);
JS
)
    echo "db=yes cards=$cards key=$key"
    ;;
  backup)
    name=$1
    [ -f "$DB" ] || { echo "none"; exit 0; }
    umask 077
    mkdir -p "$HOME/$BACKUPS"
    out="$HOME/$BACKUPS/$name"
    [ ! -e "$out" ] || { echo "$out is already there" >&2; exit 1; }
    cd "$HOME/$APP" && node - "$DB" "$out" <<'JS'
const D = require(process.cwd() + "/node_modules/better-sqlite3");
const [from, to] = process.argv.slice(2);
new D(from, { readonly: true, fileMustExist: true })
  .backup(to)
  .then(() => {
    const b = new D(to, { readonly: true, fileMustExist: true });
    const ok = b.pragma("quick_check", { simple: true });
    b.close();
    if (ok !== "ok") throw new Error(`the copy fails quick_check: ${ok}`);
    console.log(`${to} ${require("fs").statSync(to).size}`);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
JS
    ;;
  sentences)
    [ -f "$DB" ] || { echo "db=none"; exit 0; }
    cd "$HOME/$APP" && node - "$DB" <<'JS'
const D = require(process.cwd() + "/node_modules/better-sqlite3");
const db = new D(process.argv[2], { readonly: true, fileMustExist: true });
// RETIRED SENTENCES (deploy/release.test.ts checks this list against lib/server/seed.ts)
const RETIRED = [
  "No market price yet — enter a quote.",
  "No rate-card price for this model and storage — ask the partner.",
  "— check Settings, then enter the partner's quote.",
  "enter the partner's quote on the full case",
];
// END RETIRED SENTENCES
const cols = ["quote", "repaired_quote", "storage_quotes", "camera_check"];
const where = cols.flatMap((c) => RETIRED.map(() => `instr(${c}, ?) > 0`)).join(" OR ");
const n = db.prepare(`SELECT COUNT(*) n FROM cases WHERE ${where}`).get(...cols.flatMap(() => RETIRED)).n;
const count = (q) => db.prepare(q).get().n;
const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
console.log(`schema=${schema ? schema.value : "?"} cases=${count("SELECT COUNT(*) n FROM cases")} cards=${count("SELECT COUNT(*) n FROM rate_cards WHERE active = 1")} retired=${n}`);
JS
    ;;
  manifests)
    for a in store check; do
      f="$DL/swapup-$a.json"
      if [ -f "$f" ]; then
        printf '%s %s %s\n' "$a" "$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "$f")" "$(sed -n 's/.*"versionCode":\([0-9]*\).*/\1/p' "$f")"
      else
        echo "$a none none"
      fi
    done
    ;;
  health)
    if healthy "$TRIES"; then echo "ok $GOT"; else echo "no $GOT"; fi
    ;;
  keep)
    [ -f "$HOME/$APP/.next/BUILD_ID" ] || { echo none; exit 0; }
    if ! healthy "$(( TRIES < 3 ? TRIES : 3 ))"; then
      if [ -f "$KEPT" ]; then printf 'stale\n%s\n%s\n' "$(cat "$KEPT")" "$GOT"; else printf 'down\n\n%s\n' "$GOT"; fi
      exit 0
    fi
    rm -f "$KEPT"
    mkdir -p "$HOME/$PREV"
    # --checksum, here and in rollback: npm gives every package file the same mtime (1985), so rsync's
    # size+time check would keep an old copy of a changed file of the same size.
    rsync -a --checksum --delete --exclude /data --exclude /.next/cache "$HOME/$APP/" "$HOME/$PREV/"
    release_of "$HOME/$PREV" > "$KEPT"
    printf 'kept\n%s\n%s\n' "$(cat "$KEPT")" "$(du -sk "$HOME/$PREV" | cut -f1)"
    ;;
  restart)
    restart_app
    ;;
  rollback)
    [ -f "$KEPT" ] || { echo none; exit 0; }
    rsync -a --checksum --delete --exclude /data --exclude /.next/cache --exclude '/.env*' --exclude /.git --exclude /.claude "$HOME/$PREV/" "$HOME/$APP/"
    restart_app
    if healthy "$TRIES"; then st=ok; else st=down; fi
    printf '%s\n%s\n%s\n' "$st" "$(cat "$KEPT")" "$GOT"
    ;;
  *) echo "unknown: $what" >&2; exit 2 ;;
esac
REMOTE
}

what=${1:-}
case $what in
  prices)
    out=$(remote prices) || { echo "Stopping: the live database could not be read over ssh, so there is no telling whether the site can price a trade-in." >&2; exit 1; }
    db=$(printf '%s' "$out" | sed -n 's/.*db=\([a-z]*\).*/\1/p')
    cards=$(printf '%s' "$out" | sed -n 's/.*cards=\([0-9]*\).*/\1/p')
    key=$(printf '%s' "$out" | sed -n 's/.*key=\([a-z]*\).*/\1/p')
    if [ "$db" = none ]; then
      echo "  no database on the VM yet (a first deploy) — nothing to price against, check skipped"
      exit 0
    fi
    [ -n "$cards" ] && [ -n "$key" ] || { echo "Stopping: the VM's answer about prices could not be read ($out)." >&2; exit 1; }
    echo "  active rate cards: $cards · PriceIQ key: $([ "$key" = yes ] && echo set || echo "not set")"
    if [ "$cards" -eq 0 ] && [ "$key" != yes ]; then
      echo "Stopping: the live site has no active rate card and no PriceIQ key, so it can't price a single trade-in — upload this week's card at /partner/rate-cards (the files are in $RATE_CARDS) and run this again." >&2
      exit 1
    fi
    ;;
  backup)
    name=${2:?usage: vm.sh backup <name.db>}
    case $name in */* | .* | *[!A-Za-z0-9._-]*) echo "a plain file name, please: $name" >&2; exit 2 ;; esac
    out=$(remote backup "$name") || { echo "Stopping: the database backup failed, so nothing was deployed." >&2; exit 1; }
    if [ "$out" = none ]; then echo "  no database on the VM yet (a first deploy) — nothing to back up"; exit 0; fi
    echo "  backup ok: ${out% *} ($(( ${out##* } / 1024 )) KB)"
    ;;
  sentences)
    out=$(remote sentences)
    echo "  $out"
    [ "$out" = db=none ] && exit 0
    n=$(printf '%s' "$out" | sed -n 's/.*retired=\([0-9]*\).*/\1/p')
    [ "${n:-1}" -eq 0 ] || { echo "  ✗ ${n:-?} case(s) still store a sentence SwapUp has retired — the boot pass (rewordQuoteTexts) did not run or failed" >&2; exit 1; }
    ;;
  manifests)
    remote manifests
    ;;
  health)
    out=$(remote health) || { echo "  ✗ the VM could not be asked over ssh" >&2; exit 1; }
    echo "  :$APP_PORT ${out#* }"
    [ "${out%% *}" = ok ] || { echo "  ✗ the app does not answer on the VM after $HEALTH_TRIES tries" >&2; exit 1; }
    ;;
  keep)
    out=$(remote keep) || { echo "Stopping: the live release could not be copied to ~/$VM_PREV for a rollback, so nothing was shipped." >&2; exit 1; }
    st=$(sed -n 1p <<< "$out") rel=$(sed -n 2p <<< "$out") more=$(sed -n 3p <<< "$out")
    case $st in
      none) echo "  no release on the VM yet — nothing to keep, so a failed first deploy has nothing to roll back to" ;;
      kept) echo "  kept $rel in ~/$VM_PREV ($(( ${more:-0} / 1024 )) MB) — a failed deploy rolls back to it" ;;
      stale) echo "  ⚠ the live app does not answer ($more), so it is not kept — a failed deploy rolls back to $rel, kept before" ;;
      down) echo "  ⚠ the live app does not answer ($more) and nothing was kept before — a failed deploy has nothing to roll back to" ;;
      *) echo "Stopping: the VM's answer about the kept release could not be read ($out)." >&2; exit 1 ;;
    esac
    ;;
  restart)
    remote restart
    ;;
  rollback)
    out=$(remote rollback) || { echo "  ✗ the rollback failed on the VM" >&2; exit 1; }
    st=$(sed -n 1p <<< "$out") rel=$(sed -n 2p <<< "$out") got=$(sed -n 3p <<< "$out")
    case $st in
      ok) echo "  $rel is back and answers ($got)" ;;
      down) echo "  ✗ $rel is back but does not answer either ($got)" >&2; exit 1 ;;
      none) echo "  ✗ no release was kept on the VM — nothing to roll back to" >&2; exit 1 ;;
      *) echo "  ✗ the VM's answer about the rollback could not be read ($out)" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "usage: vm.sh prices | backup <name.db> | sentences | manifests | health | keep | restart | rollback" >&2
    exit 2
    ;;
esac
