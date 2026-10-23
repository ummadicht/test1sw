/**
 * SUP-5 — a tap on "Check the phone" (SwapUp Store, or the desk's "All fine") that would record the
 * screen or body BETTER than the store camera confirmed is not recorded and quietly floored: the
 * server answers 409 {error} with the camera's own sentence — the desk's (cases.ts updateCase,
 * gradeiqMap.ts cameraOverrideProblems) — and where the reason is given ("Why it's better" on the
 * desk). Nothing is written on a 409. A tap the camera agrees with, or a worse one, is recorded as
 * before; once a reason is on record the tap stands.
 *
 * Through the REAL route both apps call (POST /api/cases/<id>/action certify), on a throwaway database.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/certifyCamera.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function send(fn: () => Promise<Response>): Promise<{ status: number; data: View & { error?: string } }> {
  H.__swapupTestHeaders = { authorization: `Bearer ${issueToken(adv)}` };
  try {
    const r = await fn();
    return { status: r.status, data: (await r.json()) as View & { error?: string } };
  } finally {
    H.__swapupTestHeaders = {};
  }
}
const json = (method: string, body: Record<string, unknown>) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** POST /api/cases/<id>/action certify — one tap, or {allFine: true}. */
const certify = (id: string, body: Record<string, unknown>) =>
  send(() => actionRoute.POST(new Request(`http://x/api/cases/${id}/action`, json("POST", { action: "certify", ...body })), params(id)));
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

/* ─────────────────────────── refused, with the camera's sentence ─────────────────────────── */

test("a Screen OK tap better than the camera confirmed: 409 with the camera's sentence and where the reason goes — nothing recorded", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const before = written(id);
  const r = await certify(id, { row: "screen", value: "ok" });
  assert.equal(r.status, 409, JSON.stringify(r.data).slice(0, 300));
  assert.deepEqual(r.data, { error: SCREEN_SAYS("Flawless") }, "one plain sentence, as the desk's camera 409");
  assert.equal(r.data.error, 'Camera confirmed the screen "Visible scratches" — "Flawless" needs a reason, given under "Why it\'s better" on the desk.');
  assert.ok(!namesBrand(r.data.error!), r.data.error);
  assert.deepEqual(written(id), before, "nothing written: no tap, no condition, no audit row");
  assert.deepEqual(cases.getCase(adv, id).certification, {});
  assert.equal(cases.getCase(adv, id).condition?.screen, "scratched", "the price stays at what the camera confirmed");
});

test("the desk's own camera 409 and the tap's say the same thing, from the same words", async () => {
  const id = await cameraCase({ screen: "scratched", body: "flawless" });
  const desk = await patch(id, { condition: COND("flawless", "flawless") });
  assert.equal(desk.status, 409);
  assert.equal(desk.data.error, 'Camera confirmed the screen "Visible scratches" — "Flawless" needs a reason.');
  const tap = await certify(id, { row: "screen", value: "ok" });
  assert.equal(tap.data.error, desk.data.error!.replace(/needs a reason\.$/, REASON_ON_DESK));
});

test("a body tap better than the camera confirmed is refused the same way", async () => {
  const id = await cameraCase({ screen: "flawless", body: "back_cracked" });
  const before = written(id);
  for (const [value, word] of [
    ["like_new", "Flawless"],
    ["scuffs", "Light scuffs"],
    ["dents", "Dents on the frame"],
  ] as const) {
    const r = await certify(id, { row: "body", value });
    assert.equal(r.status, 409, value);
    assert.equal(r.data.error, `Camera confirmed the body "Back glass cracked" — "${word}" ${REASON_ON_DESK}`);
  }
  assert.deepEqual(written(id), before);
});

test("\"All fine\" that would override a camera finding: 409 naming the row, and none of its taps recorded (not even the liquid row)", async () => {
  const screen = await cameraCase({ screen: "scratched", body: "flawless" });
  const before = written(screen);
  const r = await certify(screen, { allFine: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, SCREEN_SAYS("Flawless"), "it names the screen");
  assert.deepEqual(written(screen), before);
  assert.deepEqual(cases.getCase(adv, screen).certification, {});

  const body = await cameraCase({ screen: "flawless", body: "bent" });
  const r2 = await certify(body, { allFine: true });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.error, `Camera confirmed the body "Bent or broken frame" — "Flawless" ${REASON_ON_DESK}`, "it names the body");
  assert.deepEqual(cases.getCase(adv, body).certification, {});
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
  // The body the reason didn't cover still stands on the camera.
  const body = await cameraCase({ screen: "scratched", body: "dented" });
  await patch(body, { condition: COND("flawless", "dented"), cameraOverride: { reason: "Scratches are on the screen guard only" } });
  const r = await certify(body, { row: "body", value: "like_new" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, `Camera confirmed the body "Dents on the frame" — "Flawless" ${REASON_ON_DESK}`);
});
