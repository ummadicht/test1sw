// The builds release.sh keeps, and the record of what it released. A cold APK build takes about 2.5 hours,
// so a release keeps its builds in a folder outside git and /private/tmp (~/projects/swapup-release-work/
// <version>/: dist/ = the two APKs and their manifests, dist-web/ = the two browser builds) and uses them
// again — but only when they are exactly what was built:
//
//   node deploy/release-builds.mjs stamp  <dir> <swapup-mobile repo> <version> <versionCode> <from>
//       After a build: checks the builds in <dir> against their manifests, then writes <dir>/BUILT.json
//       (each APK's sha256 and size, a hash of each browser build).
//   node deploy/release-builds.mjs check  <dir> <swapup-mobile repo> <version> <versionCode>
//       Before a release: exit 0 = the kept builds are the ones to ship; 3 = nothing kept for this
//       swapup-mobile commit (build it); 1 = kept for this commit but not what BUILT.json and the
//       manifests say (an APK whose sha256 is not its manifest's, a dirty build …) — refused, never shipped.
//   node deploy/release-builds.mjs record <dir> <RELEASES.json> <swapup commit> <db backup> <verify>
//       After a deploy: adds the release to the tracked RELEASES.json — version, versionCode, commit and
//       sha256 of each APK. Never the APK, an env file or a key.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const APPS = ["store", "check"];
const [what, dir, ...rest] = process.argv.slice(2);

const read = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
/** One hash for a browser build: every file's path and sha256, in order. */
function treeHash(root) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(root);
  const h = createHash("sha256");
  for (const f of files) h.update(`${relative(root, f)}\0${sha256(f)}\n`);
  return h.digest("hex");
}
/** The full hash `commit` names in the swapup-mobile repo, or null. */
function resolve(repo, commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).toString().trim();
  } catch {
    return null;
  }
}

/** What is in <dir>, and what is wrong with it for <version>/<versionCode> at swapup-mobile HEAD. */
function inspect(repo, version, versionCode) {
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
  const problems = [];
  const facts = { apks: {}, web: {}, commit: null };
  const fromHead = (where, m) => {
    if (m.dirty !== false) problems.push(`${where} was built from a dirty tree`);
    if (resolve(repo, m.commit) !== head) problems.push(`${where} was built from ${m.commit || "no recorded commit"}, not swapup-mobile ${head.slice(0, 7)}`);
    if (m.version !== version) problems.push(`${where} is version ${m.version}, not ${version}`);
  };
  for (const app of APPS) {
    const apk = join(dir, "dist", `swapup-${app}.apk`);
    const where = `dist/swapup-${app}.json`;
    const m = read(join(dir, "dist", `swapup-${app}.json`));
    if (!existsSync(apk) || !m) {
      problems.push(`dist/swapup-${app}.apk or its manifest is missing`);
      continue;
    }
    fromHead(where, m);
    if (m.versionCode !== versionCode) problems.push(`${where} has versionCode ${m.versionCode}, not ${versionCode}`);
    const sum = sha256(apk);
    const bytes = statSync(apk).size;
    if (sum !== m.sha256) problems.push(`dist/swapup-${app}.apk has sha256 ${sum.slice(0, 12)}…, its manifest says ${String(m.sha256).slice(0, 12)}…`);
    if (bytes !== m.bytes) problems.push(`dist/swapup-${app}.apk is ${bytes} bytes, its manifest says ${m.bytes}`);
    facts.apks[app] = { sha256: sum, bytes };
    facts.commit ??= m.commit;
  }
  for (const app of APPS) {
    const root = join(dir, "dist-web", app);
    const v = read(join(root, "version.json"));
    if (!existsSync(join(root, "index.html")) || !v) {
      problems.push(`dist-web/${app}/index.html or its version.json is missing`);
      continue;
    }
    fromHead(`dist-web/${app}/version.json`, v);
    facts.web[app] = treeHash(root);
  }
  return { head, problems, facts };
}

function fail(lines, code = 1) {
  for (const l of lines) console.error(l);
  process.exit(code);
}

if (what === "stamp") {
  const [repo, version, code, from] = rest;
  const { problems, facts } = inspect(repo, version, Number(code));
  if (problems.length) fail([...problems.map((p) => `✗ ${p}`), `✗ not keeping the builds in ${dir}.`]);
  const built = { version, versionCode: Number(code), mobileCommit: facts.commit, stampedAt: new Date().toISOString(), from, apks: facts.apks, web: facts.web };
  writeFileSync(join(dir, "BUILT.json"), JSON.stringify(built, null, 2) + "\n");
  console.log(`  kept in ${dir}: store ${facts.apks.store.sha256.slice(0, 12)}…, check ${facts.apks.check.sha256.slice(0, 12)}…`);
} else if (what === "check") {
  const [repo, version, code] = rest;
  const built = read(join(dir, "BUILT.json"));
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
  if (!built) fail([`  nothing kept in ${dir} yet`], 3);
  if (resolve(repo, built.mobileCommit) !== head || built.version !== version || built.versionCode !== Number(code))
    fail([`  the builds kept in ${dir} are ${built.version} (versionCode ${built.versionCode}) from swapup-mobile ${built.mobileCommit}, not ${version} (${code}) from ${head.slice(0, 7)}`], 3);
  const { problems, facts } = inspect(repo, version, Number(code));
  for (const app of APPS) {
    if (facts.apks[app] && built.apks?.[app]?.sha256 !== facts.apks[app].sha256)
      problems.push(`dist/swapup-${app}.apk is not the APK recorded in BUILT.json when it was built`);
    if (facts.web[app] && built.web?.[app] !== facts.web[app]) problems.push(`dist-web/${app} has changed since it was built`);
  }
  if (problems.length)
    fail([
      ...problems.map((p) => `✗ ${p}`),
      `Stopping: the builds kept in ${dir} are not the ones that were built, so they will not ship — delete that folder and run this again to build them fresh.`,
    ]);
  console.log(`  kept builds match: ${version} (versionCode ${code}) from swapup-mobile ${built.mobileCommit} — store ${facts.apks.store.sha256.slice(0, 12)}…, check ${facts.apks.check.sha256.slice(0, 12)}…`);
} else if (what === "record") {
  const [file, swapup, backup, verify] = rest;
  const log = read(file) ?? { releases: [] };
  const apks = APPS.map((app) => {
    const m = read(join(dir, "dist", `swapup-${app}.json`));
    return { app, version: m.version, versionCode: m.versionCode, commit: m.commit, sha256: m.sha256, bytes: m.bytes, builtAt: m.builtAt };
  });
  const web = APPS.map((app) => {
    const v = read(join(dir, "dist-web", app, "version.json"));
    return { app, version: v.version, commit: v.commit, bundle: v.bundle, builtAt: v.builtAt };
  });
  log.releases.push({ version: apks[0].version, releasedAt: new Date().toISOString(), swapup, mobile: apks[0].commit, apks, web, dbBackup: backup, verify });
  writeFileSync(file, JSON.stringify(log, null, 2) + "\n");
  console.log(`  recorded in ${file}`);
} else {
  fail(["usage: release-builds.mjs stamp|check|record <dir> …"], 2);
}
