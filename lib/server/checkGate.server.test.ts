/**
 * SUP-262 — old SwapUp Check installs and stray joins. The apps are sideloaded with no over-the-air
 * updates, so a phone running an old Check kept joining the field test (the SM-F976U on 0.9.0). A
 * NATIVE Check older than SWAPUP_CHECK_MIN_VERSION (default 0.9.3) is refused at the join with 426
 * "Update SwapUp Check — …/downloads, or use “Test in this browser”." BEFORE anything is looked up
 * or made (a standing code would otherwise open a case for it); the browser build always passes.
 * Every refused join is audited (test_session.join_refused, the code masked); a code another phone
 * already joined says "Already connected to the customer's phone", and so does /j/<code>.
 *
 * Through the REAL join (lib/server/testSessions.ts joinByCode, POST /api/device/join) on a
 * throwaway database, GradeIQ off.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/checkGate.server.test.ts
 */
import "./testing/register.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-checkgate-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
process.env.SWAPUP_PUBLIC_URL = "https://swapup.test";
delete process.env.SWAPUP_CHECK_MIN_VERSION;
delete process.env.SWAPUP_DEMO_CODE;
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origError = console.error;
const origLog = console.log;
const logged: string[] = [];
console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
console.log = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const sessions = await import("./testSessions.ts");
const joinRoute = await import("../../app/api/device/join/route.ts");

after(() => {
  console.error = origError;
  console.log = origLog;
  delete process.env.SWAPUP_PUBLIC_URL;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const SAMSUNG = { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", isPhysicalDevice: true };
let n = 0;
const install = () => `install-gate-${++n}-${Math.random().toString(36).slice(2, 8)}`;
/** joinByCode → "joined" or "<status> <error>". */
function tryJoin(code: string, appVersion: string | undefined, ip = "127.0.0.1", installId = install()): string {
  try {
    sessions.joinByCode({ code, installId, ...(appVersion === undefined ? {} : { appVersion }), device: SAMSUNG }, ip);
    return "joined";
  } catch (e) {
    const x = e as Error & { status?: number };
    return `${x.status} ${x.message}`;
  }
}
const UPDATE = "426 Update SwapUp Check — download it at https://swapup.test/downloads, or use “Test in this browser”.";
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const refusals = () => db().prepare(`SELECT org_id, store_id, entity_id, detail FROM audit WHERE action = 'test_session.join_refused' ORDER BY id`).all() as { org_id: string | null; store_id: string | null; entity_id: string | null; detail: string }[];
const lastRefusal = () => {
  const r = refusals().at(-1)!;
  return { ...r, detail: JSON.parse(r.detail) as Record<string, unknown> };
};
const freshCode = () => sessions.createTestSession(adv, { customerName: "Gate" }).session.code;

test("the version matrix: a native 0.9.2 → 426, 0.9.3 joins, the browser's web-0.6.0 joins, no version → 426; 'off' lets any build in; a value that isn't x.y.z keeps 0.9.3 and says so once", () => {
  assert.equal(tryJoin(freshCode(), "0.9.2"), UPDATE);
  assert.equal(tryJoin(freshCode(), "0.9.3"), "joined");
  assert.equal(tryJoin(freshCode(), "0.10.0"), "joined");
  assert.equal(tryJoin(freshCode(), "1.0.0"), "joined");
  assert.equal(tryJoin(freshCode(), "web-0.6.0"), "joined", "the browser build is this server's own: always current");
  assert.equal(tryJoin(freshCode(), "web-whatever"), "joined");
  assert.equal(tryJoin(freshCode(), undefined), UPDATE, "a native build that says no version is an old one");
  assert.equal(tryJoin(freshCode(), "0.0.0"), UPDATE, "an unversioned local build needs 'off'");
  assert.equal(tryJoin(freshCode(), "nonsense"), UPDATE);
  // The unit, the default and "off".
  assert.equal(sessions.CHECK_MIN_DEFAULT, "0.9.3");
  assert.deepEqual(sessions.checkMinVersion(undefined), [0, 9, 3]);
  assert.deepEqual(sessions.checkMinVersion(""), [0, 9, 3]);
  assert.deepEqual(sessions.checkMinVersion("0.9.4"), [0, 9, 4]);
  assert.equal(sessions.checkMinVersion("OFF"), null);
  assert.equal(sessions.checkAppTooOld("0.9.2", [0, 9, 3]), true);
  assert.equal(sessions.checkAppTooOld("0.9.3+15", [0, 9, 3]), false, "a build suffix is read past");
  assert.equal(sessions.checkAppTooOld("0.6.0", null), false);
  process.env.SWAPUP_CHECK_MIN_VERSION = "off";
  try {
    assert.equal(tryJoin(freshCode(), "0.6.0"), "joined");
    assert.equal(tryJoin(freshCode(), undefined), "joined");
  } finally {
    delete process.env.SWAPUP_CHECK_MIN_VERSION;
  }
  process.env.SWAPUP_CHECK_MIN_VERSION = "0.9";
  try {
    const before = logged.length;
    assert.equal(tryJoin(freshCode(), "0.9.2"), UPDATE, "a typo never switches the gate off");
    assert.equal(tryJoin(freshCode(), "0.9.3"), "joined");
    assert.equal(tryJoin(freshCode(), "0.9.1"), UPDATE);
    const said = logged.slice(before).filter((l) => /SWAPUP_CHECK_MIN_VERSION is not x\.y\.z/.test(l));
    assert.equal(said.length, 1, "said once");
  } finally {
    delete process.env.SWAPUP_CHECK_MIN_VERSION;
  }
  process.env.SWAPUP_CHECK_MIN_VERSION = "0.9.4";
  try {
    assert.equal(tryJoin(freshCode(), "0.9.3"), UPDATE, "a later minimum turns 0.9.3 away too");
  } finally {
    delete process.env.SWAPUP_CHECK_MIN_VERSION;
  }
});

test("POST /api/device/join: 426 {error, reason: app_too_old, downloads} — the sentence SwapUp Check shows as sent", async () => {
  const code = freshCode();
  const res = await joinRoute.POST(new Request("http://x/api/device/join", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.1.1.1" }, body: JSON.stringify({ code, installId: install(), appVersion: "0.9.0", device: SAMSUNG }) }));
  assert.equal(res.status, 426);
  assert.deepEqual(await res.json(), { error: UPDATE.slice(4), reason: "app_too_old", downloads: "https://swapup.test/downloads" });
});

test("the demo code AAAAAA + an old 0.6.0: 426 — and no session or case is made for it", () => {
  const cases0 = count(`SELECT COUNT(*) n FROM cases`);
  const sessions0 = count(`SELECT COUNT(*) n FROM test_sessions`);
  assert.equal(tryJoin("AAAAAA", "0.6.0"), UPDATE);
  assert.equal(count(`SELECT COUNT(*) n FROM cases`), cases0);
  assert.equal(count(`SELECT COUNT(*) n FROM test_sessions`), sessions0);
  const r = lastRefusal();
  assert.deepEqual(r.detail, { reason: "app_too_old", code: "AA••••", kind: "demo", appVersion: "0.6.0", ip: "127.0.0.1" });
  assert.equal(r.store_id, "st_and", "the demo programme's counter");
  // The browser on the same code opens one, as before.
  assert.equal(tryJoin("AAAAAA", "web-0.9.3"), "joined");
  assert.equal(count(`SELECT COUNT(*) n FROM test_sessions`), sessions0 + 1);
});

test("a second phone on a joined code → 409 'Already connected to the customer's phone…' and one audit row with the org and the store", () => {
  const created = sessions.createTestSession(adv, { customerName: "Two Phones" });
  assert.equal(tryJoin(created.session.code, "0.9.3"), "joined");
  const before = refusals().length;
  assert.equal(tryJoin(created.session.code, "0.9.3"), `409 ${sessions.IN_USE}`);
  assert.equal(sessions.IN_USE, "Already connected to the customer's phone — if this is the phone to test, ask the advisor for a new code.");
  assert.equal(refusals().length, before + 1);
  const r = lastRefusal();
  assert.deepEqual([r.org_id, r.store_id, r.entity_id], [adv.orgId, adv.storeId, created.session.id]);
  assert.deepEqual(r.detail, { reason: "in_use", code: `${created.session.code.slice(0, 2)}••••`, kind: "session", appVersion: "0.9.3", ip: "127.0.0.1" });
  assert.ok(!JSON.stringify(r).includes(created.session.code), "never the whole code");
});

test("the refused joins: an expired code and a bad request are audited; a resume finding its check ended (410) and the rate limit (429) are not", () => {
  const before = refusals().length;
  assert.match(tryJoin("ZZZZZZ", "0.9.3", "10.2.2.2"), /^404 /);
  assert.deepEqual(lastRefusal().detail, { reason: "expired", code: "ZZ••••", kind: null, appVersion: "0.9.3", ip: "10.2.2.2" });
  assert.equal(lastRefusal().store_id, null);
  try {
    sessions.joinByCode({ code: freshCode(), appVersion: "0.9.3", device: SAMSUNG }, "10.2.2.2");
  } catch (e) {
    assert.equal((e as { status?: number }).status, 400);
  }
  assert.equal(lastRefusal().detail.reason, "bad_request");
  assert.equal(refusals().length, before + 2);
  // A resume (the app re-joining by itself) on the counter code with no open check of its own: 410, not audited.
  const { code } = sessions.getCounterCode(adv);
  assert.throws(() => sessions.joinByCode({ code, installId: install(), appVersion: "0.9.3", device: SAMSUNG, resume: true } as never, "10.2.2.2"), (e: Error & { status?: number }) => e.status === 410);
  assert.equal(refusals().length, before + 2);
  // 20 refused guesses from one address: the 21st is 429, not audited.
  for (let i = 0; i < 18; i++) assert.match(tryJoin("ZZZZZZ", "0.9.3", "10.2.2.2"), /^404 /);
  const at20 = refusals().length;
  assert.match(tryJoin("ZZZZZZ", "0.9.3", "10.2.2.2"), /^429 /);
  assert.equal(refusals().length, at20);
});

test("21 tries from an old app don't count toward the 20 refusals per address: the good join after them goes through", () => {
  const ip = "10.3.3.3";
  const before = refusals().length;
  for (let i = 0; i < 21; i++) assert.equal(tryJoin(freshCode(), "0.9.0", ip), UPDATE, `try ${i + 1}`);
  // 21 installs on one address: the first TOO_OLD_AUDITS_PER_IP are audited, the rest counted (review 0.9.4).
  assert.equal(refusals().length, before + sessions.TOO_OLD_AUDITS_PER_IP, "audited up to the per-address bound");
  assert.equal(tryJoin(freshCode(), "0.9.3", ip), "joined", "the same store Wi-Fi is not locked out");
});

test("review 0.9.4: an endless loop of old-version joins writes a BOUNDED number of audit rows — one per address + install per 10 minutes, the rest counted and said on the next row", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-25T10:00:00.000Z") });
  try {
    const before = refusals().length;
    // One install, 500 tries: one row (the probe's loop wrote 500).
    for (let i = 0; i < 500; i++) assert.equal(tryJoin("ZZZZZZ", "0.0.1", "203.0.113.9", "install-loop-0001"), UPDATE);
    assert.equal(refusals().length, before + 1);
    // A new install id on every try (it is the caller's to choose): at most TOO_OLD_AUDITS_PER_IP for the address.
    for (let i = 0; i < 300; i++) assert.equal(tryJoin("ZZZZZZ", "0.0.1", "203.0.113.9", `install-loop-x${i}`), UPDATE);
    assert.equal(refusals().length, before + sessions.TOO_OLD_AUDITS_PER_IP);
    // Never a 429 for them, so the store's Wi-Fi is never locked out by an old app.
    assert.equal(tryJoin(freshCode(), "0.9.3", "203.0.113.9"), "joined");
    // Ten minutes on: the next row for that install says how many were counted, not audited.
    mock.timers.tick(10 * 60_000 + 1);
    assert.equal(tryJoin("ZZZZZZ", "0.0.1", "203.0.113.9", "install-loop-0001"), UPDATE);
    const last = lastRefusal().detail;
    assert.equal(last.reason, "app_too_old");
    assert.equal(last.suppressed, 499 + 300 - (sessions.TOO_OLD_AUDITS_PER_IP - 1), JSON.stringify(last));
  } finally {
    mock.timers.reset();
  }
});

test("/j/<code>: openByCode says when another phone already joined the code; a standing code never is", () => {
  const created = sessions.createTestSession(adv, { customerName: "Open" });
  const before = sessions.openByCode(created.session.code);
  assert.ok(before.ok && before.joined === false);
  assert.equal(tryJoin(created.session.code, "web-0.9.3"), "joined");
  const after = sessions.openByCode(created.session.code);
  assert.ok(after.ok && after.joined === true && after.kind === "session");
  const demo = sessions.openByCode("AAAAAA");
  assert.ok(demo.ok && demo.joined === false);
  const counter = sessions.openByCode(sessions.getCounterCode(adv).code);
  assert.ok(counter.ok && counter.joined === false);
});
