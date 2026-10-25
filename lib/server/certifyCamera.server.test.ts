/**
 * SUP-5 — a tap on "Check the phone" (SwapUp Store) that would record the screen or body BETTER than
 * the store camera confirmed is not recorded and quietly floored: the server answers 409 {error} with
 * the camera's words — the desk's (cases.ts updateCase, gradeiqMap.ts cameraOverrideProblems) — the
 * chip tapped, and where the reason is given (the desk's What's wrong, once the answer is open).
 * Nothing is written on a 409. What the camera confirmed is THIS session's: before Apply (the usual
 * tap — the card holds the answer until it is tapped) the session's own camera, after it the case's
 * record. A tap the camera agrees with, or a worse one, is recorded as before; "All fine" records the
 * camera's own chip on a row it confirmed worse; once a reason is on record the tap stands — Apply
 * doesn't floor it back and the grade report doesn't say "camera stands".
 *
 * Through the REAL route both apps call (POST /api/cases/<id>/action certify), the real test session
 * (join, results, Apply) with a stored camera grade, on a throwaway database.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/certifyCamera.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { namesBrand } from "../domain/testing/brand.ts";

const dir = mkdtempSync(join(tmpdir(), "swapup-certify-camera-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { issueToken } = await import("./auth.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const gr = await import("./gradingReport.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const { blankCameraCheck } = await import("../domain/gradeiqMap.ts");
const { REASON_ON_DESK } = await import("../domain/certify.ts");
const caseRoute = await import("../../app/api/cases/[id]/route.ts");
const actionRoute = await import("../../app/api/cases/[id]/action/route.ts");

after(() => {
  console.log = origLog;
  console.error = origError;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
type View = Awaited<ReturnType<typeof cases.getCase>>;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");

/* ─────────────────────────── the doors the desk and SwapUp Store use ─────────────────────────── */

const H = globalThis as { __swapupTestHeaders?: Record<string, string> };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
/** As SwapUp Store 0.9.3+ (it sends X-SwapUp-App); `legacy` = a pre-0.9.3 Store build, which doesn't. */
async function send(fn: () => Promise<Response>, legacy = false): Promise<{ status: number; data: View & { error?: string } }> {
  H.__swapupTestHeaders = { authorization: `Bearer ${issueToken(adv)}`, "x-swapup-app": legacy ? "" : "store/0.9.3+15" };
  if (legacy) delete H.__swapupTestHeaders["x-swapup-app"];
  try {
    const r = await fn();
    return { status: r.status, data: (await r.json()) as View & { error?: string } };
  } finally {
    H.__swapupTestHeaders = {};
  }
}
const json = (method: string, body: Record<string, unknown>) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** POST /api/cases/<id>/action certify — one tap, or {allFine: true}. */
const certify = (id: string, body: Record<string, unknown>, legacy = false) =>
  send(() => actionRoute.POST(new Request(`http://x/api/cases/${id}/action`, { ...json("POST", { action: "certify", ...body }), headers: { "content-type": "application/json", ...H.__swapupTestHeaders } }), params(id)), legacy);
/** PATCH /api/cases/<id> — the desk's condition change. */
const patch = (id: string, body: Record<string, unknown>) => send(() => caseRoute.PATCH(new Request(`http://x/api/cases/${id}`, json("PATCH", body)), params(id)));

/* ─────────────────────────── a case the store camera graded ─────────────────────────── */

const COND = (screen: string, body: string) => ({ powersOn: true, calls: true, screen, body, issues: [], accessories: { charger: true, box: true, bill: true }, age: "gt11m" });

/**
 * At the counter, its condition recorded at what the camera confirmed (`floor`). The camera's grade is
 * final but its screen sweep didn't check the display, so "Check the phone" asks for the screen (and
 * the liquid indicator) — the case SUP-5 is about.
 */
async function cameraCase(floor: { screen: string; body: string }): Promise<string> {
  const c = cases.createCase(adv, { customerName: "Camera Floor" });
  await cases.updateCase(adv, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition: COND(floor.screen, floor.body) as never });
  const camera = { ...blankCameraCheck(new Date().toISOString()), state: "ready", by: "Asha K.", final: true, conclusive: true, floor };
  db().prepare(`UPDATE cases SET camera_check = ? WHERE id = ?`).run(JSON.stringify(camera), c.id);
  return c.id;
}

/** Everything a tap could write: the case row and its audit trail. */
function written(id: string) {
  return {
    row: db().prepare(`SELECT * FROM cases WHERE id = ?`).get(id),
    audit: (db().prepare(`SELECT COUNT(*) n FROM audit WHERE entity_id = ?`).get(id) as { n: number }).n,
  };
}

const SCREEN_SAYS = (tapped: string) => `Camera confirmed the screen "Visible scratches" — "${tapped}" ${REASON_ON_DESK}`;
/** The grade report as it stands: its disclosures, "DS10: …". */
const disclosures = (id: string) => (gr.gradingReportFor(adv, id).live?.disclosures ?? []).map((d) => `${d.code}: ${d.text}`);

/* ─────────────────────────── a real test session, its camera grade stored ─────────────────────────── */

const BOX = [0.1, 0.1, 0.3, 0.3];
/**
 * A FINAL store-camera grade (GradeIQ's snapshot, as SwapUp stores it): the front glass with
 * confirmed visible scratches when `scratched`, nothing otherwise; the screen sweep hasn't run — so
 * "Check the phone" asks for the screen and the liquid indicator.
 */
function finalGrade(scratched: boolean) {
  const part = (id: string, name: string, findings: unknown[] = []) => ({ id, name, grade: findings.length ? "B" : "A", confidence: 0.9, findings, note: "" });
  const scratch = { type: "scratch", label: "Scratches across the glass", severity: "moderate", confidence: 0.92, photoIndex: 0, box: BOX, location: null, uncorroborated: false };
  return {
    fetchedAt: new Date().toISOString(),
    client: "swapmore-in",
    cosmeticGrade: scratched ? "B" : "A",
    functionalGrade: "",
    overallGrade: "",
    tierUsed: "pro",
    visionModel: null,
    refining: false,
    conclusive: true,
    gradeRange: null,
    needsHumanReview: false,
    coverage: 0.9,
    score: null,
    components: [part("front", "Front glass", scratched ? [scratch] : []), part("back", "Back"), part("frame", "Frame")],
    obstruction: null,
    oem: null,
    device: null,
    capture: { verdict: "ok", code: "ok", reasons: [], attempt: 1 },
    displayCheck: null,
    identity: { verdict: "unverified", flags: [] },
    photos: [],
    angleLabels: [],
  };
}

let installs = 0;
/**
 * The customer's phone tested itself (every test passed) on a new case — or a re-test on `caseId` —
 * and the store camera's final grade is stored on the session. Not applied.
 */
async function testedSession(scratched: boolean, caseId?: string): Promise<{ sessionId: string; caseId: string }> {
  const created = sessions.createTestSession(adv, caseId ? { caseId } : { customerName: "Camera Floor" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-camera-${++installs}`,
      appVersion: "0.9.2",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  const ticket = `Ticket ${joined.ticket}`;
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  sessions.deviceComplete(ticket);
  db().prepare(`UPDATE test_sessions SET gradeiq_state = 'ready', gradeiq_id = ?, gradeiq_snapshot = ? WHERE id = ?`).run(randomUUID(), JSON.stringify(finalGrade(scratched)), created.session.id);
  return { sessionId: created.session.id, caseId: created.session.caseId };
}

/** The store camera on — its service unreachable, so what it graded is what the session has stored. */
async function withCamera<T>(fn: () => Promise<T>): Promise<T> {
  process.env.GRADEIQ_ENABLED = "1";
  process.env.GRADEIQ_BASE_URL = "http://127.0.0.1:9";
  try {
    return await fn();
  } finally {
    process.env.GRADEIQ_ENABLED = "0";
    delete process.env.GRADEIQ_BASE_URL;
  }
}
const apply = (sessionId: string) => sessions.applyTestSession(adv, sessionId);

/* ─────────────────────────── refused, with the camera's sentence ─────────────────────────── */

test("a Screen OK tap better than the camera confirmed: 409 with the camera's sentence and where the reason goes — nothing recorded", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const before = written(id);
  const r = await certify(id, { row: "screen", value: "ok" });
  assert.equal(r.status, 409, JSON.stringify(r.data).slice(0, 300));
  assert.deepEqual(r.data, { error: SCREEN_SAYS("OK") }, "one plain sentence, as the desk's camera 409");
  assert.equal(r.data.error, 'Camera confirmed the screen "Visible scratches" — "OK" needs a reason, given on the desk\'s What\'s wrong once the answer is open.');
  assert.ok(!namesBrand(r.data.error!), r.data.error);
  assert.deepEqual(written(id), before, "nothing written: no tap, no condition, no audit row");
  assert.deepEqual(cases.getCase(adv, id).certification, {});
  assert.equal(cases.getCase(adv, id).condition?.screen, "scratched", "the price stays at what the camera confirmed");
});

test("the desk's own camera 409 and the tap's say what the camera confirmed in the same words; the tap names its chip", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const desk = await patch(id, { condition: COND("flawless", "flawless") });
  assert.equal(desk.status, 409);
  assert.equal(desk.data.error, 'Camera confirmed the screen "Visible scratches" — "Flawless" needs a reason.');
  const tap = await certify(id, { row: "screen", value: "ok" });
  const camera = (why: string) => why.split(" — ")[0];
  assert.equal(camera(tap.data.error!), camera(desk.data.error!));
  assert.equal(tap.data.error, `${camera(desk.data.error!)} — "OK" ${REASON_ON_DESK}`, "the chip as the card shows it");
});

test("a body tap better than the camera confirmed is refused the same way", async () => {
  const id = await cameraCase({ screen: "flawless", body: "back_cracked" });
  const before = written(id);
  for (const [value, word] of [
    ["like_new", "Like new"],
    ["scuffs", "Scuffs"],
    ["dents", "Dents"],
  ] as const) {
    const r = await certify(id, { row: "body", value });
    assert.equal(r.status, 409, value);
    assert.equal(r.data.error, `Camera confirmed the body "Back glass cracked" — "${word}" ${REASON_ON_DESK}`);
  }
  assert.deepEqual(written(id), before);
});

test("\"All fine\" is never refused for what the camera confirmed: on that row it records the camera's own chip — the row says what the phone is priced at", async () => {
  const screen = await cameraCase({ screen: "scratched", body: "flawless" });
  const r = await certify(screen, { allFine: true });
  assert.equal(r.status, 200, r.data.error);
  const rows = (v: View) => Object.fromEntries(Object.entries(v.certification).map(([k, x]) => [k, x!.value]));
  assert.deepEqual(rows(r.data), { screen: "scratches", body: "like_new", liquid: "cant_see" }, "nothing beyond what the camera saw");
  assert.deepEqual([r.data.condition?.screen, r.data.condition?.body], ["scratched", "flawless"]);
  const audits = db().prepare(`SELECT detail FROM audit WHERE action = 'case.certify' AND entity_id = ? ORDER BY id`).all(screen) as { detail: string }[];
  assert.deepEqual(audits.map((x) => [JSON.parse(x.detail).row, JSON.parse(x.detail).value, JSON.parse(x.detail).allFine]), [["screen", "scratches", true], ["body", "like_new", true], ["liquid", "cant_see", true]]);
  assert.ok(!disclosures(screen).some((d) => d.startsWith("DS10")), "no 'camera stands': the row agrees with it");

  // The body (tapped by "All fine" though the card asked only the screen): the camera's chip too.
  const body = await cameraCase({ screen: "flawless", body: "dented" });
  const r2 = await certify(body, { allFine: true });
  assert.equal(r2.status, 200, r2.data.error);
  assert.deepEqual(rows(r2.data), { screen: "ok", body: "dents", liquid: "cant_see" });
  assert.equal(r2.data.condition?.body, "dented");
  // A single "Like new" tap there is still refused: "All fine" is not a way round the camera.
  const one = await certify(body, { row: "body", value: "like_new" });
  assert.equal(one.status, 409);
});

/* ─────────────────────────── what still goes through ─────────────────────────── */

test("a tap the camera agrees with, a worse one, and the liquid indicator are recorded as before", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const same = await certify(id, { row: "screen", value: "scratches" });
  assert.equal(same.status, 200, same.data.error);
  assert.equal(same.data.certification.screen?.value, "scratches");
  assert.equal(same.data.condition?.screen, "scratched");
  const worse = await certify(id, { row: "screen", value: "cracked" });
  assert.equal(worse.status, 200, worse.data.error);
  assert.equal(worse.data.condition?.screen, "cracked");
  assert.ok(worse.data.faults.includes("screen_cracked"));
  const liquid = await certify(id, { row: "liquid", value: "tripped" });
  assert.equal(liquid.status, 200, liquid.data.error);
  assert.equal(liquid.data.certification.liquid?.value, "tripped");
  // A phone the camera found nothing on: "All fine" goes through.
  const clean = await cameraCase({ screen: "flawless", body: "flawless" });
  const fine = await certify(clean, { allFine: true });
  assert.equal(fine.status, 200, fine.data.error);
  assert.deepEqual(Object.keys(fine.data.certification).sort(), ["body", "liquid", "screen"]);
});

test("once the reason is on record (\"Why it's better\" on the desk), the tap stands — never refused again, never floored back", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const saved = await patch(id, { condition: COND("flawless", "flawless"), cameraOverride: { reason: "Scratches are on the screen guard only" } });
  assert.equal(saved.status, 200, saved.data.error);
  assert.equal(saved.data.condition?.screen, "flawless");
  const tap = await certify(id, { row: "screen", value: "ok" });
  assert.equal(tap.status, 200, tap.data.error);
  assert.equal(tap.data.certification.screen?.value, "ok");
  assert.equal(tap.data.condition?.screen, "flawless", "the reasoned override is not undone by the tap");
  // The grade report says what happened: the reason (DS4), and no "camera stands" — the phone is priced flawless.
  const said = disclosures(id);
  assert.ok(said.includes("DS4: Recorded better than the camera saw, by " + adv.name + ": Scratches are on the screen guard only"), said.join("\n"));
  assert.ok(!said.some((d) => d.startsWith("DS10")), said.join("\n"));
  // The body the reason didn't cover still stands on the camera.
  const body = await cameraCase({ screen: "scratched", body: "dented" });
  await patch(body, { condition: COND("flawless", "dented"), cameraOverride: { reason: "Scratches are on the screen guard only" } });
  const r = await certify(body, { row: "body", value: "like_new" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, `Camera confirmed the body "Dents on the frame" — "Like new" ${REASON_ON_DESK}`);
});

/* ─────────────────────────── through the real test session ─────────────────────────── */

test("before Apply — the usual tap: Screen OK against the session's own camera (scratches confirmed) is refused 409, nothing written; the tap it agrees with goes on, and Apply prices what was tapped", async () => {
  const { sessionId, caseId } = await testedSession(true);
  await withCamera(async () => {
    const card = cases.getCase(adv, caseId).certify;
    assert.deepEqual(card?.needed, ["screen", "liquid"], "the sweep didn't check the screen: the card asks it");
    assert.equal(cases.getCase(adv, caseId).camera, null, "nothing applied yet: no camera record on the case");
    const before = written(caseId);
    const r = await certify(caseId, { row: "screen", value: "ok", testSessionId: sessionId });
    assert.equal(r.status, 409, JSON.stringify(r.data).slice(0, 300));
    assert.deepEqual(r.data, { error: SCREEN_SAYS("OK") });
    assert.deepEqual(written(caseId), before, "nothing written");
    // What the camera saw goes through, and Apply puts on the case exactly what was tapped.
    assert.equal((await certify(caseId, { row: "screen", value: "scratches", testSessionId: sessionId })).status, 200);
    assert.equal((await certify(caseId, { row: "liquid", value: "clean", testSessionId: sessionId })).status, 200);
    await apply(sessionId);
    const v = cases.getCase(adv, caseId);
    assert.equal(v.camera?.floor.screen, "scratched");
    assert.deepEqual([v.certification.screen?.value, v.condition?.screen], ["scratches", "scratched"], "the row says what is priced");
    assert.ok(!disclosures(caseId).some((d) => d.startsWith("DS10")));
  });
});

test("\"All fine\" before Apply, and after a manual Apply (the card still open): the camera's chip, never a 409", async () => {
  const early = await testedSession(true);
  const late = await testedSession(true);
  await withCamera(async () => {
    const a = await certify(early.caseId, { allFine: true, testSessionId: early.sessionId });
    assert.equal(a.status, 200, a.data.error);
    assert.equal(a.data.certification.screen?.value, "scratches");
    await apply(early.sessionId);
    assert.equal(cases.getCase(adv, early.caseId).condition?.screen, "scratched");

    // "Apply the results so far" first: the card stays open, and "All fine" clears it.
    await apply(late.sessionId);
    assert.ok(cases.getCase(adv, late.caseId).certify?.needed.includes("screen"));
    const b = await certify(late.caseId, { allFine: true, testSessionId: late.sessionId });
    assert.equal(b.status, 200, b.data.error);
    assert.deepEqual([b.data.certification.screen?.value, b.data.certification.liquid?.value, b.data.condition?.screen], ["scratches", "cant_see", "scratched"]);
  });
});

test("a re-test's taps stand on the re-test's camera, never an earlier session's", async () => {
  const first = await testedSession(true);
  await withCamera(() => apply(first.sessionId));
  assert.equal(cases.getCase(adv, first.caseId).condition?.screen, "scratched", "the first camera's finding is on the case");
  // The re-test: this time the camera found nothing on the glass.
  const again = await testedSession(false, first.caseId);
  await withCamera(async () => {
    const r = await certify(first.caseId, { row: "screen", value: "ok", testSessionId: again.sessionId });
    assert.equal(r.status, 200, r.data.error);
    assert.equal(r.data.condition?.screen, "flawless", "held to the re-test's camera, which confirmed nothing");
    await apply(again.sessionId);
    const v = cases.getCase(adv, first.caseId);
    assert.deepEqual([v.camera?.testSessionId, v.certification.screen?.value, v.condition?.screen], [again.sessionId, "ok", "flawless"]);
  });
});

test("a reason on record carries over to a re-test: the tap stands before Apply, Apply doesn't floor it back, and the report doesn't say \"camera stands\"", async () => {
  const first = await testedSession(true);
  await withCamera(() => apply(first.sessionId));
  const saved = await patch(first.caseId, { condition: { ...cases.getCase(adv, first.caseId).condition, screen: "flawless" }, cameraOverride: { reason: "Scratches are on the screen guard only" } });
  assert.equal(saved.status, 200, saved.data.error);
  // The re-test's camera sees the same scratches.
  const again = await testedSession(true, first.caseId);
  await withCamera(async () => {
    const r = await certify(first.caseId, { row: "screen", value: "ok", testSessionId: again.sessionId });
    assert.equal(r.status, 200, r.data.error);
    await apply(again.sessionId);
    const v = cases.getCase(adv, first.caseId);
    assert.equal(v.camera?.floor.screen, "scratched", "the camera's finding is kept on its record");
    assert.deepEqual([v.certification.screen?.value, v.condition?.screen], ["ok", "flawless"], "the reasoned tap is not floored back");
    const said = disclosures(first.caseId);
    assert.ok(said.some((d) => d.startsWith("DS4: ")), said.join("\n"));
    assert.ok(!said.some((d) => d.startsWith("DS10")), said.join("\n"));
  });
});

test("a Store build from before 0.9.3 (no X-SwapUp-App): its \"All fine\" single taps are never refused — recorded as sent, priced at what the camera confirmed, disclosed on the report, as 0.9.2 did", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  // The 0.9.2 / 0.9.0 app's "All fine": three single taps, in order, with no version header.
  for (const [row, value] of [["screen", "ok"], ["body", "like_new"], ["liquid", "cant_see"]] as const) {
    const r = await certify(id, { row, value }, true);
    assert.equal(r.status, 200, `${row}=${value}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const v = cases.getCase(adv, id);
  assert.equal(v.certification.screen?.value, "ok", "the advisor's own tap, as sent — never the camera's chip in their name");
  assert.equal(v.certification.body?.value, "like_new");
  assert.equal(v.condition?.screen, "scratched", "priced at what the camera confirmed");
  assert.ok(disclosures(id).some((d) => d.startsWith("DS10") && /camera stands/.test(d)), `the report discloses that the camera stands (DS10), as 0.9.2's did: ${disclosures(id).join(" | ")}`);
  // The same tap from SwapUp Store 0.9.3 (it sends the header) is still refused with the sentence.
  const id2 = await cameraCase({ screen: "scratched", body: "flawless" });
  assert.equal((await certify(id2, { row: "screen", value: "ok" })).status, 409);
});

/* ─────────────────────────── SUP-260: the owner's flow — no colour loop; a partial sweep is the advisor's look ─────────────────────────── */

const ALL6 = ["white", "black", "red", "green", "blue", "stripes"];
/** SU-AND-00048's sweep: 4 of 6 colours captured (black and green missing), "fail" at 0.8 on one moderate "Dark area on left"; `missing: []` = the complete 6/6 sweep. */
function sweepCheck(missing: string[], verdict: "pass" | "fail" = "fail") {
  return {
    verdict,
    confidence: 0.8,
    note: "",
    source: "gemini",
    findings: verdict === "fail" ? [{ type: "dark_area", label: "Dark area on left", confidence: 0.8, pattern: "white", severity: "moderate" }] : [],
    patterns: ALL6,
    captures: ALL6.filter((p) => !missing.includes(p)).map((p) => ({ pattern: p, photo: `/api/uploads/x-disp-${p}.jpg` })),
    requested: ALL6,
    missing,
    reason: null,
  };
}
// The partner prices the S23 Ultra these phones are, so the answer opens with a trade-in to read.
{
  const partner = who((db().prepare(`SELECT id FROM users WHERE username = 'partner'`).get() as { id: string }).id);
  const { uploadRateCard } = await import("./catalog.ts");
  const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");
  uploadRateCard(partner, { label: "Week 43 (test)", effectiveFrom: "2026-10-19", quoteValidityDays: 3, csv: "model_id,variant,max_price\ngalaxy-s23-ultra,256GB,40000\n", deductions: DEFECT_DEDUCTIONS, activate: true });
}

/** The customer's phone (SwapUp Check 0.9.3) on a new case, its camera grade stored: final, nothing on the glass, the given sweep. */
function sweptPhone(dc: ReturnType<typeof sweepCheck> | null, opts: { complete?: boolean } = {}) {
  const created = sessions.createTestSession(adv, { customerName: "Sweep" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-sweep-${++installs}`,
      appVersion: "0.9.3",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  const ticket = `Ticket ${joined.ticket}`;
  db().prepare(`UPDATE test_sessions SET gradeiq_state = 'ready', gradeiq_id = ?, gradeiq_snapshot = ? WHERE id = ?`).run(randomUUID(), JSON.stringify({ ...finalGrade(false), displayCheck: dc }), created.session.id);
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health" && (opts.complete !== false || p.id === "touch")).map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  if (opts.complete !== false) {
    sessions.deviceComplete(ticket);
    sessions.devicePhase(ticket, { phase: "done" });
  }
  return { sessionId: created.session.id, caseId: created.session.caseId, ticket };
}
const sessionStatus = (id: string) => (db().prepare(`SELECT status FROM test_sessions WHERE id = ?`).get(id) as { status: string }).status;
async function untilApplied(id: string, poll: () => unknown) {
  for (let i = 0; i < 100 && sessionStatus(id) !== "applied"; i++) {
    poll();
    await new Promise((r) => setTimeout(r, 20));
  }
  return sessionStatus(id);
}

test("SUP-260 (a): SU-AND-00048's partial sweep, tests done — no colour loop, the card's note; \"All fine\" records the screen OK with no display_lines and no −35%; the answer opens by itself", async () => {
  const t = sweptPhone(sweepCheck(["black", "green"]));
  await withCamera(async () => {
    assert.equal(sessions.deviceStatus(t.ticket).colours, false, "the phone is never asked for the test colours");
    const v = (await sessions.getTestSession(adv, t.sessionId)).session;
    assert.equal(v.certify?.colours, "off");
    assert.deepEqual(v.certify?.notes, { screen: "Screen not fully camera-checked — look at it." });
    assert.ok(v.certify?.needed.includes("screen"));
    assert.equal(v.autoApply?.state, "waiting", "the advisor's look, not a colour loop");
    assert.equal((v.autoApply as { for?: string }).for, "certify");
    // The advisor looks and taps "All fine" — nothing from the camera stands against it.
    const fine = await certify(t.caseId, { allFine: true, testSessionId: t.sessionId });
    assert.equal(fine.status, 200, fine.data.error);
    assert.equal(fine.data.certification.screen?.value, "ok", "the advisor's fine, recorded");
    // The session applies by itself — no Apply tap, no colours.
    assert.equal(await untilApplied(t.sessionId, () => sessions.deviceStatus(t.ticket)), "applied");
    const c = cases.getCase(adv, t.caseId);
    assert.ok(!c.faults.includes("display_lines"), c.faults.join(","));
    assert.equal(c.condition?.screen, "flawless");
    assert.equal(c.camera?.floor.screen, "flawless", "no lines_or_spots floor");
    assert.equal(c.camera?.lcd.doubt, "the screen sweep didn't see every colour");
    assert.ok(c.camera?.flags.includes("Screen not fully camera-checked — look at it."), c.camera?.flags.join(" | "));
    assert.equal(c.quote?.status, "priced");
    assert.ok(!(c.quote?.lines ?? []).some((l) => l.bp === 3500), `no −35% lines deduction: ${JSON.stringify(c.quote?.lines)}`);
    assert.ok(c.offer?.swap.tradeIn && c.offer.swap.tradeIn > 30000, String(c.offer?.swap.tradeIn));
    // The answer's format and its ONE grade are unchanged: the report's grade is the answer's.
    assert.ok(c.grading?.label, "one grade on the case");
  });
});

test("SUP-260 (b): a COMPLETE, confirmed sweep fail + \"All fine\" — the fault stays (SUP-5): the camera's chip, display_lines, the floor", async () => {
  const t = sweptPhone(sweepCheck([]));
  await withCamera(async () => {
    const v = (await sessions.getTestSession(adv, t.sessionId)).session;
    assert.deepEqual(v.certify?.notes, { screen: null }, "the sweep saw every colour");
    const fine = await certify(t.caseId, { allFine: true, testSessionId: t.sessionId });
    assert.equal(fine.status, 200, fine.data.error);
    assert.equal(fine.data.certification.screen?.value, "lines", "the camera's own chip: nothing beyond what it saw");
    assert.equal(await untilApplied(t.sessionId, () => sessions.deviceStatus(t.ticket)), "applied");
    const c = cases.getCase(adv, t.caseId);
    assert.ok(c.faults.includes("display_lines"), c.faults.join(","));
    assert.equal(c.condition?.screen, "lines_or_spots");
    assert.ok((c.quote?.lines ?? []).some((l) => l.bp === 3500), "the lines deduction is priced");
  });
});

test("SUP-260 (c): nothing to certify (a final grade, a complete passing sweep) — the answer opens at once, no colours, no card", async () => {
  const t = sweptPhone(sweepCheck([], "pass"));
  await withCamera(async () => {
    assert.equal(sessions.deviceStatus(t.ticket).colours, false);
    assert.equal(await untilApplied(t.sessionId, () => sessions.deviceStatus(t.ticket)), "applied");
    const c = cases.getCase(adv, t.caseId);
    assert.deepEqual(c.certify?.needed, []);
    assert.deepEqual(c.certification, {});
    assert.equal(c.condition?.screen, "flawless");
  });
});

test("SUP-260 (d): a Screen tap while the phone is still testing is accepted — against the session's partial sweep, nothing to wait for", async () => {
  const t = sweptPhone(sweepCheck(["black", "green"]), { complete: false });
  await withCamera(async () => {
    const r = await certify(t.caseId, { row: "screen", value: "ok", testSessionId: t.sessionId });
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
    assert.equal(r.data.certification.screen?.value, "ok");
    assert.ok(!r.data.faults.includes("display_lines"));
    assert.equal(sessions.deviceStatus(t.ticket).colours, false);
  });
});
