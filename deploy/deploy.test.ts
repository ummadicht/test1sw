/**
 * deploy/deploy.sh's rollback, run for real against a folder standing in for the VM (FAKE_SSH, with VM at a
 * .invalid host): never the VM, never a next build (FAKE_BUILD is shipped as the build), never the public
 * site. A stand-in pm2 runs each shipped build's own deploy/start.sh on a free port, so /login and the API
 * really answer, or don't.
 *
 *   - FAKE_SSH with a real host is refused before anything;
 *   - nothing ever kept and a broken build: exit 1, and it says the site is down;
 *   - a good build over a good one: the one before is kept in ~/swapup-prev (never data/), exit 0;
 *   - a build that crashes on start: the kept release is put back (sources, .next, node_modules) and answers
 *     again, data/ untouched, exit 1 — /login answered by the old build before and after, one gap between;
 *   - a build whose pages answer but whose API fails: rolled back too;
 *   - npm install failing on the VM: rolled back, and the new build never ran;
 *   - the live app down when a broken build ships: the release kept before is not replaced, and comes back.
 *
 * Run: node --test --experimental-strip-types --no-warnings deploy/deploy.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = mkdtempSync(join(tmpdir(), "swapup-deploy-"));
const PORT = await new Promise<number>((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => res(port));
  });
});

// ── the folder standing in for the VM: ~/swapup with its database, and pm2 and npm ──
const VM = join(T, "vm");
const APP = join(VM, "swapup");
const DB = join(APP, "data", "swapup.db");
mkdirSync(join(APP, "data"), { recursive: true });
mkdirSync(join(VM, "bin"));
writeFileSync(DB, "the live database — never copied, never replaced\n");
const DB_INODE = statSync(DB).ino;

const script = (path: string, text: string) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};
// ssh's (and rsync's) stand-in: drops ssh's options and the host, logs the command, runs it in the VM folder
// as home, with the VM's pm2 and npm first on the PATH.
const FAKE_SSH = join(T, "fake-ssh");
script(
  FAKE_SSH,
  `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case $1 in -i|-o|-p|-l|-F) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
echo "$*" >> "${VM}/ssh.log"
cd "${VM}" && HOME="${VM}" PATH="${VM}/bin:${dirname(process.execPath)}:$PATH" PORT=${PORT} exec bash -c "$*"
`
);
// pm2's stand-in: one app, "swapup" — its script run in the background; ~/.pm2-swapup holds the script and the pid.
script(
  join(VM, "bin", "pm2"),
  `#!/usr/bin/env bash
set -euo pipefail
echo "pm2 $*" >> "$HOME/pm2.log"
APPF=$HOME/.pm2-swapup
up() { [ -f "$APPF" ] && kill -0 "$(sed -n 2p "$APPF")" 2>/dev/null; }
halt() {
  if up; then
    pid=$(sed -n 2p "$APPF"); kill "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.02; done
  fi
}
run() { nohup bash "$1" >> "$HOME/app.log" 2>&1 < /dev/null & printf '%s\\n%s\\n' "$1" "$!" > "$APPF"; }
case $1 in
  describe) [ -f "$APPF" ] ;;
  restart) halt; run "$(sed -n 1p "$APPF")" ;;
  start) run "$PWD/$2" ;;
  stop) halt ;;
  save) ;;
  *) echo "fake pm2: $1?" >&2; exit 2 ;;
esac
`
);
// npm's stand-in: "installs" node_modules/installed = package.json's version, with the one mtime npm gives every
// package file (1985-10-26) — so only a content check can tell two versions apart. A build whose package.json
// says "failInstall" fails, as a registry outage or a native module that won't build would.
script(
  join(VM, "bin", "npm"),
  `#!/usr/bin/env bash
echo "npm $*" >> "$HOME/npm.log"
if grep -q '"failInstall"' package.json; then echo "npm ERR! the install failed" >&2; exit 1; fi
mkdir -p node_modules && node -p 'require("./package.json").version' > node_modules/installed
touch -t 198510260815 node_modules/installed
`
);

after(() => {
  spawnSync("bash", ["-c", `cd "${APP}" && HOME="${VM}" "${VM}/bin/pm2" stop`]);
  rmSync(T, { recursive: true, force: true });
});

type Kind = "ok" | "crash" | "api-fails" | "install-fails";
/** A build as deploy.sh ships it: package.json, .next/BUILD_ID, deploy/start.sh — and a server that behaves as `kind`. */
function build(id: string, version: string, kind: Kind): string {
  const dir = join(T, "builds", id);
  mkdirSync(join(dir, ".next"), { recursive: true });
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "swapup", version, ...(kind === "install-fails" ? { failInstall: true } : {}) }, null, 2) + "\n");
  writeFileSync(join(dir, ".next", "BUILD_ID"), id);
  writeFileSync(join(dir, `only-in-${id}`), id);
  writeFileSync(join(dir, "deploy", "start.sh"), `#!/usr/bin/env bash\ncd "$(dirname "$0")/.."\nexec node server.mjs\n`);
  writeFileSync(join(dir, "deploy", "patch-caddy.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(
    join(dir, "server.mjs"),
    `import { createServer } from "node:http";
${kind === "crash" ? `console.error("[swapup] cannot start"); process.exit(1);` : ""}
const h = { "x-build": ${JSON.stringify(id)}, "content-type": "application/json" };
createServer((req, res) => {
  if (req.url === "/login") { res.writeHead(200, { ...h, "content-type": "text/html" }); res.end("<title>Sign in</title>"); }
  else if (req.url === "/api/signup/programmes" && ${kind === "api-fails"}) { res.writeHead(500, h); res.end('{"error":"Something went wrong on our side."}'); }
  else if (req.url === "/api/signup/programmes") { res.writeHead(200, h); res.end('{"programmes":[]}'); }
  else { res.writeHead(404, h); res.end("{}"); }
}).listen(Number(process.env.PORT), "127.0.0.1");
`
  );
  return dir;
}

function deploy(dir: string, extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["VM_APP", "VM_PREV", "VM_BACKUPS", "BUILD", "MOBILE", "MOBILE_DIST", "PUBLIC"]) delete env[k];
  Object.assign(env, {
    FAKE_SSH,
    FAKE_BUILD: dir,
    VM: "nobody@vm.invalid",
    KEY: "/dev/null",
    APP_PORT: String(PORT),
    HEALTH_TRIES: "15",
    HEALTH_WAIT: "0.2",
    SWAPUP_DB_BACKUP: "/home/ammar/swapup-backups/swapup-pre-test.db",
    WEB_DIST: join(T, "no-browser-builds"),
    ...extra,
  });
  return new Promise((res) => {
    const p = spawn("bash", [join(ROOT, "deploy/deploy.sh")], { env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });
}

/** Who answers /login now: the build's id, "HTTP <code>", or "down". */
async function login(): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/login`, { signal: AbortSignal.timeout(2000) });
    await r.text();
    return r.status === 200 ? (r.headers.get("x-build") ?? "?") : `HTTP ${r.status}`;
  } catch {
    return "down";
  }
}
/** Deploys `dir` while asking /login every 20 ms, before, throughout and after. */
async function deployWatched(dir: string) {
  const seen = [await login()];
  let done = false;
  const run = deploy(dir).finally(() => (done = true));
  while (!done) {
    seen.push(await login());
    await new Promise((r) => setTimeout(r, 20));
  }
  seen.push(await login());
  return { ...(await run), seen };
}
/** ["v2","v2","down","v2"] → ["v2","down","v2"] */
const runs = (xs: string[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
const vm = (f: string) => readFileSync(join(VM, f), "utf8").trim();
const restarts = () => (existsSync(join(VM, "pm2.log")) ? vm("pm2.log").split("\n").filter((l) => /^pm2 (restart|start)/.test(l)).length : 0);
function assertDataUntouched(): void {
  assert.equal(readFileSync(DB, "utf8"), "the live database — never copied, never replaced\n");
  assert.equal(statSync(DB).ino, DB_INODE);
}
function assertLive(id: string, version: string): void {
  assert.equal(vm("swapup/.next/BUILD_ID"), id);
  assert.equal(vm("swapup/node_modules/installed"), version);
  assert.equal(existsSync(join(APP, `only-in-${id}`)), true);
}

test("FAKE_SSH with a host that could be real is refused before anything", async () => {
  const r = await deploy(build("v0", "0.0.1", "ok"), { VM: "ammar@104.197.168.25" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /FAKE_SSH is for tests: VM must be a \.invalid host, not ammar@104\.197\.168\.25/);
  assert.equal(existsSync(join(VM, "ssh.log")), false);
});

test("nothing kept and a build that crashes: exit 1, and it says plainly that the site is down", async () => {
  const r = await deploy(build("v0-crash", "0.0.1", "crash"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no release on the VM yet — nothing to keep/);
  assert.match(r.out, /:\d+ \/login 000 · \/api\/signup\/programmes 000/);
  assert.match(r.out, /no release was kept on the VM — nothing to roll back to/);
  assert.match(r.out, /✗ DOWN: the deploy stopped at the health check \(the new build does not answer on the VM\)/);
  assert.doesNotMatch(r.out, /✓ deployed/);
  assertDataUntouched();
});

test("a good build over one that never answered: nothing to keep, it answers, exit 0", async () => {
  const r = await deploy(build("v1", "1.0.0", "ok"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚠ the live app does not answer \(\/login 000 · \/api\/signup\/programmes 000\) and nothing was kept before/);
  assert.match(r.out, /\/login 200 · \/api\/signup\/programmes 200/);
  assert.match(r.out, /✓ deployed/);
  assert.equal(await login(), "v1");
  assertLive("v1", "1.0.0");
  assert.equal(existsSync(join(VM, "swapup-prev.kept")), false);
});

test("a good build over a good one: the one before is kept in ~/swapup-prev (never data/), the new one answers, exit 0", async () => {
  const r = await deploy(build("v2", "2.0.0", "ok"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kept 1\.0\.0 \(build v1\) in ~\/swapup-prev \(\d+ MB\) — a failed deploy rolls back to it/);
  assert.match(r.out, /✓ deployed/);
  assert.equal(await login(), "v2");
  assertLive("v2", "2.0.0");
  assert.equal(existsSync(join(APP, "only-in-v1")), false);
  assert.equal(vm("swapup-prev.kept"), "1.0.0 (build v1)");
  assert.equal(vm("swapup-prev/.next/BUILD_ID"), "v1");
  assert.equal(vm("swapup-prev/node_modules/installed"), "1.0.0");
  assert.equal(existsSync(join(VM, "swapup-prev", "data")), false);
  assertDataUntouched();
});

test("a build that crashes on start: the release before is put back and answers, data untouched, exit 1 — /login answered by it before and after", async () => {
  const r = await deployWatched(build("v3", "3.0.0", "crash"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /kept 2\.0\.0 \(build v2\) in ~\/swapup-prev/);
  assert.match(r.out, /✗ the app does not answer on the VM after 15 tries/);
  assert.match(r.out, /2\.0\.0 \(build v2\) is back and answers \(\/login 200 · \/api\/signup\/programmes 200\)/);
  assert.match(r.out, /✗ ROLLED BACK: the deploy stopped at the health check \(the new build does not answer on the VM\), so the release kept before it is running again and answers\./);
  assert.match(r.out, /the backup from before this deploy: \/home\/ammar\/swapup-backups\/swapup-pre-test\.db/);
  assert.doesNotMatch(r.out, /✓ deployed/);
  // v2 answered until the restart, nothing answered while v3 was failing, then v2 again until the end.
  assert.deepEqual(runs(r.seen), ["v2", "down", "v2"]);
  assertLive("v2", "2.0.0");
  assert.equal(existsSync(join(APP, "only-in-v3")), false);
  assert.equal(existsSync(join(APP, "server.mjs")), true);
  assert.equal(vm("swapup-prev.kept"), "2.0.0 (build v2)"); // still there for the next rollback
  assertDataUntouched();
});

test("a build whose pages answer but whose API fails: rolled back too", async () => {
  const r = await deployWatched(build("v4", "4.0.0", "api-fails"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\/login 200 · \/api\/signup\/programmes 500/);
  assert.match(r.out, /✗ ROLLED BACK/);
  assert.deepEqual(runs(r.seen.filter((s) => s !== "down")), ["v2", "v4", "v2"]);
  assertLive("v2", "2.0.0");
  assertDataUntouched();
});

test("npm install failing on the VM: rolled back, and the new build never ran", async () => {
  const before = restarts();
  const r = await deployWatched(build("v5", "5.0.0", "install-fails"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /npm ERR! the install failed/);
  assert.match(r.out, /✗ ROLLED BACK: the deploy stopped at npm install on the VM/);
  assert.equal(restarts() - before, 1); // the rollback's restart only
  assert.equal(r.seen.includes("v5"), false);
  assert.equal(r.seen.at(-1), "v2");
  assertLive("v2", "2.0.0");
  assert.equal(existsSync(join(APP, "only-in-v5")), false);
  assertDataUntouched();
});

test("the live app down when a broken build ships: the release kept before is not replaced, and comes back", async () => {
  spawnSync("bash", ["-c", `cd "${APP}" && HOME="${VM}" "${VM}/bin/pm2" stop`]);
  assert.equal(await login(), "down");
  const r = await deploy(build("v6", "6.0.0", "crash"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /⚠ the live app does not answer \(\/login 000 · \/api\/signup\/programmes 000\), so it is not kept — a failed deploy rolls back to 2\.0\.0 \(build v2\), kept before/);
  assert.match(r.out, /✗ ROLLED BACK/);
  assert.equal(await login(), "v2");
  assertLive("v2", "2.0.0");
  assert.equal(vm("swapup-prev.kept"), "2.0.0 (build v2)");
  assertDataUntouched();
});
