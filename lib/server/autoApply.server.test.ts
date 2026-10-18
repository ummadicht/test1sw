/**
 * THE ANSWER BY ITSELF (owner, 2026-10-17: "Reduce the flow"), through the REAL
 * server services on a throwaway database with the store camera off:
 *
 *   the customer's phone tests itself and says it has finished — nobody taps
 *   "Apply to case". The camera couldn't decide (it is off), so the results wait
 *   for the advisor's taps on "Check the phone"; after the last one, the phone's
 *   own status poll puts them on the case and the answer is there. A refusal
 *   (the case left the counter meanwhile) is shown with its reason and not
 *   retried until something changes; the battery screenshot is left out when an
 *   attached Phonecheck report already read the battery.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-autoapply-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origError = console.error;
const origLog = console.log;
console.error = () => {};
console.log = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}
const statusOf = (id: string) => (db().prepare(`SELECT status FROM test_sessions WHERE id = ?`).get(id) as { status: string }).status;
const applies = (id: string) => db().prepare(`SELECT user_id, detail FROM audit WHERE action = 'test_session.apply' AND entity_id = ?`).all(id) as { user_id: string; detail: string }[];

after(() => {
  console.error = origError;
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

/** A session joined by SwapUp Check 0.8.0 on a Galaxy S23 Ultra that measured 256 GB; every test passes. */
function testedPhone(name: string, opts: { complete?: boolean } = {}) {
  const created = sessions.createTestSession(adv, { customerName: name, customerPhone: "9820012345" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-${Math.random().toString(36).slice(2, 12)}`,
      appVersion: "0.8.0",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  const ticket = `Ticket ${joined.ticket}`;
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  if (opts.complete !== false) {
    sessions.deviceComplete(ticket);
    sessions.devicePhase(ticket, { phase: "done" });
  }
  return { sessionId: created.session.id, caseId: created.session.caseId, ticket, plan: joined.session.plan };
}

const certifyAll = async (caseId: string, sessionId: string) => {
  await cases.certifyCase(adv, caseId, { row: "screen", value: "ok", testSessionId: sessionId });
  await cases.certifyCase(adv, caseId, { row: "body", value: "scuffs", testSessionId: sessionId });
  await cases.certifyCase(adv, caseId, { row: "liquid", value: "clean", testSessionId: sessionId });
};

test("still testing: nothing goes on the case, whatever the advisor taps", async () => {
  const t = testedPhone("Still Testing", { complete: false });
  // The Screen waits for the test colours (after the tests); the body and liquid can be tapped now.
  await assert.rejects(cases.certifyCase(adv, t.caseId, { row: "screen", value: "ok", testSessionId: t.sessionId }), (e: Error & { status?: number }) => e.status === 409);
  await cases.certifyCase(adv, t.caseId, { row: "body", value: "scuffs", testSessionId: t.sessionId });
  await cases.certifyCase(adv, t.caseId, { row: "liquid", value: "clean", testSessionId: t.sessionId });
  const v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.equal(v.status, "testing");
  assert.deepEqual(v.autoApply, { state: "waiting", for: "tests", text: "The phone is still testing." });
  assert.equal(applies(t.sessionId).length, 0);
});

test("the camera couldn't decide: the results wait for the advisor's taps, then the phone's own poll puts them on the case — no Apply call", async () => {
  const t = testedPhone("Asha Rao");
  // The phone has finished; the camera is off, so "Check the phone" holds the answer.
  let v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.equal(v.status, "complete");
  assert.deepEqual(v.certify?.needed, ["screen", "body", "liquid"]);
  assert.equal(v.autoApply?.state, "waiting");
  assert.equal((v.autoApply as { for: string }).for, "certify");
  // The phone keeps asking — still nothing applied while a row is open.
  await cases.certifyCase(adv, t.caseId, { row: "screen", value: "ok", testSessionId: t.sessionId });
  await cases.certifyCase(adv, t.caseId, { row: "body", value: "scuffs", testSessionId: t.sessionId });
  sessions.deviceStatus(t.ticket);
  await wait(50);
  assert.equal(statusOf(t.sessionId), "complete");
  // The last tap; then the phone's next status poll — no staff call at all.
  await cases.certifyCase(adv, t.caseId, { row: "liquid", value: "clean", testSessionId: t.sessionId });
  sessions.deviceStatus(t.ticket);
  await until("the automatic apply", () => statusOf(t.sessionId) === "applied");
  const rows = applies(t.sessionId);
  assert.equal(rows.length, 1, "applied once");
  assert.equal(JSON.parse(rows[0].detail).auto, true);
  assert.equal(rows[0].user_id, adv.id, "recorded as the advisor who started the trade-in");
  // The answer is on the case: the two numbers and the grade, with what was certified folded in.
  const c = cases.getCase(adv, t.caseId);
  assert.ok(c.offer, "the answer");
  assert.equal(c.condition?.body, "scuffed");
  assert.equal(c.device?.variant, "256GB");
  // The store's next poll says so; the phone shows "the store has your results".
  v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.deepEqual(v.autoApply, { state: "applied" });
  assert.equal(sessions.deviceStatus(t.ticket).status, "applied");
  // A manual Apply now changes nothing (the gate is Apply's own).
  await assert.rejects(sessions.applyTestSession(adv, t.sessionId), (e: Error & { status?: number }) => e.status === 409 && /already on the case/.test(e.message));
});

test("the store's poll does it too, and its answer already says applied", async () => {
  const t = testedPhone("Ravi Kumar");
  await certifyAll(t.caseId, t.sessionId);
  const v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.equal(v.status, "applied");
  assert.deepEqual(v.autoApply, { state: "applied" });
  assert.equal(applies(t.sessionId).length, 1);
});

test("Apply refuses: its one-line reason is on the session, not retried until something changes; Retry is a manual Apply", async () => {
  const t = testedPhone("Walked Off");
  await certifyAll(t.caseId, t.sessionId);
  // Meanwhile the case left the counter on the desk.
  db().prepare(`UPDATE cases SET status = 'walked_away', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), t.caseId);
  let v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.deepEqual(v.autoApply, { state: "refused", reason: "The case is past the counter." });
  assert.equal(v.status, "complete");
  const auditsBefore = (db().prepare(`SELECT COUNT(*) n FROM audit`).get() as { n: number }).n;
  v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.equal(v.autoApply?.state, "refused", "the same version is not tried again");
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM audit`).get() as { n: number }).n, auditsBefore);
  await assert.rejects(sessions.applyTestSession(adv, t.sessionId), (e: Error & { status?: number }) => e.status === 409 && /past the counter/.test(e.message));
  // Back at the counter: the case changed, so it is tried once more — and goes on.
  db().prepare(`UPDATE cases SET status = 'quoted', updated_at = ? WHERE id = ?`).run(new Date(Date.now() + 1000).toISOString(), t.caseId);
  v = (await sessions.getTestSession(adv, t.sessionId)).session;
  assert.equal(v.status, "applied");
});

test("a partial Apply stays the advisor's: \"Apply the results so far\" is never held by the card", async () => {
  const t = testedPhone("Gave Up", { complete: false });
  const out = await sessions.applyTestSession(adv, t.sessionId);
  assert.equal(out.session.status, "applied");
  assert.equal(JSON.parse(applies(t.sessionId)[0].detail).auto, undefined, "a manual Apply is recorded as one");
});

test("the battery screenshot is left out when the case already has a battery % from an attached Phonecheck report", async () => {
  const c = cases.createCase(adv, { customerName: "Has Phonecheck" });
  const now = new Date().toISOString();
  db()
    .prepare(`INSERT INTO phonecheck_records (id, record_key, source, case_id, record, raw, received_at, updated_at, attached_at, attached_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run("pc_test_1", "pc-key-1", "upload", c.id, JSON.stringify({ passed: [], failed: [], pending: [], batteryHealthPct: 91, batteryCycles: null, links: { a4: null, erasure: null, dhr: null } }), "{}", now, now, now, adv.id);
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = sessions.joinByCode({ code: s.session.code, installId: "install-battery-known", appVersion: "0.8.0", device: { brand: "samsung", modelCode: "SM-S918B", totalDiskBytes: 256e9 } }, "127.0.0.1");
  assert.ok(!j.session.plan.some((p) => p.id === "battery_health"), "not asked: Phonecheck read it");
  // Without such a report the step is there (and the phone lets the customer skip it).
  const other = testedPhone("No Report", { complete: false });
  assert.ok(other.plan.some((p) => p.id === "battery_health"));
});

test("an automatic Apply is recorded as whoever checked the phone — the last 'Check the phone' tap — not whoever only started the trade-in", async () => {
  const mgr = who("usr_mgr_and");
  const t = testedPhone("Checked By Manager");
  await cases.certifyCase(mgr, t.caseId, { row: "screen", value: "ok", testSessionId: t.sessionId });
  await cases.certifyCase(mgr, t.caseId, { row: "body", value: "scuffs", testSessionId: t.sessionId });
  await cases.certifyCase(mgr, t.caseId, { row: "liquid", value: "clean", testSessionId: t.sessionId });
  // The customer's phone polls first: no staff user on that call.
  sessions.deviceStatus(t.ticket);
  await until("the automatic apply", () => statusOf(t.sessionId) === "applied");
  assert.equal(applies(t.sessionId)[0].user_id, mgr.id);
  assert.equal(cases.getCase(adv, t.caseId).camera?.by, mgr.name);
});

test("a case closed at the desk while the phone was testing: the card can't be tapped any more, so Apply is tried and its refusal shows", async () => {
  const t = testedPhone("Walked Away", { complete: false });
  cases.walkAway(adv, t.caseId);
  sessions.deviceComplete(t.ticket);
  sessions.devicePhase(t.ticket, { phase: "done" });
  let v = (await sessions.getTestSession(adv, t.sessionId)).session;
  for (let i = 0; i < 50 && v.autoApply?.state !== "refused"; i++) {
    await wait(20);
    v = (await sessions.getTestSession(adv, t.sessionId)).session;
  }
  assert.equal(v.certify?.canEdit, false);
  assert.equal(v.autoApply?.state, "refused", JSON.stringify(v.autoApply));
  assert.match((v.autoApply as { reason: string }).reason, /past the counter|closed/i);
});
