/**
 * deploy/release.sh, run for real against throwaway repos and a folder that stands in for the VM
 * (FAKE_SSH): never the VM, never deploy.sh (FAKE_DEPLOY stands in for it), never the public site.
 *
 *   - no active rate card and no PriceIQ key → it stops with one plain sentence, before any backup;
 *   - an active card → it backs up the live database, then deploys, verifies and records the APKs;
 *   - a deploy that deploy.sh rolled back (or could not) → one sentence saying which; nothing recorded;
 *   - a kept build whose APK isn't its manifest's (sha256) is refused before the VM is asked anything;
 *   - --plan changes nothing; a dirty tree or a version the repos don't say is refused;
 *   - vm.sh's list of retired sentences is lib/server/seed.ts's.
 *
 * Run: node --test --experimental-strip-types --no-warnings deploy/release.test.ts
 */
import "../lib/server/testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = mkdtempSync(join(tmpdir(), "swapup-release-"));
after(() => rmSync(T, { recursive: true, force: true }));
// Importing lib/server (the last test) must never open a real database.
process.env.SWAPUP_DB = join(T, "seed.db");

const VER = "9.9.9";
const VC = 99;
const APPS = ["store", "check"] as const;
const git = (repo: string, ...a: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function repo(dir: string, files: Record<string, string>): void {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

// ── the two repos ──
const MOBILE = join(T, "swapup-mobile");
repo(MOBILE, {
  "app.json": JSON.stringify({ expo: { version: VER } }),
  "app.config.js": `module.exports = () => ({ version: "${VER}", android: { versionCode: ${VC} } });\n`,
});
const SWAPUP = join(T, "swapup");
repo(SWAPUP, { "package.json": JSON.stringify({ name: "swapup", version: VER }), "deploy/RELEASES.json": JSON.stringify({ releases: [] }) + "\n" });
const M = git(MOBILE, "rev-parse", "--short", "HEAD");

// ── the kept builds, as release.sh leaves them ──
const WORK = join(T, "work");
const VDIR = join(WORK, VER);
const SHA: Record<string, string> = {};
for (const app of APPS) {
  const apk = randomBytes(4096);
  SHA[app] = sha256(apk);
  mkdirSync(join(VDIR, "dist"), { recursive: true });
  writeFileSync(join(VDIR, "dist", `swapup-${app}.apk`), apk);
  const manifest = { app, version: VER, versionCode: VC, commit: M, dirty: false, bytes: apk.length, sha256: SHA[app], builtAt: "2026-10-21T00:00:00Z" };
  writeFileSync(join(VDIR, "dist", `swapup-${app}.json`), JSON.stringify(manifest));
  mkdirSync(join(VDIR, "dist-web", app), { recursive: true });
  writeFileSync(join(VDIR, "dist-web", app, "index.html"), `<!doctype html><title>${app}</title>`);
  const web = { variant: app, version: VER, commit: M, dirty: false, bundle: `/app/${app}/_expo/static/js/web/index.js`, builtAt: "2026-10-21T00:00:00Z" };
  writeFileSync(join(VDIR, "dist-web", app, "version.json"), JSON.stringify(web));
}
execFileSync("node", [join(ROOT, "deploy/release-builds.mjs"), "stamp", VDIR, MOBILE, VER, String(VC), "test"], { stdio: "pipe" });

// ── the folder standing in for the VM: ~/swapup with its database, /etc/swapup.env, /var/www/swapup-downloads ──
const VM = join(T, "vm");
const ENV_FILE = join(VM, "etc", "swapup.env");
const DOWNLOADS = join(VM, "downloads");
mkdirSync(join(VM, "swapup", "data"), { recursive: true });
mkdirSync(join(VM, "etc"));
mkdirSync(DOWNLOADS);
symlinkSync(join(ROOT, "node_modules"), join(VM, "swapup", "node_modules"));
const LIVE_DB = join(VM, "swapup", "data", "swapup.db");
{
  const d = new Database(LIVE_DB);
  d.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '17');
    CREATE TABLE rate_cards (id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cases (id TEXT PRIMARY KEY, ref TEXT, quote TEXT, repaired_quote TEXT, storage_quotes TEXT, camera_check TEXT);
    INSERT INTO cases (id, ref, quote) VALUES ('c1', 'SU-AND-00001', '{"reason":"No market price"}');`);
  d.close();
}
const live = (sql: string, ...p: unknown[]) => {
  const d = new Database(LIVE_DB);
  d.prepare(sql).run(...p);
  d.close();
};
writeFileSync(ENV_FILE, "NODE_ENV=production\nPORT=4500\n");

// ssh's stand-in: drops ssh's options and the host, logs the command, runs it in the VM folder as home.
const FAKE_SSH = join(T, "fake-ssh");
writeFileSync(
  FAKE_SSH,
  `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case $1 in -i|-o|-p|-l|-F) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
echo "$*" >> "${VM}/ssh.log"
cd "${VM}" && HOME="${VM}" exec bash -c "$*"
`
);
chmodSync(FAKE_SSH, 0o755);
// deploy.sh's stand-in: refuses to run without the backup already on disk, then publishes the manifests.
const FAKE_DEPLOY = join(T, "fake-deploy");
writeFileSync(
  FAKE_DEPLOY,
  `#!/usr/bin/env bash
set -euo pipefail
test -f "$SWAPUP_DB_BACKUP" || { echo "no backup before the deploy" >&2; exit 1; }
cp "$MOBILE_DIST"/swapup-*.json "${DOWNLOADS}/"
echo "$SWAPUP_DB_BACKUP" > "${VM}/deployed"
echo "✓ deployed"
`
);

function release(args: string[], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["BUILD_ONLY", "DRY_RUN", "PUBLIC", "SWAPUP_DB_BACKUP", "VM_APP", "VM_BACKUPS", "RATE_CARDS"]) delete env[k];
  Object.assign(env, {
    FAKE_SSH,
    FAKE_DEPLOY,
    VM: "nobody@vm.invalid",
    KEY: "/dev/null",
    SWAPUP_REPO: SWAPUP,
    MOBILE_REPO: MOBILE,
    RELEASE_WORK: WORK,
    VM_ENV_FILE: ENV_FILE,
    VM_DOWNLOADS: DOWNLOADS,
    ...extra,
  });
  const r = spawnSync("bash", [join(ROOT, "deploy/release.sh"), ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr, stderr: r.stderr };
}
const backups = () => (existsSync(join(VM, "swapup-backups")) ? readdirSync(join(VM, "swapup-backups")) : []);
const sshCalls = () => (existsSync(join(VM, "ssh.log")) ? readFileSync(join(VM, "ssh.log"), "utf8").trim().split("\n").length : 0);
const releases = () => JSON.parse(readFileSync(join(SWAPUP, "deploy/RELEASES.json"), "utf8")) as { releases: Record<string, unknown>[] };
function reset(): void {
  git(SWAPUP, "checkout", "--", "deploy/RELEASES.json");
  rmSync(join(VM, "swapup-backups"), { recursive: true, force: true });
  rmSync(join(VM, "deployed"), { force: true });
  for (const f of readdirSync(DOWNLOADS)) rmSync(join(DOWNLOADS, f));
}

test("no active rate card and no PriceIQ key: it stops with one plain sentence, before any backup or deploy", () => {
  const r = release([VER]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(
    r.stderr.trim(),
    /^Stopping: the live site has no active rate card and no PriceIQ key, so it can't price a single trade-in — upload this week's card at \/partner\/rate-cards \(the files are in [^\n]+\) and run this again\.$/
  );
  assert.match(r.out, /active rate cards: 0 · PriceIQ key: not set/);
  assert.deepEqual(backups(), []);
  assert.equal(existsSync(join(VM, "deployed")), false);
});

test("a kept build whose APK is not its manifest's (sha256) is refused before the VM is asked anything — and is never rebuilt over", () => {
  const apk = join(VDIR, "dist", "swapup-store.apk");
  const manifestFile = join(VDIR, "dist", "swapup-store.json");
  const good = readFileSync(apk);
  const goodManifest = readFileSync(manifestFile, "utf8");
  const bad = Buffer.from(good);
  bad[0] ^= 0xff;
  writeFileSync(apk, bad);
  const calls = sshCalls();
  try {
    for (const extra of [{}, { BUILD_ONLY: "1" }] as Record<string, string>[]) {
      const r = release([VER], extra);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /✗ dist\/swapup-store\.apk has sha256 \w{12}…, its manifest says \w{12}…/);
      assert.match(r.out, /Stopping: the builds kept in .+ are not the ones that were built, so they will not ship/);
      assert.doesNotMatch(r.out, /▸ build from/);
    }
    // The manifest rewritten to match the changed APK: BUILT.json still knows the APK that was built.
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(goodManifest), sha256: sha256(bad) }));
    const r = release([VER]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /dist\/swapup-store\.apk is not the APK recorded in BUILT\.json/);
    assert.equal(sshCalls(), calls);
    assert.deepEqual(backups(), []);
  } finally {
    writeFileSync(apk, good);
    writeFileSync(manifestFile, goodManifest);
  }
});

test("with an active rate card: a timestamped backup of the live database, then the deploy, the verify and the record of both APKs", () => {
  live(`INSERT INTO rate_cards (id, active) VALUES ('rc_w42', 1)`);
  try {
    const r = release([VER]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /active rate cards: 1 · PriceIQ key: not set/);
    const [file, ...more] = backups();
    assert.deepEqual(more, []);
    assert.match(file, /^swapup-pre-9\.9\.9-\d{8}T\d{6}Z\.db$/);
    const path = join(VM, "swapup-backups", file);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const copy = new Database(path, { readonly: true });
    assert.equal((copy.prepare(`SELECT COUNT(*) n FROM rate_cards WHERE active = 1`).get() as { n: number }).n, 1);
    copy.close();
    // deploy.sh was told the backup is taken (so it takes no second one), and ran after it.
    assert.equal(readFileSync(join(VM, "deployed"), "utf8").trim(), path);
    assert.match(r.out, /\/downloads store: versionCode 99, sha256 \w{12}… \(this release\)/);
    assert.match(r.out, /retired=0/);
    assert.match(r.out, /RELEASED 9\.9\.9/);
    const last = releases().releases.at(-1) as { version: string; mobile: string; verify: string; dbBackup: string; apks: Record<string, unknown>[] };
    assert.equal(last.version, VER);
    assert.equal(last.mobile, M);
    assert.equal(last.verify, "passed");
    assert.equal(last.dbBackup, path);
    assert.deepEqual(
      last.apks.map((a) => [a.app, a.version, a.versionCode, a.commit, a.sha256]),
      APPS.map((app) => [app, VER, VC, M, SHA[app]])
    );
    assert.deepEqual(Object.keys(last.apks[0]).sort(), ["app", "builtAt", "bytes", "commit", "sha256", "version", "versionCode"]);
  } finally {
    live(`DELETE FROM rate_cards`);
    reset();
  }
});

test("a case still storing a retired sentence after the deploy fails the verify — recorded as failed, exit 1", () => {
  live(`INSERT INTO rate_cards (id, active) VALUES ('rc_w42', 1)`);
  live(`INSERT INTO cases (id, ref, quote) VALUES ('c2', 'SU-AND-00002', ?)`, JSON.stringify({ reason: "No market price yet — enter a quote." }));
  try {
    const r = release([VER]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /1 case\(s\) still store a sentence SwapUp has retired/);
    assert.match(r.out, /is deployed but did not verify/);
    assert.match(String(releases().releases.at(-1)?.verify), /^failed: a retired sentence is still stored/);
  } finally {
    live(`DELETE FROM rate_cards`);
    live(`DELETE FROM cases WHERE id = 'c2'`);
    reset();
  }
});

test("a deploy that deploy.sh rolled back (or could not): release.sh says which in one sentence, and verifies and records nothing", () => {
  const fakeDeploy = (name: string, line: string) => {
    const f = join(T, name);
    writeFileSync(f, `#!/usr/bin/env bash\necho "▸ health on the VM (/login and the API)"\necho "${line}" >&2\nexit 1\n`);
    return f;
  };
  const rolledBack = fakeDeploy("fake-deploy-rolled-back", "✗ ROLLED BACK: the deploy stopped at the health check, so the release kept before it is running again and answers.");
  const down = fakeDeploy("fake-deploy-down", "✗ DOWN: the deploy stopped at the health check and the rollback did not bring the release before it back — the site is down.");
  live(`INSERT INTO rate_cards (id, active) VALUES ('rc_w42', 1)`);
  try {
    const r = release([VER], { FAKE_DEPLOY: rolledBack });
    assert.notEqual(r.code, 0, r.out);
    assert.match(
      r.stderr,
      /^Stopping: 9\.9\.9 did not go live — deploy\.sh put the release before it back, and it answers\. See \S+\/deploy-\d{8}T\d{6}Z\.log; nothing is recorded \(the database backup is \S+\/swapup-pre-9\.9\.9-\d{8}T\d{6}Z\.db\)\.$/m
    );
    assert.doesNotMatch(r.out, /▸ verify/);
    assert.deepEqual(releases().releases, []);
    reset();
    const d = release([VER], { FAKE_DEPLOY: down });
    assert.notEqual(d.code, 0, d.out);
    assert.match(d.stderr, /^Stopping: 9\.9\.9 did not go live and the rollback did not bring the release before it back — the site is DOWN\./m);
    assert.deepEqual(releases().releases, []);
  } finally {
    live(`DELETE FROM rate_cards`);
    reset();
  }
});

test("--plan with a PriceIQ key and no card: the price check passes, nothing is backed up or deployed, the key is never printed", () => {
  writeFileSync(ENV_FILE, "NODE_ENV=production\nPRICEIQ_API_KEY=not-a-real-key-123\n");
  try {
    const r = release([VER, "--plan"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /active rate cards: 0 · PriceIQ key: set/);
    assert.match(r.out, /PLAN — nothing built, backed up or deployed/);
    assert.match(r.out, /use the kept builds/);
    assert.doesNotMatch(r.out, /not-a-real-key/);
    assert.deepEqual(backups(), []);
    assert.equal(existsSync(join(VM, "deployed")), false);
    assert.deepEqual(releases().releases, []);
  } finally {
    writeFileSync(ENV_FILE, "NODE_ENV=production\nPORT=4500\n");
  }
});

test("refuses a version the repos don't say, and a repo with uncommitted changes", () => {
  const wrong = release(["9.9.8"]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /^Stopping: you asked for 9\.9\.8 but app\.json says 9\.9\.9\.$/m);
  writeFileSync(join(MOBILE, "app.json"), JSON.stringify({ expo: { version: VER, extra: 1 } }));
  try {
    const dirty = release([VER]);
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.stderr, /has uncommitted changes — commit or stash them first\./);
  } finally {
    git(MOBILE, "checkout", "--", "app.json");
  }
});

test("vm.sh's retired sentences are the ones lib/server/seed.ts rewords on every boot", async () => {
  const { REWORDED_QUOTE_TEXTS, OLDER_SIZE_FLAG_NEEDLE } = await import("../lib/server/seed.ts");
  const src = readFileSync(join(ROOT, "deploy/vm.sh"), "utf8");
  const block = src.slice(src.indexOf("// RETIRED SENTENCES"), src.indexOf("// END RETIRED SENTENCES"));
  const listed = [...block.matchAll(/^\s*"(.*)",$/gm)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  assert.deepEqual(listed, [...REWORDED_QUOTE_TEXTS.map(([from]) => from), OLDER_SIZE_FLAG_NEEDLE]);
});
