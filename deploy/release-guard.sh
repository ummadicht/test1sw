#!/usr/bin/env bash
# The release guard (deploy.sh runs it before anything ships; no override). It refuses:
#   • a browser build (dist-web/<app>/version.json) or an APK manifest (dist/swapup-<app>.json)
#     built from a dirty tree — "dirty": true, or no "dirty" at all (an older build script);
#   • one whose "commit" is not the swapup-mobile HEAD it claims to be built from;
#   • an APK whose versionCode is reused: not above the one live on /downloads, for a different
#     APK (sha256). A live manifest with no versionCode predates them: it was at most 11 (0.8.0).
# Only what is there to ship is checked (deploy.sh uploads what it finds). Read only.
#
# Usage: release-guard.sh <swapup-mobile repo> <dist-web dir> <dist dir> [dir with the live swapup-<app>.json]
set -euo pipefail
MOBILE=${1:?swapup-mobile repo}
WEB_DIST=${2:?dist-web dir}
APK_DIST=${3:?dist dir}
LIVE=${4:-}
HEAD=$(git -C "$MOBILE" rev-parse HEAD)

node - "$MOBILE" "$HEAD" "$WEB_DIST" "$APK_DIST" "$LIVE" <<'NODE'
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const [mobile, head, webDist, apkDist, live] = process.argv.slice(2);
/** The last versionCode published before the manifests carried one (0.8.0). */
const LEGACY_VERSION_CODE = 11;
const problems = [];
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const isHead = (c) => {
  if (typeof c !== "string" || !/^[0-9a-f]{7,40}$/i.test(c)) return false;
  try {
    return execFileSync("git", ["-C", mobile, "rev-parse", "--verify", "--quiet", `${c}^{commit}`]).toString().trim() === head;
  } catch {
    return false;
  }
};
const clean = (where, m) => {
  if (m.dirty !== false) problems.push(`${where}: built from a dirty tree (dirty: ${JSON.stringify(m.dirty)}) — commit swapup-mobile, then build it again`);
  if (!isHead(m.commit)) problems.push(`${where}: built from ${m.commit ? `commit ${m.commit}` : "no recorded commit"}, not swapup-mobile HEAD ${head.slice(0, 7)} — build it again`);
};

for (const app of ["store", "check"]) {
  if (!fs.existsSync(path.join(webDist, app, "index.html"))) continue;
  const where = `dist-web/${app}/version.json`;
  const v = read(path.join(webDist, app, "version.json"));
  if (!v) problems.push(`${where}: missing or unreadable — export it again (scripts/export-web.sh)`);
  else clean(where, v);
}

for (const app of ["store", "check"]) {
  if (!fs.existsSync(path.join(apkDist, `swapup-${app}.apk`))) continue;
  const where = `dist/swapup-${app}.json`;
  const m = read(path.join(apkDist, `swapup-${app}.json`));
  if (!m) {
    problems.push(`${where}: missing or unreadable — build the APK again (scripts/build-apk.sh ${app})`);
    continue;
  }
  clean(where, m);
  if (!Number.isInteger(m.versionCode)) {
    problems.push(`${where}: no versionCode — build the APK again (scripts/build-apk.sh ${app})`);
    continue;
  }
  const l = live ? read(path.join(live, `swapup-${app}.json`)) : undefined;
  if (l && l.sha256 !== m.sha256) {
    const liveCode = Number.isInteger(l.versionCode) ? l.versionCode : LEGACY_VERSION_CODE;
    if (m.versionCode <= liveCode)
      problems.push(`${where}: versionCode ${m.versionCode} is not above the live one (${liveCode}) for a different APK — bump versionCode in app.config.js`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error("✗ release guard: not shipping.");
  process.exit(1);
}
console.log(`  release guard: browser builds and APKs are clean, from swapup-mobile ${head.slice(0, 7)}, no versionCode reused`);
NODE
