#!/usr/bin/env bash
# Release SwapUp: the server, both browser apps and both Android apps, from the committed HEADs of
# this repo and ../swapup-mobile — never from a working tree.
#
#   bash deploy/release.sh 0.9.1               build (or reuse the kept build) → can the live site price a
#                                              trade-in? → back up the live database → deploy/deploy.sh →
#                                              verify → record the APKs in deploy/RELEASES.json
#   BUILD_ONLY=1 bash deploy/release.sh 0.9.1  build (or check the kept build) only; nothing on the VM
#   bash deploy/release.sh 0.9.1 --plan        say what a release would do (DRY_RUN=1 too): builds nothing,
#                                              backs up nothing, deploys nothing; the price check is read only
#
# The version you name must be the one in swapup-mobile's app.json and app.config.js and in this repo's
# package.json. Both repos must have no uncommitted changes.
#
# Builds are kept OUTSIDE git and /private/tmp (macOS clears it; a cold APK build is ~2.5 h), in
# $RELEASE_WORK (default ~/projects/swapup-release-work):
#   <version>/dist/       the two APKs + manifests      <version>/dist-web/  the two browser builds
#   <version>/BUILT.json  what was built (sha256s)       <version>/logs/      build, deploy logs
#   src/                  clean worktrees of both repos  apk-work/, next-build/  build folders, reused
# A kept build is reused only when it was built from swapup-mobile's HEAD for this version and versionCode
# and every APK's sha256 is its manifest's and BUILT.json's (deploy/release-builds.mjs); otherwise it is
# refused, never shipped.
#
# Rate cards (the partner's weekly price sheets) live in ~/projects/swapup-ops/rate-cards — uploaded on the
# live site, never shipped.
#
# Tests: FAKE_SSH=<script> sends every VM command through that script (a folder standing in for the VM) and
# then deploy.sh is NOT run (FAKE_DEPLOY=<script> runs instead, if set) and the public site is not
# fetched. deploy/release.test.ts.
set -euo pipefail
export PATH=$HOME/.local/share/fnm/aliases/default/bin:$PATH

HERE=$(cd "$(dirname "$0")" && pwd)
SWAPUP_REPO=${SWAPUP_REPO:-$(cd "$HERE/.." && pwd)}
MOBILE_REPO=${MOBILE_REPO:-$SWAPUP_REPO/../swapup-mobile}
RW=${RELEASE_WORK:-$HOME/projects/swapup-release-work}
PUBLIC=${PUBLIC:-https://swapup.104-197-168-25.sslip.io}
PLAN=${DRY_RUN:-0}
VER=""
for a in "$@"; do
  case $a in
    --plan | --dry-run) PLAN=1 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) VER=$a ;;
  esac
done
[ -n "$VER" ] || { echo "usage: bash deploy/release.sh <version> [--plan]   (BUILD_ONLY=1 to build only)" >&2; exit 2; }
[ -d "$MOBILE_REPO/.git" ] || [ -f "$MOBILE_REPO/.git" ] || { echo "Stopping: no swapup-mobile repo at $MOBILE_REPO (set MOBILE_REPO)." >&2; exit 1; }
MOBILE_REPO=$(cd "$MOBILE_REPO" && pwd)
FAKE=${FAKE_SSH:+1}
VMSH=(bash "$HERE/vm.sh")
stop() { echo "$*" >&2; exit 1; }

# ── 1. what is being released ────────────────────────────────────────────────────────────────────
for r in "$SWAPUP_REPO" "$MOBILE_REPO"; do
  [ -z "$(git -C "$r" status --porcelain --untracked-files=no)" ] || stop "Stopping: $r has uncommitted changes — commit or stash them first."
done
S_FULL=$(git -C "$SWAPUP_REPO" rev-parse HEAD)
M_FULL=$(git -C "$MOBILE_REPO" rev-parse HEAD)
S_COMMIT=${S_FULL:0:7}
M_COMMIT=${M_FULL:0:7}
read -r APP_JSON CFG_VER VC < <(cd "$MOBILE_REPO" && APP_VARIANT=store node -e '
  const c = require("./app.config.js"); const x = typeof c === "function" ? c({ config: {} }) : c;
  console.log(require("./app.json").expo.version, x.version, x.android.versionCode)') ||
  stop "Stopping: swapup-mobile's app.json and app.config.js could not be read."
PKG=$(node -p 'require(process.argv[1]).version' "$SWAPUP_REPO/package.json")
for v in "app.json:$APP_JSON" "app.config.js:$CFG_VER" "package.json:$PKG"; do
  [ "${v#*:}" = "$VER" ] || stop "Stopping: you asked for $VER but ${v%%:*} says ${v#*:}."
done
[[ "$VC" =~ ^[0-9]+$ ]] || stop "Stopping: app.config.js has no android.versionCode."
echo "▸ release $VER — swapup $S_COMMIT ($(git -C "$SWAPUP_REPO" rev-parse --abbrev-ref HEAD)) · swapup-mobile $M_COMMIT, versionCode $VC"

VDIR=$RW/$VER
LOGS=$VDIR/logs
SRC=$RW/src
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_NAME=swapup-pre-$VER-$STAMP.db

# ── 2. the builds: kept, or to be built ──────────────────────────────────────────────────────────
echo "▸ builds ($VDIR)"
set +e
node "$HERE/release-builds.mjs" check "$VDIR" "$MOBILE_REPO" "$VER" "$VC"
kept=$?
set -e
case $kept in
  0) NEED_BUILD=0 ;;
  3) NEED_BUILD=1 ;;
  *) exit 1 ;; # refused: release-builds.mjs said why
esac

# ── 3. can the live site price a trade-in? (read only; not needed to build) ─────────────────────
if [ "${BUILD_ONLY:-0}" != 1 ]; then
  echo "▸ prices on the live site (read only)"
  "${VMSH[@]}" prices
fi

if [ "$PLAN" = 1 ]; then
  echo "PLAN — nothing built, backed up or deployed. A real run would:"
  [ "$NEED_BUILD" = 1 ] && echo "  • build both browser apps and both APKs from swapup-mobile $M_COMMIT in $SRC (warm ~5 min, cold ~2.5 h) and keep them in $VDIR" \
    || echo "  • use the kept builds in $VDIR"
  if [ "${BUILD_ONLY:-0}" != 1 ]; then
    echo "  • back up the live database to ~/swapup-backups/$BACKUP_NAME"
    echo "  • deploy: (cd $SRC/swapup && MOBILE=$MOBILE_REPO WEB_DIST=$VDIR/dist-web MOBILE_DIST=$VDIR/dist BUILD=$RW/next-build bash deploy/deploy.sh)"
    echo "  • verify the versions served, /downloads, the partner's name absent, no retired sentence stored"
    echo "  • record both APKs (version, versionCode, commit, sha256) in $SWAPUP_REPO/deploy/RELEASES.json"
  fi
  exit 0
fi

# A fresh worktree of <repo> at <commit> in $SRC/<name>, with the repo's installed packages (APFS clone).
worktree() {
  local repo=$1 name=$2 commit=$3
  mkdir -p "$SRC"
  git -C "$repo" worktree remove --force "$SRC/$name" 2>/dev/null || rm -rf "${SRC:?}/$name"
  git -C "$repo" worktree prune
  git -C "$repo" worktree add -q --detach "$SRC/$name" "$commit"
  cp -cR "$repo/node_modules" "$SRC/$name/node_modules"
}

if [ "$NEED_BUILD" = 1 ]; then
  echo "▸ build from swapup-mobile $M_COMMIT (logs in $LOGS)"
  mkdir -p "$LOGS"
  worktree "$MOBILE_REPO" swapup-mobile "$M_FULL"
  echo "  browser apps"
  (cd "$SRC/swapup-mobile" && bash scripts/export-web.sh all > "$LOGS/web.log" 2>&1) || stop "Stopping: the browser build failed — see $LOGS/web.log."
  for v in check store; do
    echo "  Android app: $v"
    (cd "$SRC/swapup-mobile" && WORK="$RW/apk-work/$v" bash scripts/build-apk.sh "$v" > "$LOGS/apk-$v.log" 2>&1) || stop "Stopping: the $v APK build failed — see $LOGS/apk-$v.log."
    tail -1 "$LOGS/apk-$v.log"
  done
  rm -rf "$VDIR/dist" "$VDIR/dist-web" "$VDIR/BUILT.json"
  mkdir -p "$VDIR/dist"
  for a in store check; do cp -p "$SRC/swapup-mobile/dist/swapup-$a.apk" "$SRC/swapup-mobile/dist/swapup-$a.json" "$VDIR/dist/"; done
  cp -pR "$SRC/swapup-mobile/dist-web" "$VDIR/dist-web"
  node "$HERE/release-builds.mjs" stamp "$VDIR" "$MOBILE_REPO" "$VER" "$VC" "built $(date -u +%FT%TZ) by deploy/release.sh (swapup $S_COMMIT)"
  node "$HERE/release-builds.mjs" check "$VDIR" "$MOBILE_REPO" "$VER" "$VC"
fi

if [ "${BUILD_ONLY:-0}" = 1 ]; then
  echo "BUILD_ONLY: $VER (swapup-mobile $M_COMMIT, versionCode $VC) is in $VDIR — nothing on the VM touched."
  exit 0
fi

# ── 4. back up the live database, before the restart ───────────────────────────────────────────
echo "▸ live database backup"
backup_out=$("${VMSH[@]}" backup "$BACKUP_NAME")
echo "$backup_out"
case $backup_out in
  *"backup ok: "*) BACKUP=$(printf '%s' "$backup_out" | sed -n 's/.*backup ok: \([^ ]*\).*/\1/p') ;;
  *) BACKUP="none (no database yet)" ;;
esac

# ── 5. deploy ────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$LOGS"
DEPLOY_LOG=$LOGS/deploy-$STAMP.log
DEPLOY_ENV=(MOBILE="$MOBILE_REPO" WEB_DIST="$VDIR/dist-web" MOBILE_DIST="$VDIR/dist" BUILD="$RW/next-build" SWAPUP_DB_BACKUP="$BACKUP")
echo "▸ deploy (server + browser apps + APKs; log $DEPLOY_LOG)"
if [ -n "$FAKE" ]; then
  if [ -n "${FAKE_DEPLOY:-}" ]; then env "${DEPLOY_ENV[@]}" bash "$FAKE_DEPLOY" > "$DEPLOY_LOG" 2>&1 || { tail -20 "$DEPLOY_LOG"; stop "Stopping: the deploy failed — see $DEPLOY_LOG."; }
  else echo "  FAKE_SSH: deploy.sh not run" > "$DEPLOY_LOG"; fi
else
  worktree "$SWAPUP_REPO" swapup "$S_FULL"
  (cd "$SRC/swapup" && env "${DEPLOY_ENV[@]}" bash deploy/deploy.sh) > "$DEPLOY_LOG" 2>&1 || { tail -30 "$DEPLOY_LOG"; stop "Stopping: deploy.sh failed — see $DEPLOY_LOG (the database backup is $BACKUP)."; }
fi
grep -E "✓ deployed|→|FAKE_SSH" "$DEPLOY_LOG" | tail -8 || true

# ── 6. verify ────────────────────────────────────────────────────────────────────────────────────
echo "▸ verify"
FAILED=()
"${VMSH[@]}" sentences || FAILED+=("a retired sentence is still stored")
live=$("${VMSH[@]}" manifests) || { live=""; FAILED+=("the live APK manifests could not be read"); }
while read -r app sha code; do
  [ -n "$app" ] || continue
  want=$(node -p 'require(process.argv[1]).sha256' "$VDIR/dist/swapup-$app.json")
  if [ "$sha" = "$want" ]; then echo "  /downloads $app: versionCode $code, sha256 ${sha:0:12}… (this release)"
  else echo "  ✗ /downloads $app: sha256 ${sha:0:12}…, not this release's ${want:0:12}…"; FAILED+=("/downloads $app is not this release's APK"); fi
done <<< "$live"
if [ -n "$FAKE" ]; then
  echo "  FAKE_SSH: the public site is not fetched"
else
  for a in check store; do
    got=$(curl -s -m 15 "$PUBLIC/app/$a/version.json" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const d = JSON.parse(s); console.log(`${d.version} ${d.commit} ${d.dirty === false ? "clean" : "dirty"}`); } catch { console.log("unreadable"); }
      })')
    echo "  /app/$a/version.json: $got"
    read -r gv gc gd <<< "$got"
    [ "$gv" = "$VER" ] && [ -n "${gc:-}" ] && [[ "$M_FULL" == "$gc"* ]] && [ "${gd:-}" = clean ] || FAILED+=("/app/$a serves $got, not $VER $M_COMMIT clean")
  done
  for pg in /login /downloads /app/check/ /app/store/; do
    named=$(curl -s -m 20 -L "$PUBLIC$pg" | node --experimental-strip-types --no-warnings --input-type=module -e "
      import { namesBrand } from '$SWAPUP_REPO/lib/domain/testing/brand.ts';
      let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => console.log(namesBrand(s) ? 'yes' : 'no'));")
    if [ "$named" = no ]; then echo "  $pg: the partner is not named"; else echo "  ✗ $pg names the partner"; FAILED+=("$pg names the partner"); fi
  done
  n=$(curl -s -m 15 "$PUBLIC/downloads" | grep -o -F "$VER" | wc -l | tr -d ' ')
  echo "  /downloads mentions $VER $n time(s)"
  [ "$n" -gt 0 ] || FAILED+=("/downloads does not show $VER")
fi

# ── 7. record ────────────────────────────────────────────────────────────────────────────────────
if [ ${#FAILED[@]} -eq 0 ]; then VERIFY=passed; else VERIFY="failed: $(IFS=';'; echo "${FAILED[*]}")"; fi
node "$HERE/release-builds.mjs" record "$VDIR" "$SWAPUP_REPO/deploy/RELEASES.json" "$S_COMMIT" "$BACKUP" "$VERIFY"
echo "  commit it: git -C $SWAPUP_REPO commit -m \"Release $VER: record\" deploy/RELEASES.json"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ $VER is deployed but did not verify — $(IFS=';'; echo "${FAILED[*]}") (database backup $BACKUP)" >&2
  exit 1
fi
echo "RELEASED $VER (swapup $S_COMMIT, swapup-mobile $M_COMMIT, versionCode $VC); database backup $BACKUP"
