/**
 * The owner's case, end to end through the REAL server services on a throwaway
 * database and a stand-in GradeIQ whose AI is out of prepaid credit (HTTP 402):
 *
 *   the customer's phone (SwapUp Check 0.8.0) tests itself — nobody asks it
 *   about condition — while GradeIQ's camera photographs it, but its grade comes
 *   back a stand-in ("stub") and its colour sweep frames go unread; the battery
 *   reader says it is off; the phone is never asked for the test colours (owner,
 *   2026-10-25: after the tests, back to the advisor with the report and the offer);
 *   the advisor certifies screen, body and liquid indicator by name, one tap each;
 *   Apply; the grade and the GradeIQ-level report (every photo by angle, the
 *   colour frames, what was checked by hand) — with no vendor, no 402 and no
 *   GradeIQ anywhere on it.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/* ─────────────────────────── a stand-in GradeIQ, AI out of credit ─────────────────────────── */

const giq = { sessions: new Map<string, { shown: string | null }>(), ocr: 0, seen: [] as string[], screenDown: false };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

function gradeiqSession(id: string) {
  return {
    id,
    client_id: "swapmore-in",
    status: "open",
    // GradeIQ's cosmetic grade falls back to its stand-in when the AI call fails.
    cosmetic_grade: "",
    functional_grade: "",
    overall_grade: "",
    photos: [0, 1, 2].map((n) => `/api/uploads/${id}-${n}.jpg`),
    capture: { verdict: "ok", code: "ok", reasons: [], attempt: 1 },
    identity: { verdict: "unverified", flags: [] },
    offer: { price: 99999, currency: "INR" },
    cosmetic: { tierUsed: "stub", refining: false, specialists: [], coverage: null, conclusive: null },
    screen: {
      cosmeticDone: true,
      handoffDone: true,
      angleLabels: ["Front glass", "Back", "Left side"],
      displayCheck: {
        verdict: "unknown",
        confidence: 0,
        findings: [],
        note: "Display validation unavailable (AI call failed) — check the screen manually.",
        source: "stub",
        patterns: ["white", "black"],
        captures: [
          { pattern: "white", photo: `/api/uploads/${id}-disp-1-0.jpg` },
          { pattern: "black", photo: `/api/uploads/${id}-disp-1-1.jpg` },
        ],
        requested: ["white", "black", "red", "green", "blue", "stripes"],
        missing: ["red", "green", "blue", "stripes"],
      },
    },
  };
}

function gradeiqHandler(req: IncomingMessage, body: string, res: ServerResponse) {
  const url = req.url ?? "";
  giq.seen.push(`${req.method} ${url}`);
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  let m: RegExpExecArray | null;
  if (req.method === "POST" && url === "/api/sessions") {
    const id = randomUUID();
    giq.sessions.set(id, { shown: null });
    return json({ id, client: "swapmore-in" });
  }
  if ((m = /^\/api\/uploads\/([A-Za-z0-9._-]+)$/.exec(url))) {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(JPEG);
  }
  if ((m = /^\/api\/report\/([0-9a-f-]{36})\/export$/.exec(url))) return json({ passportId: "DFX-TEST-0001", photos: [] });
  if (!(m = /^\/api\/sessions\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(url))) return json({ error: "not found" }, 404);
  const [, id, rest = ""] = m;
  const s = giq.sessions.get(id);
  if (!s) return json({ error: "not found" }, 404);
  if (rest === "/screen" && req.method === "GET" && giq.screenDown) return json({ error: "down" }, 500);
  if (rest === "/screen" && req.method === "GET") return json({ pattern: "idle", shown: s.shown, cosmeticDone: true, handoffDone: true, connectedAt: new Date().toISOString() });
  if (rest === "/screen" && req.method === "POST") {
    s.shown = (JSON.parse(body || "{}") as { shown?: string }).shown ?? null;
    return json({ ok: true });
  }
  if (rest === "/ocr") {
    giq.ocr++;
    // GradeIQ keeps WHY its reader failed — here, the AI's prepaid credit ran out.
    return json({ ok: true, ocr: { source: "error", readCount: 0, error: 'gemini 402: {"error":{"code":402,"message":"prepaid credit depleted"}}' } });
  }
  if (rest === "/device" || rest === "/functional") return json({ ok: true });
  if (rest === "") return json(gradeiqSession(id));
  return json({ error: "not found" }, 404);
}

const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => gradeiqHandler(req, body, res));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const GIQ = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

/* ─────────────────────────── a throwaway server ─────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "swapup-certify-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "1";
process.env.GRADEIQ_BASE_URL = GIQ;
process.env.GRADEIQ_PUBLIC_URL = GIQ;
process.env.GRADEIQ_CLIENT = "swapmore-in";
for (const k of Object.keys(process.env)) if (k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origError = console.error;
const origLog = console.log;
console.error = () => {};
console.log = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { issueToken } = await import("./auth.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const gr = await import("./gradingReport.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const actionRoute = await import("../../app/api/cases/[id]/action/route.ts");
const releaseRoute = await import("../../app/api/test-sessions/[id]/release-scan/route.ts");
const publicRoute = await import("../../app/api/r/[token]/route.ts");
const photoRoute = await import("../../app/api/r/[token]/photo/[n]/route.ts");

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const admin = who("usr_samsung");
const otherAdv = who("usr_adv_kor");

async function asUser<T>(u: U | null, fn: () => Promise<T>): Promise<T> {
  (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = u ? { authorization: `Bearer ${issueToken(u)}` } : {};
  try {
    return await fn();
  } finally {
    (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = {};
  }
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
async function act(u: U, caseId: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await asUser(u, () => actionRoute.POST(new Request(`http://x/api/cases/${caseId}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params({ id: caseId })));
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

after(async () => {
  console.error = origError;
  console.log = origLog;
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/* ─────────────────────────── the phone tests itself; the camera can't decide ─────────────────────────── */

let caseId = "";
let sessionId = "";
let ticket = "";

test("the customer's phone tests itself and is asked nothing about condition; the camera's grade fails (AI out of credit)", async () => {
  const created = sessions.createTestSession(adv, { customerName: "Asha Rao" });
  sessionId = created.session.id;
  caseId = created.session.caseId;
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(sessionId) as { gradeiq_state: string }).gradeiq_state === "ready");
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: "install-certify-0001",
      appVersion: "0.8.0",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  ticket = `Ticket ${joined.ticket}`;
  // The phone's Scan step: it never offers the customer a skip; the advisor can release it by name.
  const screen0 = await sessions.deviceScreenGet(ticket);
  assert.equal(screen0.released, false);
  // No camera display test on the phone (the camera's sweep is it), no battery reading yet.
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "display" && p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  // The battery reader is off (its AI refused the call): the phone is told so — not "try a clearer screenshot".
  await assert.rejects(sessions.deviceBattery(ticket, { image: "data:image/png;base64,iVBORw0KGgo=" }), (e: Error & { status?: number }) => e.status === 409 && /Battery reader isn't available/.test(e.message) && !/402|gemini|credit/i.test(e.message));
  assert.equal(giq.ocr, 1);
  sessions.deviceComplete(ticket);
  // The staff read pulls what GradeIQ has: the photos, a stand-in grade, unread colour frames.
  await sessions.getTestSession(adv, sessionId);
  await until("the GradeIQ snapshot", () => !!(db().prepare(`SELECT gradeiq_snapshot FROM test_sessions WHERE id = ?`).get(sessionId) as { gradeiq_snapshot: string | null }).gradeiq_snapshot);
  const v = (await sessions.getTestSession(adv, sessionId)).session;
  assert.equal(v.grading?.assessment?.status, "failed");
  assert.equal(v.grading?.assessment?.lcd.aiOff, true);
  assert.equal(v.grading?.assessment?.lcd.reason, "captured 2 of 6 colours, AI reader off — check by eye");
  // The summary asks the advisor, never the customer.
  assert.ok(v.summary?.notes.some((n) => /Certify screen, body and liquid on Check the phone/.test(n)));
  assert.ok(!v.summary?.notes.some((n) => /did not say|damage questions/.test(n)));
});

test("Check the phone: the card lists screen, body and liquid with the Screen row's note; the phone is never asked for the test colours (SUP-260)", async () => {
  let v = (await sessions.getTestSession(adv, sessionId)).session;
  assert.deepEqual(v.certify?.needed, ["screen", "body", "liquid"]);
  assert.deepEqual(v.certify?.rows, { screen: null, body: null, liquid: null });
  assert.deepEqual(v.certify?.choices.screen.map((c) => c.label), ["OK", "Scratches", "Lines or spots", "Cracked"]);
  assert.equal(v.certify?.colours, "off", "no colour loop after the tests");
  assert.deepEqual(v.certify?.notes, { screen: "Screen not fully camera-checked — look at it." }, "2 of 6 colours photographed, unread");
  // Testing, finished: the phone is never told to show the colours — the customer gets the result screen.
  sessions.devicePhase(ticket, { phase: "test" });
  assert.equal(sessions.deviceStatus(ticket).colours, false);
  sessions.devicePhase(ticket, { phase: "done" });
  assert.equal(sessions.deviceStatus(ticket).colours, false);
  // A phone that still says "colours" (an older build mid-loop at the update) changes nothing on the card.
  sessions.devicePhase(ticket, { phase: "colours" });
  v = (await sessions.getTestSession(adv, sessionId)).session;
  assert.equal(v.certify?.colours, "off");
  assert.equal(v.phonePhase, "colours");
  assert.equal(sessions.deviceStatus(ticket).colours, false, "and it is told to stop");
  sessions.devicePhase(ticket, { phase: "done" });
  // A device read never carries the staff card.
  assert.ok(!("certify" in sessions.deviceStatus(ticket)));
});

test("certify: only store staff, one tap per row, by name; the same tap twice changes nothing", async () => {
  assert.equal((await act(admin, caseId, { action: "certify", row: "screen", value: "ok" })).status, 403);
  assert.equal((await act(otherAdv, caseId, { action: "certify", row: "screen", value: "ok" })).status, 404, "another store's case is not found");
  const bad = await act(adv, caseId, { action: "certify", row: "screen", value: "perfect" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "Tap one of: OK, Scratches, Lines or spots, Cracked.");
  assert.equal((await act(adv, caseId, { action: "certify", row: "glass", value: "ok" })).status, 400);
  assert.equal((await act(adv, caseId, { action: "certify", row: "screen", value: "ok", testSessionId: "ts_nope" })).status, 404);

  const screen = await act(adv, caseId, { action: "certify", row: "screen", value: "ok", testSessionId: sessionId });
  assert.equal(screen.status, 200);
  const cert = screen.data.certification as Record<string, { label: string; by: string; withColours: boolean }>;
  assert.deepEqual([cert.screen.label, cert.screen.by, cert.screen.withColours], ["OK", "Rahul Desai", false], "the advisor's own look, without the colours");
  assert.ok(!JSON.stringify(screen.data.certification).includes("usr_"), "no staff id on the view");
  // The CaseView carries the same card as the session view, so SwapUp Store's answer screen shows it opened from Home too.
  const card = screen.data.certify as { needed: string[]; rows: Record<string, { label: string; by: string } | null>; testSessionId: string | null; canEdit: boolean; colours: string };
  assert.deepEqual(card.needed, ["screen", "body", "liquid"]);
  assert.deepEqual([card.rows.screen?.label, card.rows.screen?.by, card.rows.body], ["OK", "Rahul Desai", null]);
  assert.equal(card.testSessionId, sessionId);
  assert.equal(card.canEdit, true);
  assert.equal(card.colours, "off");
  assert.ok(!JSON.stringify(card).includes("usr_"));
  assert.equal(sessions.deviceStatus(ticket).colours, false);
  assert.equal((await sessions.getTestSession(adv, sessionId)).session.certify?.colours, "off");

  // Lines or spots puts display_lines on the case; OK again takes it off.
  const lines = await act(adv, caseId, { action: "certify", row: "screen", value: "lines", testSessionId: sessionId });
  assert.deepEqual(lines.data.faults, ["display_lines"]);
  assert.deepEqual((lines.data.faultSources as Record<string, string[]>).display_lines, ["advisor"]);
  const back = await act(adv, caseId, { action: "certify", row: "screen", value: "ok", testSessionId: sessionId });
  assert.deepEqual(back.data.faults, []);

  const body = await act(adv, caseId, { action: "certify", row: "body", value: "scuffs" });
  assert.equal(body.data.condition, null, "before Apply a tap never invents the rest of a condition — Apply folds it in");
  await act(adv, caseId, { action: "certify", row: "liquid", value: "clean" });
  const audits = () => (db().prepare(`SELECT COUNT(*) n FROM audit WHERE action = 'case.certify' AND entity_id = ?`).get(caseId) as { n: number }).n;
  const before = audits();
  const same = await act(adv, caseId, { action: "certify", row: "liquid", value: "clean" });
  assert.equal(same.status, 200);
  assert.equal(audits(), before, "the same tap again is no change and no audit row");
  const row = db().prepare(`SELECT detail FROM audit WHERE action = 'case.certify' AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(caseId) as { detail: string };
  assert.deepEqual(JSON.parse(row.detail).row, "liquid");
});

test("Apply: the camera's failed grade doesn't block it; what was certified stands; the SwapUp grade is Good (B), provisional for the unread battery and a screen looked at without the colours", async () => {
  const out = await sessions.applyTestSession(adv, sessionId);
  assert.equal(out.session.status, "applied");
  const c = cases.getCase(adv, caseId);
  assert.equal(c.camera?.status, "failed");
  assert.equal(c.camera?.lcd.aiOff, true);
  assert.equal(c.condition?.body, "scuffed");
  assert.equal(c.condition?.screen, "flawless");
  assert.equal(c.grading?.status, "graded");
  assert.equal(c.grading?.label, "Good (B) · provisional");
  const live = gr.gradingReportFor(adv, caseId).live!;
  // The battery wasn't read (its reader is off), and the screen rests on a look without the test colours
  // (PV13 — honest: the sweep saw 2 of 6 colours and the phone is no longer asked to show them).
  assert.deepEqual(live.provisional.map((p) => p.code), ["PV5", "PV13"]);
  assert.equal(live.provisional.find((p) => p.code === "PV13")?.text, "Screen certified by Rahul Desai without the test colours.");
  const display = live.tests.find((t) => t.id === "display")!;
  assert.equal(display.result, "passed");
  assert.deepEqual(display.sources.map((s) => [s.source, s.by, s.colours ?? false]), [["advisor", "Rahul Desai", false]]);
  assert.equal(sessions.deviceStatus(ticket).colours, false);
  // After Apply the case's own camera record says which rows the card shows; the taps stand on it.
  assert.deepEqual(c.certify?.needed, ["screen", "body", "liquid"]);
  assert.deepEqual(c.certify && Object.values(c.certify.rows).map((r) => r?.label), ["OK", "Scuffs", "Clean"]);
  assert.equal(c.certify?.colours, "off");
  // A partner never sees the staff card; a case nobody tested with SwapUp Check gets none.
  const desk = cases.createCase(adv, { customerName: "Desk Only" });
  assert.equal(desk.certify, null);
});

test("the report: every store-camera photo by angle, the colour frames, what was checked by hand — and no vendor, no 402, no GradeIQ", async () => {
  const r = gr.gradingReportFor(adv, caseId);
  const token = r.path!.split("/").pop()!;
  const res = await publicRoute.GET(new Request(`http://x/api/r/${token}`), params({ token }));
  const env = (await res.json()) as { version: number; body: import("../domain/gradingReport.ts").ReportBody };
  const b = env.body;
  // Never the front glass on the public report: the phone's screen faces the camera for it.
  assert.deepEqual(b.camera.photos, [
    { n: 0, label: "Back" },
    { n: 1, label: "Left side" },
  ]);
  assert.equal(b.camera.why, "The automatic grader is off.");
  assert.equal(b.camera.reference, "DFX-TEST-0001");
  assert.deepEqual(b.screen?.colours.map((c) => [c.pattern, c.photo !== null]), [
    ["white", true],
    ["black", true],
    ["red", false],
    ["green", false],
    ["blue", false],
    ["stripes", false],
  ]);
  assert.equal(b.screen?.why, "Colours photographed; the automatic reader is off.");
  assert.deepEqual(Object.keys(b.certification ?? {}).sort(), ["body", "liquid", "screen"]);
  assert.equal(b.certification!.screen!.line, "Screen certified by Rahul Desai: no lines, spots, dead pixels or scratches.");
  assert.equal(b.phone.os, "Android 14");
  const json = JSON.stringify(b);
  for (const word of [/gemini/i, /gradeiq/i, /\b402\b/, /credit/i, /AI call failed/i, /\/api\/uploads\//, /99999/]) assert.ok(!word.test(json), `${word} must not reach the report`);
  // The photos and the colour frames come through SwapUp's proxy, from the camera's store.
  for (const n of [0, b.screen!.colours[0].photo!]) {
    const p = await photoRoute.GET(new Request(`http://x/api/r/${token}/photo/${n}?v=${env.version}`), params({ token, n: String(n) }));
    assert.equal(p.status, 200, `photo ${n}`);
    assert.equal(p.headers.get("content-type"), "image/jpeg");
  }
});

test("after the counter: no more certifying", async () => {
  await act(adv, caseId, { action: "walk_away" });
  const late = await act(adv, caseId, { action: "certify", row: "body", value: "dents" });
  assert.equal(late.status, 409);
  assert.match(String(late.data.error), /past the counter/);
});

test("the advisor releases a phone from its Scan step by name; the phone reads `released`", async () => {
  const created = sessions.createTestSession(adv, {});
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
  // Not joined yet: nothing to release.
  const early = await asUser(adv, () => releaseRoute.POST(new Request(`http://x/api/test-sessions/${created.session.id}/release-scan`, { method: "POST" }), params({ id: created.session.id })));
  assert.equal(early.status, 409);
  const j = sessions.joinByCode(
    { code: created.session.code, installId: "install-certify-0002", appVersion: "0.8.0", device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", isPhysicalDevice: true } },
    "127.0.0.1"
  );
  const t = `Ticket ${j.ticket}`;
  sessions.devicePhase(t, { phase: "scan" });
  const res = await asUser(adv, () => releaseRoute.POST(new Request(`http://x/api/test-sessions/${created.session.id}/release-scan`, { method: "POST" }), params({ id: created.session.id })));
  assert.equal(res.status, 200);
  const v = (await res.json()) as { grading: { released: { by: string } | null; canRelease: boolean } };
  assert.equal(v.grading.released?.by, "Rahul Desai");
  assert.equal(v.grading.canRelease, false);
  assert.equal((await sessions.deviceScreenGet(t)).released, true);
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM audit WHERE action = 'test_session.scan_release' AND entity_id = ?`).get(created.session.id) as { n: number }).n, 1);
});

test("a stale echo can't satisfy the camera: the phone's 'off' is forwarded as it is", async () => {
  // The phone leaving its Scan step says "off" — never a colour GradeIQ could take for "white".
  const created = sessions.createTestSession(adv, {});
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
  const j = sessions.joinByCode({ code: created.session.code, installId: "install-certify-0003", appVersion: "0.8.0", device: { brand: "samsung", modelName: "SM-S918B", isPhysicalDevice: true } }, "127.0.0.1");
  await sessions.deviceScreenPost(`Ticket ${j.ticket}`, { shown: "white" });
  assert.equal((await sessions.getTestSession(adv, created.session.id)).session.grading?.deviceReady, true);
  await sessions.deviceScreenPost(`Ticket ${j.ticket}`, { shown: "off" });
  const gid = (db().prepare(`SELECT gradeiq_id FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_id: string }).gradeiq_id;
  assert.equal(giq.sessions.get(gid)?.shown, "off");
  // …and "off" never unlocks the store's camera as if the phone were showing its patterns.
  const g = (await sessions.getTestSession(adv, created.session.id)).session.grading!;
  assert.equal(g.deviceReady, false);
  assert.equal(g.cameraUrl, null);
});

test("the camera service can't be read: a 0.8.0 phone still learns `released` (no 503, no skip for the customer), and the advisor's release reaches it", async () => {
  const created = sessions.createTestSession(adv, {});
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
  const j = sessions.joinByCode({ code: created.session.code, installId: "install-certify-0004", appVersion: "0.8.0", device: { brand: "samsung", modelName: "SM-S918B", isPhysicalDevice: true } }, "127.0.0.1");
  const t = `Ticket ${j.ticket}`;
  sessions.devicePhase(t, { phase: "scan" });
  let old = created;
  giq.screenDown = true;
  try {
    const down = await sessions.deviceScreenGet(t);
    assert.equal(down.unreachable, true);
    assert.equal(down.released, false);
    assert.equal(down.pattern, "idle");
    const g = (await sessions.getTestSession(adv, created.session.id)).session.grading!;
    assert.equal(g.canRelease, true, "the advisor can still let it go on");
    const res = await asUser(adv, () => releaseRoute.POST(new Request(`http://x/api/test-sessions/${created.session.id}/release-scan`, { method: "POST" }), params({ id: created.session.id })));
    assert.equal(res.status, 200);
    await wait(1100);
    const go = await sessions.deviceScreenGet(t);
    assert.equal(go.released, true);
    // An older phone (no `released` in its contract) keeps the 503 it always had.
    old = sessions.createTestSession(adv, {});
    await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(old.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
    const jo = sessions.joinByCode({ code: old.session.code, installId: "install-certify-0005", appVersion: "0.5.0", device: { brand: "samsung", modelName: "SM-S918B", isPhysicalDevice: true } }, "127.0.0.1");
    await assert.rejects(sessions.deviceScreenGet(`Ticket ${jo.ticket}`), (e: Error & { status?: number }) => e.status === 503);
  } finally {
    giq.screenDown = false;
  }
  // Let the joins' forwards to the stand-in finish before it closes (a failed one retries on a timer).
  const forwarded = (id: string) => !!(db().prepare(`SELECT gradeiq_device_hash FROM test_sessions WHERE id = ?`).get(id) as { gradeiq_device_hash: string | null }).gradeiq_device_hash;
  await until("the forwards", () => forwarded(created.session.id) && forwarded(old.session.id));
});

test("SUP-260: a Screen tap while the phone is still testing is taken at once — nothing waits for test colours, and the phone is never asked for them", async () => {
  const created = sessions.createTestSession(adv, { customerName: "Early Tap" });
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
  const j = sessions.joinByCode(
    { code: created.session.code, installId: "install-certify-0006", appVersion: "0.8.0", device: { brand: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", isPhysicalDevice: true } },
    "127.0.0.1"
  );
  const t = `Ticket ${j.ticket}`;
  const at = new Date().toISOString();
  sessions.deviceResults(t, { results: [{ testId: "touch", outcome: "pass", at, detail: null }] });
  sessions.devicePhase(t, { phase: "test" });
  const id = created.session.caseId;
  // Still testing: the Screen is taken like the body and the liquid indicator.
  const early = await act(adv, id, { action: "certify", row: "screen", value: "ok", testSessionId: created.session.id });
  assert.equal(early.status, 200, JSON.stringify(early.data).slice(0, 200));
  assert.equal((early.data.certification as Record<string, { withColours: boolean }>).screen.withColours, false);
  assert.equal((await act(adv, id, { action: "certify", row: "body", value: "like_new", testSessionId: created.session.id })).status, 200);
  assert.equal(sessions.deviceStatus(t).colours, false);
  // The tests finish: still no colours — the customer's phone shows its result, the advisor has the card.
  sessions.deviceComplete(t);
  sessions.devicePhase(t, { phase: "done" });
  assert.equal(sessions.deviceStatus(t).colours, false);
  assert.equal((await sessions.getTestSession(adv, created.session.id)).session.certify?.colours, "off");
  // Let the join's forward to the stand-in finish before it closes.
  const forwarded = () => !!(db().prepare(`SELECT gradeiq_device_hash FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_device_hash: string | null }).gradeiq_device_hash;
  await until("the forward", forwarded);
});

test("an older SwapUp Store's 'Take photos anyway' (the camera override) also lets the phone go on from its Scan step", async () => {
  const created = sessions.createTestSession(adv, {});
  await until("the GradeIQ session", () => (db().prepare(`SELECT gradeiq_state FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_state: string }).gradeiq_state === "ready");
  const j = sessions.joinByCode({ code: created.session.code, installId: "install-certify-0007", appVersion: "0.8.0", device: { brand: "samsung", modelName: "SM-S918B", isPhysicalDevice: true } }, "127.0.0.1");
  const t = `Ticket ${j.ticket}`;
  sessions.devicePhase(t, { phase: "scan" });
  assert.equal((await sessions.deviceScreenGet(t)).released, false);
  await sessions.cameraOverride(adv, created.session.id, { reason: "phone screen not echoing, photos anyway" });
  await wait(1100);
  assert.equal((await sessions.deviceScreenGet(t)).released, true);
  const forwarded = () => !!(db().prepare(`SELECT gradeiq_device_hash FROM test_sessions WHERE id = ?`).get(created.session.id) as { gradeiq_device_hash: string | null }).gradeiq_device_hash;
  await until("the forward", forwarded);
});
