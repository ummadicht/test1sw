import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readAppVersion,
  versionAtLeast,
  scanFirstApp,
  readPhase,
  planForApp,
  identityForJoin,
  imeiAgreement,
  scanFirstMessage,
  scanFirstLock,
  phoneMayPost,
  nextBatteryHealth,
  type ScanFirstState,
} from "./phoneLed.ts";
import {
  DEFAULT_PLAN,
  BATTERY_HEALTH_ID,
  BATTERY_HEALTH_METHOD,
  batteryHealthResult,
  summarise,
  matchModel,
  readDeclared,
  type DeviceReport,
  type TestResults,
  type TradeModelRef,
} from "./diagnostics.ts";
import { gradeiqFunctionalMap } from "./gradeiqMap.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const MODELS: TradeModelRef[] = [
  { id: "galaxy-s22", brand: "Samsung", model: "Galaxy S22", variants: ["128GB", "256GB"], modelCodes: ["SM-S901E"] },
  { id: "galaxy-a54", brand: "Samsung", model: "Galaxy A54", variants: ["128GB", "256GB"], modelCodes: ["SM-A546E"] },
];
const NATIVE_060: DeviceReport = {
  brand: "samsung",
  manufacturer: "samsung",
  modelName: "SM-S901E",
  modelCode: null,
  osVersion: "14",
  totalDiskBytes: 128e9,
  totalMemoryBytes: 8e9,
  batteryLevelPct: 77,
  isPhysicalDevice: true,
  appVersion: "0.6.0",
};
const AT = "2026-10-17T10:00:00.000Z";
const IMEI_A = "490154203237518";
const IMEI_B = "356938035643809";
const IMEI_C = "352099001761481";

/** Every planned test passed, then overrides. */
function allPass(over: TestResults = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome: "pass", detail: null, at: AT };
  return { ...r, ...over };
}

/* ─────────────────────────── which app ─────────────────────────── */

test("app version: native and browser builds, 0.6.0 and up lead with the scan", () => {
  assert.deepEqual(readAppVersion("0.6.0"), { web: false, version: [0, 6, 0] });
  assert.deepEqual(readAppVersion("web-0.6.2"), { web: true, version: [0, 6, 2] });
  assert.equal(readAppVersion("soon"), null);
  assert.equal(readAppVersion(null), null);
  assert.ok(versionAtLeast([0, 6, 0], [0, 6, 0]));
  assert.ok(versionAtLeast([1, 0, 0], [0, 6, 0]));
  assert.ok(!versionAtLeast([0, 5, 9], [0, 6, 0]));
  for (const v of ["0.6.0", "0.6.0-beta.1", "0.7.3", "1.0.0", "web-0.6.0", "WEB-0.6.1"]) assert.equal(scanFirstApp({ appVersion: v }), true, v);
  for (const v of ["0.5.1", "0.3.0", "web-0.5.1", "web-", "", null]) assert.equal(scanFirstApp({ appVersion: v }), false, String(v));
  assert.equal(scanFirstApp(null), false, "no device report yet → today's behaviour");
});

test("phase: the five steps, nothing else", () => {
  assert.equal(readPhase("scan"), "scan");
  assert.equal(readPhase(" Battery "), "battery");
  for (const bad of ["pairing", "auto", "", null, 3, undefined]) assert.equal(readPhase(bad), null, String(bad));
});

/* ─────────────────────────── the plan ─────────────────────────── */

test("plan: battery_health only for the apps that have the step", () => {
  assert.ok(DEFAULT_PLAN.some((p) => p.id === BATTERY_HEALTH_ID && !p.critical), "in the default plan, not critical");
  const old = planForApp(DEFAULT_PLAN, false);
  assert.equal(old.length, 18, "an older app sees exactly the 18 tests it always had");
  assert.ok(!old.some((p) => p.id === BATTERY_HEALTH_ID));
  assert.deepEqual(planForApp(DEFAULT_PLAN, true), [...DEFAULT_PLAN]);
  // A session made before the step existed, joined by a new app: it goes in after `battery`.
  const ids = planForApp(old, true).map((p) => p.id);
  assert.equal(ids[ids.indexOf("battery") + 1], BATTERY_HEALTH_ID);
  assert.deepEqual(planForApp(planForApp(old, true), true), planForApp(old, true), "idempotent");
  assert.deepEqual(planForApp([{ id: "touch", name: "Touchscreen", critical: true }], true).map((p) => p.id), ["touch", BATTERY_HEALTH_ID], "no battery test → at the end");
});

/* ─────────────────────────── identity ─────────────────────────── */

test("identity at join: the model match in the phone's terms, never a price", () => {
  const id = identityForJoin(matchModel(NATIVE_060, MODELS));
  assert.deepEqual(Object.keys(id).sort(), ["label", "match", "modelId", "reason", "variant"]);
  assert.equal(id.label, "Samsung Galaxy S22");
  assert.equal(id.match, "exact");
  assert.equal(id.variant, "128GB");
  assert.equal(id.modelId, "galaxy-s22");
  const none = identityForJoin(matchModel({ ...NATIVE_060, modelName: "Pixel 7", manufacturer: "Google", brand: "google" }, MODELS));
  assert.equal(none.match, "none");
  assert.equal(none.label, null);
  assert.equal(none.modelId, null);
  assert.match(none.reason, /choose the model by hand/i);
  assert.ok(!/₹|price|quote|amount/i.test(JSON.stringify(id)), "nothing priced");
});

test("IMEI agreement: either order, no shared number = differs, nothing to compare = unknown", () => {
  const onCase = { imei: IMEI_A, imei2: null };
  assert.equal(imeiAgreement({ imei: IMEI_A }, onCase), "match");
  assert.equal(imeiAgreement({ imei: IMEI_B, imei2: IMEI_A }, onCase), "match", "IMEI 1 and 2 swap between screens");
  assert.equal(imeiAgreement({ imei: IMEI_B, imei2: IMEI_A }, { imei: IMEI_A, imei2: IMEI_B }), "match");
  assert.equal(imeiAgreement({ imei: IMEI_C }, onCase), "differs");
  assert.equal(imeiAgreement({ imei: IMEI_C, imei2: IMEI_B }, onCase), "differs");
  assert.equal(imeiAgreement({ imei: null }, onCase), "unknown");
  assert.equal(imeiAgreement(null, onCase), "unknown");
  assert.equal(imeiAgreement({ imei: IMEI_A }, { imei: null, imei2: null }), "unknown");
});

/* ─────────────────────────── the declaration ─────────────────────────── */

test("declare: an older app's body is stored exactly as before", () => {
  assert.deepEqual(readDeclared({ screenCracked: true, backCracked: false, liquid: null, imei: IMEI_A }), {
    ok: true,
    declared: { screenCracked: true, backCracked: false, liquid: null, imei: IMEI_A },
  });
});

test("declare: the Identify step — second IMEI, the answer, a pick, a counter customer's name and number", () => {
  const r = readDeclared({
    imei: IMEI_A,
    imei2: "3569 3803 5643 809",
    identityConfirmed: false,
    picked: { modelId: "galaxy-a54", variant: "128GB" },
    customerName: "  Meera   Iyer ",
    customerPhone: "+91 98200 12345",
  });
  assert.ok(r.ok);
  assert.deepEqual(r.declared, {
    screenCracked: null,
    backCracked: null,
    liquid: null,
    imei: IMEI_A,
    imei2: IMEI_B,
    identityConfirmed: false,
    picked: { modelId: "galaxy-a54", variant: "128GB" },
    customerName: "Meera Iyer",
    customerPhone: "9820012345",
  });
  const cleared = readDeclared({ imei2: "", identityConfirmed: null, picked: null, customerName: "", customerPhone: "" });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.declared, { screenCracked: null, backCracked: null, liquid: null, imei: null, imei2: null, identityConfirmed: null, picked: null, customerName: null, customerPhone: null });
});

test("declare: what it refuses, in words the customer can act on", () => {
  const same = readDeclared({ imei: IMEI_A, imei2: IMEI_A });
  assert.ok(!same.ok && /two different numbers/.test(same.reason));
  const bad2 = readDeclared({ imei2: "123" });
  assert.ok(!bad2.ok && /IMEI 2/.test(bad2.reason));
  const yes = readDeclared({ identityConfirmed: "yes" });
  assert.ok(!yes.ok && /your phone/.test(yes.reason));
  for (const picked of [{ modelId: "" }, { modelId: "a b" }, "galaxy-a54", { modelId: "galaxy-a54", variant: 128 }]) {
    const p = readDeclared({ picked });
    assert.ok(!p.ok && /from the list/.test(p.reason), JSON.stringify(picked));
  }
  const phone = readDeclared({ customerPhone: "12345" });
  assert.ok(!phone.ok && /10-digit/.test(phone.reason));
  const name = readDeclared({ customerName: { first: "x" } });
  assert.ok(!name.ok);
});

test("summary: a 0.6.0 app's IMEI-only declaration is 'not asked', not three unanswered questions", () => {
  const d = readDeclared({ imei: IMEI_A, imei2: null, identityConfirmed: true });
  assert.ok(d.ok);
  const native = summarise(DEFAULT_PLAN, allPass(), d.declared, NATIVE_060, MODELS, { declaredExpected: false });
  assert.equal(native.notes.filter((n) => /did not say/.test(n)).length, 0);
  assert.ok(native.notes.some((n) => /doesn't ask the customer about damage/.test(n)));
  // The browser build still asks: an unanswered question is still said so.
  const web = summarise(DEFAULT_PLAN, allPass(), d.declared, { ...NATIVE_060, appVersion: "web-0.6.0" }, MODELS, { declaredExpected: true });
  assert.equal(web.notes.filter((n) => /did not say/.test(n)).length, 3);
});

/* ─────────────────────────── battery health ─────────────────────────── */

test("battery health: 80 % and up passes, below fails, unreadable is untested", () => {
  assert.deepEqual(batteryHealthResult(87, AT), { outcome: "pass", detail: { healthPct: 87, method: BATTERY_HEALTH_METHOD }, at: AT });
  assert.equal(batteryHealthResult(80, AT).outcome, "pass");
  assert.equal(batteryHealthResult(79.6, AT).outcome, "pass", "rounded first: 79.6 reads as 80");
  assert.deepEqual(batteryHealthResult(72, AT).detail, { healthPct: 72, method: BATTERY_HEALTH_METHOD });
  assert.equal(batteryHealthResult(72, AT).outcome, "fail");
  for (const pct of [null, undefined, 0, -5, 101, Number.NaN]) {
    const r = batteryHealthResult(pct as number | null, AT);
    assert.equal(r.outcome, "skip", String(pct));
    assert.equal(r.detail?.healthPct, null);
  }
});

test("battery health: below 80 % is the battery_drain fault, said in the customer's numbers", () => {
  const s = summarise(DEFAULT_PLAN, allPass({ battery_health: batteryHealthResult(72, AT) }), null, NATIVE_060, MODELS, { declaredExpected: false });
  const f = s.faults.find((x) => x.id === "battery_drain");
  assert.ok(f, "battery_drain added");
  assert.equal(f!.because, "Battery health 72 % (screenshot)");
  assert.deepEqual(f!.sources, ["tested"]);
  assert.equal(s.verdict, "faults_found");
  // Unreadable: untested, never a pass — and not critical, so the verdict stands.
  const u = summarise(DEFAULT_PLAN, allPass({ battery_health: batteryHealthResult(null, AT) }), null, NATIVE_060, MODELS, { declaredExpected: false });
  assert.ok(u.untested.some((x) => x.id === BATTERY_HEALTH_ID && !x.critical));
  assert.equal(u.verdict, "all_passed");
  assert.ok(!u.faults.some((x) => x.id === "battery_drain"));
});

test("battery health: the phone may report only a skip, and never over a reading", () => {
  const none = {};
  assert.equal(phoneMayPost(BATTERY_HEALTH_ID, "pass", none), false, "the outcome is the server's, from GradeIQ's reading");
  assert.equal(phoneMayPost(BATTERY_HEALTH_ID, "fail", none), false);
  assert.equal(phoneMayPost(BATTERY_HEALTH_ID, "skip", none), true);
  assert.equal(phoneMayPost(BATTERY_HEALTH_ID, "skip", { battery_health: batteryHealthResult(72, AT) }), false, "Skip after a 72 % reading keeps the fault");
  assert.equal(phoneMayPost(BATTERY_HEALTH_ID, "skip", { battery_health: batteryHealthResult(null, AT) }), true);
  assert.equal(phoneMayPost("battery", "pass", none), true, "every other test is the phone's");
});

test("battery health: an unreadable screenshot never wipes a reading; a new reading keeps the earlier figures", () => {
  const T2 = "2026-10-17T10:05:00.000Z";
  const first = batteryHealthResult(72, AT);
  assert.deepEqual(nextBatteryHealth(undefined, first), first);
  assert.equal(nextBatteryHealth(first, batteryHealthResult(null, T2)), null, "keep the 72 %");
  const unread = batteryHealthResult(null, AT);
  assert.equal(nextBatteryHealth(unread, batteryHealthResult(null, T2))?.at, T2, "skip over skip is fine");
  const second = nextBatteryHealth(first, batteryHealthResult(91, T2))!;
  assert.equal(second.outcome, "pass");
  assert.deepEqual(second.detail, { healthPct: 91, method: BATTERY_HEALTH_METHOD, earlier: [72] });
  const third = nextBatteryHealth(second, batteryHealthResult(85, T2))!;
  assert.deepEqual(third.detail?.earlier, [72, 91]);
});

test("battery health: never forwarded to GradeIQ as a functional test (it holds the % itself)", () => {
  const m = gradeiqFunctionalMap({ battery_health: batteryHealthResult(72, AT), touch: { outcome: "pass", detail: null, at: AT } }, null);
  assert.deepEqual(m, { touch: "pass" });
  assert.deepEqual(gradeiqFunctionalMap({ battery_health: batteryHealthResult(90, AT) }, null), {});
});

/* ─────────────────────────── the store tablet's line ─────────────────────────── */

const BASE: ScanFirstState = {
  phase: "identify",
  unlocked: false,
  locked: null,
  cameraAtWork: false,
  photosDone: false,
  screenDone: false,
  gradeLine: null,
  gradeSettled: false,
};

test("tablet line: follows the phone — identifying, showing its scan code, testing while the grade is worked out", () => {
  assert.equal(scanFirstMessage(BASE), "The customer's phone is identifying itself. It shows its scan code next.");
  assert.equal(scanFirstMessage({ ...BASE, phase: null }), scanFirstMessage(BASE), "no phase yet = identifying");
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "scan", unlocked: true }),
    "The customer's phone is showing its scan code — scan it with your camera, or Take photos."
  );
  assert.match(scanFirstMessage({ ...BASE, phase: "scan", unlocked: true, cameraAtWork: true }), /store camera is photographing/);
  assert.equal(scanFirstMessage({ ...BASE, phase: "scan", locked: "Can't confirm the customer's phone is ready (x)." }), "Can't confirm the customer's phone is ready (x).");
  assert.match(scanFirstMessage({ ...BASE, phase: "scan", unlocked: true, photosDone: true }), /checks the screen next/);
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "test", unlocked: true, photosDone: true, screenDone: true, gradeLine: "Camera grade B is provisional.", gradeSettled: false }),
    "The customer's phone is testing itself — the camera grade is being worked out."
  );
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "battery", photosDone: true, screenDone: true, gradeLine: "Camera grade B (final).", gradeSettled: true }),
    "Camera grade B (final). The customer's phone is testing itself."
  );
  assert.equal(scanFirstMessage({ ...BASE, phase: "done", photosDone: true, screenDone: true, gradeLine: "Camera grade A (final).", gradeSettled: true }), "Camera grade A (final). The customer's phone has finished its tests.");
  assert.match(scanFirstMessage({ ...BASE, phase: "test" }), /camera check didn't run, so check the screen and glass by eye/);
});

test("tablet lock: why the camera is still locked for a scan-first phone", () => {
  assert.match(scanFirstLock(null, false, false), /once it has identified itself/);
  assert.match(scanFirstLock("identify", false, false), /once it has identified itself/);
  assert.match(scanFirstLock("scan", false, false), /Waiting for the customer's phone to show its scan code/);
  for (const [phase, skipped, complete] of [["scan", true, false], ["test", false, false], ["identify", false, true]] as const)
    assert.match(scanFirstLock(phase, skipped, complete), /override with your name and a reason/, `${phase} ${skipped} ${complete}`);
});
