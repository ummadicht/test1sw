/**
 * SUP-261 — when the store camera's page finished (handoffAt) is kept once SwapUp has seen it.
 * GradeIQ's /cosmetic save rewrites its `screen` from a copy read before the phone's handoff, so
 * `handoffDone` reads false again a moment later; SwapUp used to clear its stamp on that read
 * (handoffAt was null on 36 of 36 production sessions). Only an explicit retake clears it now.
 *
 * Through the REAL bridge (refreshScreen via the phone's GET /api/device/screen, the staff read,
 * Apply's last pull) against a stand-in GradeIQ on 127.0.0.1, with a fake clock (node:test mock
 * timers, Date only) for the 180 s pull window: the pull window opens at the handoff and Apply
 * waits inside it (GRADE_WAIT) — for a grade still refining, for a sweep still running, for a
 * verdict not read since the handoff — and the advisor can't "release" a phone whose camera finished.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/handoff.server.test.ts
 */
import "./testing/register.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/* ─────────────────────────── a stand-in GradeIQ: each session's /screen and grade set by the test ─────────────────────────── */

type Screen = { cosmeticDone: boolean; handoffDone: boolean; capture: { verdict: string; code: string; reasons: string[]; attempt: number } | null };
type Grade = "refining" | "final";
type Giq = { screen: Screen; grade: Grade; displayCheck: Record<string, unknown> | null; shown: string | null };
const giq = new Map<string, Giq>();
const OK = { verdict: "ok", code: "ok", reasons: [], attempt: 1 };
const comp = (id: string) => ({ id, name: id, grade: "A", confidence: 0.9, findings: [] });
const PASS = {
  verdict: "pass",
  confidence: 0.93,
  findings: [],
  note: "",
  source: "gemini",
  patterns: ["white", "black", "red", "green", "blue", "stripes"],
  captures: ["white", "black", "red", "green", "blue", "stripes"].map((p) => ({ pattern: p, photo: `/api/uploads/d-${p}.jpg` })),
  requested: ["white", "black", "red", "green", "blue", "stripes"],
  missing: [],
};

function sessionBody(id: string, g: Giq) {
  const final = g.grade === "final";
  return {
    id,
    client_id: "swapmore-in",
    status: "open",
    cosmetic_grade: final ? "A" : "",
    functional_grade: "",
    overall_grade: "",
    photos: [`/api/uploads/${id}-0.jpg`],
    capture: g.screen.capture,
    identity: { verdict: "unverified", flags: [] },
    cosmetic: { grade: final ? "A" : "", conclusive: true, tierUsed: final ? "pro" : "flash", refining: !final, needsHumanReview: false, coverage: 0.9, score: 90, specialists: final ? ["front", "back", "frame", "cameras"].map(comp) : [] },
    screen: { ...g.screen, displayCheck: g.displayCheck },
  };
}

function handler(req: IncomingMessage, body: string, res: ServerResponse) {
  const url = req.url ?? "";
  const json = (v: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  if (req.method === "POST" && url === "/api/sessions") {
    const id = randomUUID();
    giq.set(id, { screen: { cosmeticDone: false, handoffDone: false, capture: null }, grade: "refining", displayCheck: null, shown: null });
    return json({ id, client: "swapmore-in" });
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/report\/([0-9a-f-]{36})\/export$/.exec(url))) return json({ passportId: "DFX-TEST-0261", photos: [] });
  if (!(m = /^\/api\/sessions\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(url))) return json({ error: "not found" }, 404);
  const [, id, rest = ""] = m;
  const g = giq.get(id);
  if (!g) return json({ error: "not found" }, 404);
  if (rest === "/screen" && req.method === "GET") return json({ pattern: "idle", shown: g.shown, ...g.screen, connectedAt: "2026-10-25T00:00:00.000Z" });
  if (rest === "/screen" && req.method === "POST") {
    g.shown = (JSON.parse(body || "{}") as { shown?: string }).shown ?? null;
    return json({ ok: true });
  }
  if (rest === "/device" || rest === "/functional") return json({ ok: true });
  if (rest === "") return json(sessionBody(id, g));
  return json({ error: "not found" }, 404);
}

const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => handler(req, body, res));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const GIQ = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

/* ─────────────────────────── a throwaway server ─────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "swapup-handoff-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "1";
process.env.GRADEIQ_BASE_URL = GIQ;
process.env.GRADEIQ_PUBLIC_URL = GIQ;
process.env.GRADEIQ_CLIENT = "swapmore-in";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origError = console.error;
const origLog = console.log;
console.error = () => {};
console.log = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const { nextHandoffAt } = await import("./gradeiqBridge.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");

after(async () => {
  mock.timers.reset();
  console.error = origError;
  console.log = origLog;
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 4000) {
  for (let waited = 0; !ok(); waited += 20) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await realWait(20);
  }
}
const row = (id: string) => db().prepare(`SELECT status, gradeiq_id, gradeiq_state, gradeiq_screen, gradeiq_cosmetic_done_at, gradeiq_device_hash FROM test_sessions WHERE id = ?`).get(id) as {
  status: string;
  gradeiq_id: string | null;
  gradeiq_state: string;
  gradeiq_screen: string | null;
  gradeiq_cosmetic_done_at: string | null;
  gradeiq_device_hash: string | null;
};
const handoffAt = (id: string) => (JSON.parse(row(id).gradeiq_screen ?? "{}") as { handoffAt?: string | null }).handoffAt ?? null;

let installs = 0;
/** A session the customer's phone (SwapUp Check 0.9.3) joined, its GradeIQ session made and the device report forwarded. */
async function joined() {
  const created = sessions.createTestSession(adv, { customerName: "Handoff" });
  await until("the GradeIQ session", () => row(created.session.id).gradeiq_state === "ready");
  const j = sessions.joinByCode(
    { code: created.session.code, installId: `install-handoff-${++installs}`, appVersion: "0.9.3", device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true } },
    "127.0.0.1"
  );
  await until("the device forward", () => !!row(created.session.id).gradeiq_device_hash);
  const g = giq.get(row(created.session.id).gradeiq_id!)!;
  return { id: created.session.id, caseId: created.session.caseId, ticket: `Ticket ${j.ticket}`, g };
}
/** The phone's own poll of /screen (maxAge 0): what SwapUp records from GradeIQ's /screen now. */
const phonePoll = (ticket: string) => sessions.deviceScreenGet(ticket);
function finishTests(ticket: string) {
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  sessions.deviceComplete(ticket);
}
const applyNow = (id: string) => sessions.applyTestSession(adv, id).then(() => "applied", (e: Error & { status?: number }) => `${e.status} ${e.message}`);
const WAIT = `409 ${sessions.GRADE_WAIT}`;

/* ─────────────────────────── the rule ─────────────────────────── */

test("nextHandoffAt: stamped at the first handoffDone, kept while GradeIQ's flag reads false again, cleared only by a retake", () => {
  const scr = (handoffDone: boolean, verdict: string | null = "ok") => ({ pattern: "idle", shown: null, cosmeticDone: true, handoffDone, capture: verdict ? { verdict, code: verdict, reasons: [], attempt: 1 } : null, connectedAt: null });
  const T = "2026-10-25T10:00:40.000Z";
  assert.equal(nextHandoffAt(null, scr(true), T), T);
  assert.equal(nextHandoffAt("2026-10-25T10:00:00.000Z", scr(true), T), "2026-10-25T10:00:00.000Z", "the first sight stands");
  assert.equal(nextHandoffAt(T, scr(false), "2026-10-25T10:00:41.000Z"), T, "the flag wiped by /cosmetic: kept");
  assert.equal(nextHandoffAt(T, scr(false, null), "x"), T);
  assert.equal(nextHandoffAt(T, null, "x"), T, "an unreadable /screen changes nothing");
  assert.equal(nextHandoffAt(T, scr(false, "retake"), "x"), null, "a retake: the retaken pass gets its own stamp");
  assert.equal(nextHandoffAt(T, scr(false, "retaking"), "x"), null);
  assert.equal(nextHandoffAt(null, scr(false), "x"), null);
});

/* ─────────────────────────── through the bridge ─────────────────────────── */

test("the handoff flag wiped later by GradeIQ's /cosmetic save: the stamp is kept — and the advisor can no longer 'release' the phone", async () => {
  const s = await joined();
  sessions.devicePhase(s.ticket, { phase: "scan" });
  s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
  await phonePoll(s.ticket);
  assert.equal(handoffAt(s.id), null, "photos accepted, the camera page still running");
  assert.equal((await sessions.getTestSession(adv, s.id)).session.grading?.canRelease, true, "before the handoff the advisor may let the phone go on");
  s.g.screen = { cosmeticDone: true, handoffDone: true, capture: OK };
  await phonePoll(s.ticket);
  const stamp = handoffAt(s.id);
  assert.ok(stamp && !Number.isNaN(Date.parse(stamp)), String(stamp));
  // GradeIQ's /cosmetic rewrites its screen from an older copy: handoffDone reads false again.
  s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
  await realWait(5);
  await phonePoll(s.ticket);
  assert.equal(handoffAt(s.id), stamp, "kept");
  await realWait(5);
  await phonePoll(s.ticket);
  assert.equal(handoffAt(s.id), stamp, "and kept");
  assert.equal((await sessions.getTestSession(adv, s.id)).session.grading?.canRelease, false, "the camera finished: nothing to release");
});

test("a retake clears the stamp; the retaken pass's own handoff stamps it again", async () => {
  const s = await joined();
  s.g.screen = { cosmeticDone: true, handoffDone: true, capture: OK };
  await phonePoll(s.ticket);
  const first = handoffAt(s.id);
  assert.ok(first);
  s.g.screen = { cosmeticDone: false, handoffDone: false, capture: { verdict: "retake", code: "blurry", reasons: ["blurry"], attempt: 2 } };
  await phonePoll(s.ticket);
  assert.equal(handoffAt(s.id), null);
  assert.equal(row(s.id).gradeiq_cosmetic_done_at, null, "the photos' stamp goes with it, as before");
  await realWait(10);
  s.g.screen = { cosmeticDone: true, handoffDone: true, capture: { ...OK, attempt: 2 } };
  await phonePoll(s.ticket);
  const second = handoffAt(s.id);
  assert.ok(second && Date.parse(second) > Date.parse(first!), `${second} after ${first}`);
});

/* ─────────────────────────── the pull window, on a fake clock ─────────────────────────── */

test("the pull window opens at the handoff (T+40 s): Apply waits (GRADE_WAIT) for a grade still refining — at T+200 s too — and goes on once the verdict is pulled; with no verdict the wait ends 180 s after the handoff", async () => {
  const a = await joined();
  const b = await joined();
  const T = Date.now();
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    // T: the photos are accepted; the camera page is still sweeping the screen; the grade is refining.
    for (const s of [a, b]) {
      s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
      await phonePoll(s.ticket);
      assert.equal(row(s.id).gradeiq_cosmetic_done_at, new Date(T).toISOString());
    }
    // T+40 s: the camera page finishes (handoff) — no display verdict yet.
    mock.timers.tick(40_000);
    for (const s of [a, b]) {
      s.g.screen = { cosmeticDone: true, handoffDone: true, capture: OK };
      await phonePoll(s.ticket);
    }
    const handoff = new Date(T + 40_000).toISOString();
    assert.deepEqual([handoffAt(a.id), handoffAt(b.id)], [handoff, handoff]);
    // T+41 s: GradeIQ's /cosmetic save wipes the flag; the phone finishes its tests.
    mock.timers.tick(1_000);
    for (const s of [a, b]) {
      s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
      await phonePoll(s.ticket);
      assert.equal(handoffAt(s.id), handoff, "kept");
      finishTests(s.ticket);
    }
    assert.equal(await applyNow(a.id), WAIT, "the grade is still being worked out");
    // T+200 s: past 180 s from the photos, inside 180 s from the handoff — the window is the handoff's.
    mock.timers.tick(159_000);
    assert.equal(await applyNow(a.id), WAIT, "still waiting: the window opened at the handoff, not at the photos");
    assert.equal(await applyNow(b.id), WAIT);
    // A: the verdict arrives — a final grade and the screen sweep's pass — and Apply's own pull reads it.
    a.g.grade = "final";
    a.g.displayCheck = PASS;
    assert.equal(await applyNow(a.id), "applied");
    const ca = cases.getCase(adv, a.caseId);
    assert.equal(ca.camera?.final, true);
    assert.equal(ca.camera?.lcd.cameraChecked, true, "the verdict pulled after the handoff is on the case");
    // B: no verdict ever — at T+221 s (181 s after the handoff) the wait ends and Apply goes on.
    mock.timers.tick(21_000);
    assert.equal(await applyNow(b.id), "applied");
    const cb = cases.getCase(adv, b.caseId);
    assert.equal(cb.camera?.final, false);
    assert.equal(cb.camera?.lcd.cameraChecked, false);
  } finally {
    mock.timers.reset();
  }
});

test("a FINAL grade: Apply waits while the sweep is still running (no handoff yet) and for a verdict not read since the handoff — then goes on", async () => {
  const s = await joined();
  s.g.grade = "final";
  const T = Date.now();
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
    await phonePoll(s.ticket);
    finishTests(s.ticket);
    assert.equal(await applyNow(s.id), WAIT, "the camera page is still sweeping the screen (sweepRunning)");
    mock.timers.tick(30_000);
    s.g.screen = { cosmeticDone: true, handoffDone: true, capture: OK };
    // Apply's own /screen read sees the handoff at this instant: its verdict hasn't been read since (lcdPending).
    assert.equal(await applyNow(s.id), WAIT, "the handoff just seen: its verdict not read since");
    assert.equal(handoffAt(s.id), new Date(T + 30_000).toISOString());
    // The flag wiped again, a second later: the stamp stands, the pull after it finds no verdict — Apply goes on.
    mock.timers.tick(1_000);
    s.g.screen = { cosmeticDone: true, handoffDone: false, capture: OK };
    assert.equal(await applyNow(s.id), "applied");
    assert.equal(handoffAt(s.id), new Date(T + 30_000).toISOString());
  } finally {
    mock.timers.reset();
  }
});
