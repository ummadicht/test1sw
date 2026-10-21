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
# FAKE_SSH=<script> sends every command through that script instead of ssh (deploy/release.test.ts runs
# this against a folder that stands in for the VM). The script receives ssh's arguments.
set -euo pipefail
VM=${VM:-ammar@104.197.168.25}
KEY=${KEY:-$HOME/.ssh/denovo_gcp}
VM_APP=${VM_APP:-swapup}                  # the app, under the VM user's home
VM_BACKUPS=${VM_BACKUPS:-swapup-backups}  # database backups, under the VM user's home
VM_ENV_FILE=${VM_ENV_FILE:-/etc/swapup.env}
VM_DOWNLOADS=${VM_DOWNLOADS:-/var/www/swapup-downloads}
RATE_CARDS=${RATE_CARDS:-~/projects/swapup-ops/rate-cards}
SSH=("${FAKE_SSH:-ssh}" -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=15 "$VM")

# One script on the VM for every question; $1 = what to do. stdin is the script itself, so nothing in it
# may read stdin (each node gets its own heredoc).
remote() {
  "${SSH[@]}" "bash -s -- $(printf '%q ' "$@")" <<'REMOTE'
set -euo pipefail
what=$1 APP=$2 BACKUPS=$3 ENVF=$4 DL=$5
cd "$HOME"
DB="$HOME/$APP/data/swapup.db"
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
    name=$6
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
  *) echo "unknown: $what" >&2; exit 2 ;;
esac
REMOTE
}

what=${1:-}
case $what in
  prices)
    out=$(remote prices "$VM_APP" "$VM_BACKUPS" "$VM_ENV_FILE" "$VM_DOWNLOADS") || { echo "Stopping: the live database could not be read over ssh, so there is no telling whether the site can price a trade-in." >&2; exit 1; }
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
    out=$(remote backup "$VM_APP" "$VM_BACKUPS" "$VM_ENV_FILE" "$VM_DOWNLOADS" "$name") || { echo "Stopping: the database backup failed, so nothing was deployed." >&2; exit 1; }
    if [ "$out" = none ]; then echo "  no database on the VM yet (a first deploy) — nothing to back up"; exit 0; fi
    echo "  backup ok: ${out% *} ($(( ${out##* } / 1024 )) KB)"
    ;;
  sentences)
    out=$(remote sentences "$VM_APP" "$VM_BACKUPS" "$VM_ENV_FILE" "$VM_DOWNLOADS")
    echo "  $out"
    [ "$out" = db=none ] && exit 0
    n=$(printf '%s' "$out" | sed -n 's/.*retired=\([0-9]*\).*/\1/p')
    [ "${n:-1}" -eq 0 ] || { echo "  ✗ ${n:-?} case(s) still store a sentence SwapUp has retired — the boot pass (rewordQuoteTexts) did not run or failed" >&2; exit 1; }
    ;;
  manifests)
    remote manifests "$VM_APP" "$VM_BACKUPS" "$VM_ENV_FILE" "$VM_DOWNLOADS"
    ;;
  *)
    echo "usage: vm.sh prices | backup <name.db> | sentences | manifests" >&2
    exit 2
    ;;
esac
