import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PLAN,
  summarise,
  matchModel,
  storageVariant,
  normaliseModelCode,
  codeFamily,
  cameraSide,
  progressOf,
  readResults,
  mergeResults,
  readDeclared,
  readDevice,
  normaliseCode,
  mergeCondition,
  unionFaults,
  wifiQr,
  wifiEscape,
  readWifi,
  CODE_ALPHABET,
  type DeviceReport,
  type TradeModelRef,
  type TestResults,
  type Declared,
  type PlanItem,
} from "./diagnostics.ts";
import { conditionFromFaults, conditionFloor, type ConditionAnswers } from "./condition.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const MODELS: TradeModelRef[] = [
  { id: "galaxy-s22", brand: "Samsung", model: "Galaxy S22", variants: ["128GB", "256GB"], modelCodes: ["SM-S901E"] },
  { id: "galaxy-s22-ultra", brand: "Samsung", model: "Galaxy S22 Ultra", variants: ["256GB", "512GB"], modelCodes: ["SM-S908E"] },
  { id: "galaxy-a14", brand: "Samsung", model: "Galaxy A14", variants: ["64GB", "128GB"], modelCodes: ["SM-A145F"] },
  { id: "galaxy-a14-5g", brand: "Samsung", model: "Galaxy A14 5G", variants: ["64GB", "128GB"], modelCodes: ["SM-A146B"] },
  { id: "pixel-7", brand: "Google", model: "Pixel 7", variants: ["128GB", "256GB"], modelCodes: [] },
];

const DEVICE: DeviceReport = {
  brand: "samsung",
  manufacturer: "samsung",
  modelName: "SM-S901E",
  modelCode: null,
  osVersion: "14",
  totalDiskBytes: 128e9,
  totalMemoryBytes: 8e9,
  batteryLevelPct: 77,
  isPhysicalDevice: true,
  appVersion: "0.1.0",
};

const AT = "2026-10-15T10:00:00.000Z";
const NO_DAMAGE: Declared = { screenCracked: false, backCracked: false, liquid: false, imei: null };

/** Every planned test with the same outcome, then overrides. */
function all(outcome: "pass" | "fail" | "skip" | "unsupported", over: TestResults = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome, detail: null, at: AT };
  return { ...r, ...over };
}
const fail = (detail: Record<string, unknown> | null = null) => ({ outcome: "fail" as const, detail, at: AT });
const skip = { outcome: "skip" as const, detail: null, at: AT };
const unsupported = { outcome: "unsupported" as const, detail: null, at: AT };
const faultIds = (s: ReturnType<typeof summarise>) => s.faults.map((f) => f.id);

/* ─────────────────────────── storage ─────────────────────────── */

test("storage: the smallest standard size at least 85% of what the phone reports", () => {
  assert.equal(storageVariant(128e9), "128GB");
  assert.equal(storageVariant(110e9), "128GB"); // a 128 GB phone after the system's share
  assert.equal(storageVariant(137.4e9), "128GB"); // 128 GiB reported in binary units
  assert.equal(storageVariant(238e9), "256GB");
  assert.equal(storageVariant(476e9), "512GB");
  assert.equal(storageVariant(52e9), "64GB");
  assert.equal(storageVariant(25e9), "32GB"); // an old phone is never rounded UP into a 64 GB price
  assert.equal(storageVariant(0.95e12), "1TB");
  assert.equal(storageVariant(1e12), "1TB");
});

test("storage: nothing reported, nonsense or bigger than any phone → null, never a guess", () => {
  assert.equal(storageVariant(null), null);
  assert.equal(storageVariant(undefined), null);
  assert.equal(storageVariant(0), null);
  assert.equal(storageVariant(-5), null);
  assert.equal(storageVariant(Number.NaN), null);
  assert.equal(storageVariant(Number.POSITIVE_INFINITY), null);
  assert.equal(storageVariant(4e12), null);
});

/* ─────────────────────────── model codes ─────────────────────────── */

test("model code: normalised, region suffixes kept, marketing names refused", () => {
  assert.equal(normaliseModelCode("SM-S901E"), "SM-S901E");
  assert.equal(normaliseModelCode(" sm-s901e/ds "), "SM-S901E");
  assert.equal(normaliseModelCode("SM-F9460"), "SM-F9460");
  assert.equal(normaliseModelCode("Galaxy S22"), null);
  assert.equal(normaliseModelCode("Pixel 7"), null);
  assert.equal(normaliseModelCode("SM-"), null);
  assert.equal(normaliseModelCode(""), null);
  assert.equal(normaliseModelCode(null), null);
  assert.equal(codeFamily("SM-S901E"), "SM-S901");
  assert.equal(codeFamily("SM-S901B"), codeFamily("SM-S901E"));
  assert.notEqual(codeFamily("SM-A145F"), codeFamily("SM-A146B"));
});

test("model: exact code match, storage from the reported bytes", () => {
  const m = matchModel(DEVICE, MODELS);
  assert.equal(m.match, "exact");
  assert.equal(m.modelId, "galaxy-s22");
  assert.equal(m.label, "Samsung Galaxy S22");
  assert.equal(m.variant, "128GB");
  assert.match(m.why, /SM-S901E/);
  assert.match(m.why, /128GB/);
});

test("model: a regional code of the same family matches as family", () => {
  const m = matchModel({ ...DEVICE, modelName: "SM-S901B", totalDiskBytes: 238e9 }, MODELS);
  assert.equal(m.match, "family");
  assert.equal(m.modelId, "galaxy-s22");
  assert.equal(m.variant, "256GB");
  assert.match(m.why, /same model family/);
});

test("model: expo's modelId / an explicit modelCode is used when modelName is not a code", () => {
  const m = matchModel({ ...DEVICE, modelName: "Galaxy S22", modelCode: "SM-S901E" }, MODELS);
  assert.equal(m.match, "exact");
  assert.equal(readDevice({ modelName: "Galaxy S22", modelId: "SM-S901E" }).modelCode, "SM-S901E");
});

test("model: exact beats family across the two codes the phone reports", () => {
  const extra: TradeModelRef[] = [...MODELS, { id: "galaxy-s22-b", brand: "Samsung", model: "Galaxy S22 (B)", variants: ["128GB"], modelCodes: ["SM-S901B"] }];
  // Two models in the SM-S901 family; the phone's exact code decides.
  const m = matchModel({ ...DEVICE, modelName: "SM-S901B" }, extra);
  assert.equal(m.match, "exact");
  assert.equal(m.modelId, "galaxy-s22-b");
});

test("model: no code, unknown code, or an ambiguous family → none, never a guess", () => {
  const pixel = matchModel({ ...DEVICE, brand: "google", manufacturer: "Google", modelName: "Pixel 7" }, MODELS);
  assert.equal(pixel.match, "none");
  assert.equal(pixel.modelId, null);
  assert.equal(pixel.variant, null);
  assert.match(pixel.why, /not a Samsung model code/);

  const unknown = matchModel({ ...DEVICE, modelName: "SM-Z999X" }, MODELS);
  assert.equal(unknown.match, "none");
  assert.match(unknown.why, /not in SwapUp's model list/);

  const twins: TradeModelRef[] = [
    { id: "a", brand: "Samsung", model: "Phone A", variants: ["128GB"], modelCodes: ["SM-A555F"] },
    { id: "b", brand: "Samsung", model: "Phone B", variants: ["128GB"], modelCodes: ["SM-A555B"] },
  ];
  const amb = matchModel({ ...DEVICE, modelName: "SM-A555E" }, twins);
  assert.equal(amb.match, "none");
  assert.match(amb.why, /more than one model/);

  const silent = matchModel({ ...DEVICE, brand: null, manufacturer: null, modelName: null }, MODELS);
  assert.equal(silent.match, "none");
  assert.match(silent.why, /did not report its model/);

  assert.equal(matchModel(null, MODELS).match, "none");
  assert.equal(matchModel(DEVICE, []).match, "none");
});

test("model: storage that is not a variant on file, or not reported, is left for the advisor", () => {
  const big = matchModel({ ...DEVICE, totalDiskBytes: 476e9 }, MODELS); // a 512 GB S22 is not on file
  assert.equal(big.modelId, "galaxy-s22");
  assert.equal(big.variant, null);
  assert.match(big.why, /not a storage option/);
  const none = matchModel({ ...DEVICE, totalDiskBytes: null }, MODELS);
  assert.equal(none.modelId, "galaxy-s22");
  assert.equal(none.variant, null);
  assert.match(none.why, /did not report its storage/);
});

test("model: the shipped seed data carries a code for every Samsung model, and the S22 matches", () => {
  const seed = JSON.parse(readFileSync(new URL("../server/seed-data.json", import.meta.url), "utf8")) as {
    tradeModels: { id: string; brand: string; model: string; variants: string[]; modelCodes: string[] }[];
  };
  const samsung = seed.tradeModels.filter((m) => m.brand === "Samsung");
  assert.ok(samsung.length > 50);
  for (const m of samsung) assert.ok(m.modelCodes.length > 0, `${m.id} has no model code`);
  for (const m of seed.tradeModels.filter((x) => x.brand !== "Samsung")) assert.deepEqual(m.modelCodes, [], `${m.id} should not claim a Samsung code`);
  // No two models share a family — a family match is never ambiguous on the shipped list.
  const fam = new Map<string, string>();
  for (const m of samsung)
    for (const c of m.modelCodes) {
      const f = codeFamily(c);
      assert.ok(!fam.has(f) || fam.get(f) === m.id, `${f} is claimed by ${fam.get(f)} and ${m.id}`);
      fam.set(f, m.id);
    }
  const refs: TradeModelRef[] = seed.tradeModels;
  const s22 = matchModel(DEVICE, refs);
  assert.deepEqual([s22.modelId, s22.variant, s22.match], ["galaxy-s22", "128GB", "exact"]);
  const s22b = matchModel({ ...DEVICE, modelName: "SM-S901B" }, refs);
  assert.deepEqual([s22b.modelId, s22b.match], ["galaxy-s22", "family"]);
});

/* ─────────────────────────── the mapping table ─────────────────────────── */

test("summary: every failed test maps to the contract's SwapUp fault", () => {
  const cases: [string, string][] = [
    ["touch", "touch_issue"],
    ["multitouch", "touch_issue"],
    ["display", "display_lines"],
    ["mic", "mic"],
    ["speaker", "speaker"],
    ["voice", "speaker"],
    ["buttons", "buttons"],
    ["charging", "charging_issue"],
    ["battery", "battery_drain"],
  ];
  for (const [testId, fault] of cases) {
    const s = summarise(DEFAULT_PLAN, all("pass", { [testId]: fail() }), NO_DAMAGE, DEVICE, MODELS);
    assert.deepEqual(faultIds(s), [fault], `${testId} → ${fault}`);
    assert.equal(s.verdict, "faults_found");
    assert.match(s.faults[0].because, /failed/);
  }
});

test("summary: the camera fault follows detail.side", () => {
  const side = (detail: Record<string, unknown> | null) => faultIds(summarise(DEFAULT_PLAN, all("pass", { camera: fail(detail) }), NO_DAMAGE, DEVICE, MODELS));
  assert.deepEqual(side({ side: "rear" }), ["rear_camera"]);
  assert.deepEqual(side({ side: "back" }), ["rear_camera"]);
  assert.deepEqual(side({ side: "front" }), ["front_camera"]);
  assert.deepEqual(side({ side: "both" }), ["rear_camera", "front_camera"]);
  // Not said which → no fault invented, a note asks the advisor to check both.
  const s = summarise(DEFAULT_PLAN, all("pass", { camera: fail(null) }), NO_DAMAGE, DEVICE, MODELS);
  assert.deepEqual(faultIds(s), []);
  assert.equal(s.verdict, "faults_found");
  assert.ok(s.notes.some((n) => /did not say which camera/.test(n)));
  assert.equal(cameraSide({ side: " Rear " }), "rear");
  assert.equal(cameraSide({ side: 3 }), null);
  assert.equal(cameraSide(undefined), null);
});

test("summary: note-only tests never become faults, and say which condition box applies", () => {
  for (const id of ["flash", "faceid", "vibration", "sensors", "motion", "connectivity", "bluetooth", "nfc"]) {
    const s = summarise(DEFAULT_PLAN, all("pass", { [id]: fail() }), NO_DAMAGE, DEVICE, MODELS);
    assert.deepEqual(faultIds(s), [], `${id} must be a note only`);
    assert.equal(s.notes.length, 1, `${id} gives one note`);
    assert.equal(s.verdict, "faults_found", "a failed test is never 'all passed'");
  }
  const bt = summarise(DEFAULT_PLAN, all("pass", { bluetooth: fail() }), NO_DAMAGE, DEVICE, MODELS);
  assert.match(bt.notes[0], /Wi-Fi \/ Bluetooth faulty/);
});

test("summary: what the customer declares becomes the matching fault", () => {
  const s = summarise(DEFAULT_PLAN, all("pass"), { screenCracked: true, backCracked: true, liquid: true, imei: null }, DEVICE, MODELS);
  assert.deepEqual(faultIds(s), ["screen_cracked", "back_cracked", "water_damage"]);
  assert.ok(s.faults.every((f) => /customer says/.test(f.because)));
  assert.equal(s.verdict, "faults_found");
});

test("summary: unanswered damage questions are notes, not passes and not faults", () => {
  const none = summarise(DEFAULT_PLAN, all("pass"), null, DEVICE, MODELS);
  assert.deepEqual(faultIds(none), []);
  assert.ok(none.notes.some((n) => /has not answered the damage questions/.test(n)));
  const partly = summarise(DEFAULT_PLAN, all("pass"), { screenCracked: false, backCracked: null, liquid: null, imei: null }, DEVICE, MODELS);
  assert.equal(partly.notes.filter((n) => /did not say/.test(n)).length, 2);
});

test("summary: everything passed and nothing declared → all_passed, nothing untested", () => {
  const s = summarise(DEFAULT_PLAN, all("pass"), NO_DAMAGE, DEVICE, MODELS);
  assert.equal(s.verdict, "all_passed");
  assert.deepEqual(s.faults, []);
  assert.deepEqual(s.untested, []);
  assert.deepEqual(s.notes, []);
  assert.equal(s.model.modelId, "galaxy-s22");
});

test("summary: skipped and unsupported are UNTESTED, never passed", () => {
  const s = summarise(DEFAULT_PLAN, all("pass", { touch: skip, nfc: unsupported }), NO_DAMAGE, DEVICE, MODELS);
  assert.deepEqual(
    s.untested.map((u) => [u.id, u.critical]),
    [
      ["touch", true],
      ["nfc", false],
    ]
  );
  assert.equal(s.verdict, "incomplete", "a skipped critical test makes the whole check incomplete");
});

test("summary: a critical test untested → incomplete, even when faults were found", () => {
  const s = summarise(DEFAULT_PLAN, all("pass", { touch: fail(), charging: unsupported }), NO_DAMAGE, DEVICE, MODELS);
  assert.deepEqual(faultIds(s), ["touch_issue"]);
  assert.equal(s.verdict, "incomplete");
});

test("summary: only non-critical tests untested → the verdict stands, the gaps are listed", () => {
  const s = summarise(DEFAULT_PLAN, all("pass", { nfc: unsupported, bluetooth: skip }), NO_DAMAGE, DEVICE, MODELS);
  assert.equal(s.verdict, "all_passed");
  assert.deepEqual(s.untested.map((u) => u.id), ["bluetooth", "nfc"].sort((a, b) => DEFAULT_PLAN.findIndex((p) => p.id === a) - DEFAULT_PLAN.findIndex((p) => p.id === b)));
});

test("summary: tests never run are untested; nothing run at all → incomplete with every test listed", () => {
  const s = summarise(DEFAULT_PLAN, {}, null, null, MODELS);
  assert.equal(s.verdict, "incomplete");
  assert.equal(s.untested.length, DEFAULT_PLAN.length);
  assert.equal(s.model.match, "none");
});

test("summary: the counter scenario — failed touch + failed rear camera on an S22 128 GB", () => {
  const s = summarise(DEFAULT_PLAN, all("pass", { touch: fail({ untouched: 3 }), camera: fail({ side: "rear" }) }), NO_DAMAGE, DEVICE, MODELS);
  assert.deepEqual(faultIds(s), ["touch_issue", "rear_camera"]);
  assert.deepEqual([s.model.modelId, s.model.variant, s.model.match], ["galaxy-s22", "128GB", "exact"]);
  assert.equal(s.verdict, "faults_found");
  assert.deepEqual(s.untested, []);
});

test("summary: one fault from two tests is listed once with both reasons; order follows the fault list", () => {
  const s = summarise(DEFAULT_PLAN, all("pass", { touch: fail(), multitouch: fail(), mic: fail(), display: fail() }), { ...NO_DAMAGE, screenCracked: true }, DEVICE, MODELS);
  assert.deepEqual(faultIds(s), ["screen_cracked", "display_lines", "touch_issue", "mic"]);
  const touch = s.faults.find((f) => f.id === "touch_issue")!;
  assert.match(touch.because, /Touchscreen/);
  assert.match(touch.because, /Multi-touch/);
});

test("summary: an emulator run is called out", () => {
  const s = summarise(DEFAULT_PLAN, all("pass"), NO_DAMAGE, { ...DEVICE, isPhysicalDevice: false }, MODELS);
  assert.ok(s.notes.some((n) => /emulator/.test(n)));
});

test("summary: a custom plan decides what is critical", () => {
  const plan: PlanItem[] = [
    { id: "touch", name: "Touchscreen", critical: false },
    { id: "nfc", name: "NFC", critical: true },
  ];
  assert.equal(summarise(plan, { touch: skip, nfc: { outcome: "pass", detail: null, at: AT } }, NO_DAMAGE, DEVICE, MODELS).verdict, "all_passed");
  assert.equal(summarise(plan, { touch: { outcome: "pass", detail: null, at: AT }, nfc: skip }, NO_DAMAGE, DEVICE, MODELS).verdict, "incomplete");
});

test("progress: any result counts as done (a skip moved the customer on), out of the plan", () => {
  assert.deepEqual(progressOf(DEFAULT_PLAN, {}), { done: 0, total: DEFAULT_PLAN.length });
  assert.deepEqual(progressOf(DEFAULT_PLAN, { touch: skip, mic: fail() }), { done: 2, total: DEFAULT_PLAN.length });
  assert.deepEqual(progressOf(DEFAULT_PLAN, all("pass")), { done: DEFAULT_PLAN.length, total: DEFAULT_PLAN.length });
});

/* ─────────────────────────── what the phone sends ─────────────────────────── */

test("results: bad items are ignored without blocking the good ones", () => {
  const now = "2026-10-15T12:00:00.000Z";
  const r = readResults(
    [
      { testId: "touch", outcome: "fail", detail: { untouched: 2 }, at: "2026-10-15T11:00:00+05:30" },
      { testId: "mic", outcome: "pass" }, // no at → now
      { testId: "warp_drive", outcome: "pass", at: now },
      { testId: "speaker", outcome: "passed", at: now },
      { outcome: "pass" },
      null,
      "nonsense",
      { testId: "camera", outcome: "fail", detail: ["rear"], at: "not a date" },
      { testId: "display", outcome: "pass", detail: { blob: "x".repeat(5000) }, at: now },
    ],
    DEFAULT_PLAN,
    now
  );
  assert.deepEqual(
    r.items.map((i) => [i.testId, i.outcome, i.at]),
    [
      ["touch", "fail", "2026-10-15T05:30:00.000Z"],
      ["mic", "pass", now],
      ["camera", "fail", now],
      ["display", "pass", now],
    ]
  );
  assert.deepEqual(r.items[0].detail, { untouched: 2 });
  assert.equal(r.items[2].detail, null, "an array is not a detail object");
  assert.deepEqual(r.items[3].detail, { truncated: true });
  assert.deepEqual(r.ignored, ["warp_drive", "speaker", "(no testId)", "(no testId)", "(no testId)"]);
  assert.deepEqual(readResults("not a list", DEFAULT_PLAN, now), { items: [], ignored: [] });
});

test("results: idempotent per test — the latest `at` wins, an older retry never overwrites", () => {
  const t1 = "2026-10-15T10:00:00.000Z";
  const t2 = "2026-10-15T10:05:00.000Z";
  let r = mergeResults({}, [{ testId: "touch", outcome: "fail", detail: null, at: t1 }]);
  r = mergeResults(r, [{ testId: "touch", outcome: "pass", detail: null, at: t2 }]);
  assert.equal(r.touch.outcome, "pass");
  r = mergeResults(r, [{ testId: "touch", outcome: "fail", detail: null, at: t1 }]); // a late retry of the first run
  assert.equal(r.touch.outcome, "pass");
  r = mergeResults(r, [{ testId: "touch", outcome: "skip", detail: null, at: t2 }]); // same `at` → the newer delivery
  assert.equal(r.touch.outcome, "skip");
  const same = mergeResults(r, [{ testId: "touch", outcome: "skip", detail: null, at: t2 }]);
  assert.deepEqual(same, r, "re-sending the same batch changes nothing");
});

test("declared: yes / no / not answered, and the IMEI from *#06#", () => {
  assert.deepEqual(readDeclared({ screenCracked: true, backCracked: false }), {
    ok: true,
    declared: { screenCracked: true, backCracked: false, liquid: null, imei: null },
  });
  const withImei = readDeclared({ screenCracked: false, backCracked: false, liquid: false, imei: "49015420323751" });
  assert.ok(withImei.ok && withImei.declared.imei === "490154203237518", "14 digits are completed with the check digit");
  const spaced = readDeclared({ imei: "4901 5420 3237 518" });
  assert.ok(spaced.ok && spaced.declared.imei === "490154203237518");
  const bad = readDeclared({ imei: "12345" });
  assert.ok(!bad.ok && /\*#06#/.test(bad.reason));
  const notBool = readDeclared({ screenCracked: "yes" });
  assert.ok(!notBool.ok && /yes or no/.test(notBool.reason));
  assert.deepEqual(readDeclared({ imei: "" }), { ok: true, declared: { screenCracked: null, backCracked: null, liquid: null, imei: null } });
});

test("device: only what the phone said, cleaned; nothing invented", () => {
  const d = readDevice(
    { brand: " samsung ", manufacturer: "samsung", modelName: "SM-S901E", totalDiskBytes: 128e9, totalMemoryBytes: -1, batteryLevelPct: 140.6, isPhysicalDevice: "yes", extra: "dropped" },
    "0.1.0"
  );
  assert.equal(d.brand, "samsung");
  assert.equal(d.modelName, "SM-S901E");
  assert.equal(d.modelCode, null);
  assert.equal(d.totalDiskBytes, 128e9);
  assert.equal(d.totalMemoryBytes, null);
  assert.equal(d.batteryLevelPct, 100);
  assert.equal(d.isPhysicalDevice, null);
  assert.equal(d.appVersion, "0.1.0");
  assert.ok(!("extra" in d));
  const empty = readDevice(null);
  assert.ok(Object.values(empty).every((v) => v === null));
});

test("join codes: 6 characters from the unambiguous alphabet; typing is forgiven", () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const c of "ILO01") assert.ok(!CODE_ALPHABET.includes(c), `${c} is too easy to misread`);
  assert.equal(normaliseCode("k7m2qx"), "K7M2QX");
  assert.equal(normaliseCode(" K7M-2QX "), "K7M2QX");
  assert.equal(normaliseCode("K7M2Q"), null);
  assert.equal(normaliseCode("K7M2QX9"), null);
  assert.equal(normaliseCode("K7M2Q0"), null, "zero is not in the alphabet");
  assert.equal(normaliseCode(123456), null);
});

/* ─────────────────────────── applying to the case ─────────────────────────── */

const ACC = { accessories: { charger: true, box: true, bill: false }, age: "3to11m" as const };

test("apply: the merged condition is never better than what the advisor recorded", () => {
  const prev: ConditionAnswers = { powersOn: true, calls: true, screen: "scratched", body: "dented", issues: ["speaker"], ...ACC };
  const m = mergeCondition(prev, ["touch_issue", "rear_camera"]);
  assert.equal(m.screen, "scratched", "the advisor's scratches survive");
  assert.equal(m.body, "dented", "the advisor's dent survives");
  assert.deepEqual(m.issues, ["rear_camera", "speaker", "touch"]);
  assert.deepEqual(m.accessories, ACC.accessories);
  assert.equal(m.age, "3to11m");
  assert.deepEqual(conditionFloor(m, ["touch_issue", "rear_camera"]), [], "and never better than the faults allow");

  const worse = mergeCondition(prev, ["screen_cracked", "back_cracked"]);
  assert.equal(worse.screen, "cracked");
  assert.equal(worse.body, "back_cracked");
});

test("apply: with no condition yet, the faults decide it (charger assumed, age over 11 months)", () => {
  const m = mergeCondition(null, ["touch_issue"]);
  assert.deepEqual(m, conditionFromFaults(["touch_issue"], { accessories: { charger: true, box: false, bill: false }, age: "gt11m" }));
});

test("apply: faults are a union — nothing the advisor recorded is dropped", () => {
  assert.deepEqual(unionFaults(["battery_drain", "touch_issue"], ["touch_issue", "rear_camera"]), ["battery_drain", "touch_issue", "rear_camera"]);
  assert.deepEqual(unionFaults([], []), []);
});

/* ─────────────────────────── store Wi-Fi ─────────────────────────── */

test("wifi: the QR payload escapes \\ ; , : \" and omits the password on an open network", () => {
  assert.equal(wifiEscape('a\\b;c,d:e"f'), 'a\\\\b\\;c\\,d\\:e\\"f');
  assert.equal(wifiQr({ ssid: "Samsung Care", password: "pass;word", security: "WPA", hidden: false }), "WIFI:T:WPA;S:Samsung Care;P:pass\\;word;H:false;;");
  assert.equal(wifiQr({ ssid: "Guest", password: "ignored", security: "nopass", hidden: true }), "WIFI:T:nopass;S:Guest;H:true;;");
});

test("wifi: the manager's form is checked with reasons they can fix", () => {
  assert.deepEqual(readWifi({ ssid: "" }), { ok: true, wifi: null });
  assert.deepEqual(readWifi({}), { ok: true, wifi: null });
  assert.deepEqual(readWifi({ ssid: " Store ", password: "12345678", security: "WPA" }), {
    ok: true,
    wifi: { ssid: "Store", password: "12345678", security: "WPA", hidden: false },
  });
  assert.deepEqual(readWifi({ ssid: "Open", security: "nopass", password: "x", hidden: true }), {
    ok: true,
    wifi: { ssid: "Open", password: "", security: "nopass", hidden: true },
  });
  const short = readWifi({ ssid: "Store", password: "1234", security: "WPA" });
  assert.ok(!short.ok && /8 to 63/.test(short.reason));
  const long = readWifi({ ssid: "x".repeat(33), password: "12345678" });
  assert.ok(!long.ok && /32/.test(long.reason));
  const sec = readWifi({ ssid: "Store", password: "12345678", security: "WPA9" });
  assert.ok(!sec.ok && /security/.test(sec.reason));
  const wep = readWifi({ ssid: "Old", password: "abc", security: "WEP" });
  assert.ok(!wep.ok && /WEP/.test(wep.reason));
  assert.ok(readWifi({ ssid: "Old", password: "abcde", security: "WEP" }).ok);
});
