import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readAppVersion,
  versionAtLeast,
  scanFirstApp,
  readPhase,
  planForApp,
  identityForJoin,
  storageFromTest,
  storageModelId,
  storageOnSave,
  imeiAgreement,
  scanFirstMessage,
  scanFirstLock,
  coloursApp,
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
  CERTIFY_NOTE,
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

test("plan: no battery screenshot when the case already has a battery-health % from elsewhere", () => {
  const known = planForApp(DEFAULT_PLAN, true, true);
  assert.ok(!known.some((p) => p.id === BATTERY_HEALTH_ID), "an attached Phonecheck report read it: the customer isn't asked");
  assert.equal(known.length, DEFAULT_PLAN.length - 1, "nothing else changes");
  assert.deepEqual(planForApp(DEFAULT_PLAN, true, false), [...DEFAULT_PLAN], "no other source: the step stays (and stays skippable on the phone)");
  assert.deepEqual(planForApp(planForApp(DEFAULT_PLAN, false), true, true), planForApp(DEFAULT_PLAN, false), "never put back when it is known");
});

/* ─────────────────────────── identity ─────────────────────────── */

test("identity at join: the model match in the phone's terms, never a price", () => {
  const id = identityForJoin(matchModel(NATIVE_060, MODELS));
  assert.deepEqual(Object.keys(id).sort(), ["label", "match", "modelId", "reason", "variant", "variants"]);
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

test("identity at join: the matched model's storage sizes, so the phone can ask when it couldn't measure", () => {
  const unmeasured = matchModel({ ...NATIVE_060, totalDiskBytes: null }, MODELS);
  const id = identityForJoin(unmeasured, ["128GB", "256GB"]);
  assert.equal(id.modelId, "galaxy-s22");
  assert.equal(id.variant, null);
  assert.deepEqual(id.variants, ["128GB", "256GB"]);
  assert.deepEqual(identityForJoin(matchModel(NATIVE_060, MODELS)).variants, [], "no list given → empty, never invented");
  const none = identityForJoin(matchModel({ ...NATIVE_060, modelName: "Pixel 7", manufacturer: "Google", brand: "google" }, MODELS), ["128GB"]);
  assert.deepEqual(none.variants, [], "no model matched → no sizes");
});

test("identity at join: a phone that measured its storage is never asked — not even for a size that isn't on file", () => {
  // 1TB on a model listed as 128/256GB: the matcher drops the size, but the phone DID measure it.
  const oneTb = { ...NATIVE_060, totalDiskBytes: 1000204886016 };
  const m = matchModel(oneTb, MODELS);
  assert.equal(m.variant, null);
  const id = identityForJoin(m, ["128GB", "256GB"], "1TB");
  assert.equal(id.variant, null);
  assert.deepEqual(id.variants, [], "offering 128/256GB would offer only sizes the phone has ruled out");
  assert.match(id.reason, /1TB/, "the matcher's own words say what it read");
  // Measured and on the list: the size is there already; nothing to ask either.
  assert.deepEqual(identityForJoin(matchModel(NATIVE_060, MODELS), ["128GB", "256GB"], "128GB").variants, []);
});

/* ─────────────────────────── storage at Apply ─────────────────────────── */

const S22 = { modelId: "galaxy-s22", variant: null as string | null };
const SIZES = ["128GB", "256GB"];
const NONE = { variant: null, source: null, flag: null };

test("storage at Apply: the phone's measurement always wins — a different claim is flagged, not used", () => {
  const r = storageFromTest({ match: { ...S22, variant: "128GB" }, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: "256GB" });
  assert.deepEqual(r, {
    variant: "128GB",
    source: "measured",
    flag: "Storage: customer said 256GB, phone measures 128GB — measurement used.",
  });
  assert.equal(storageFromTest({ match: { ...S22, variant: "128GB" }, picked: { modelId: "galaxy-s22", variant: "128GB" }, variants: SIZES, caseModelId: null, caseVariant: null }).flag, null, "the same size: nothing to flag");
  assert.equal(storageFromTest({ match: { ...S22, variant: "128GB" }, picked: { modelId: "galaxy-a54", variant: "256GB" }, variants: SIZES, caseModelId: null, caseVariant: null }).flag, null, "another model's size is the identity flag's business");
});

test("storage at Apply: a size the case already has is never overwritten by a claim", () => {
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: "128GB" }), NONE);
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: ["256GB"], caseModelId: "galaxy-s22", caseVariant: "128GB" }), NONE, "not even the one catalogue size");
});

test("storage at Apply: a model sold in one size needs no question", () => {
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: ["256GB"], caseModelId: null, caseVariant: null }), { variant: "256GB", source: "catalogue", flag: null });
  // The case's size was for ANOTHER model: the match replaces the model, and its one size fills in.
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: ["256GB"], caseModelId: "galaxy-a54", caseVariant: "128GB" }).source, "catalogue");
});

test("storage at Apply: the customer's pick of the same model fills it — as a claim, with its flag", () => {
  const flag = "Storage: customer said 256GB, not measured — check Settings › About phone.";
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: null, caseVariant: null }), { variant: "256GB", source: "customer", flag });
  // No model code matched: the pick names the model too, when the case has none or the same one.
  const unmatched = { modelId: null, variant: null };
  assert.deepEqual(storageFromTest({ match: unmatched, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: null, caseVariant: null }).source, "customer");
  assert.deepEqual(storageFromTest({ match: unmatched, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: null }).source, "customer");
  assert.equal(storageModelId({ match: unmatched, picked: { modelId: "galaxy-s22" }, caseModelId: "galaxy-s22" }), "galaxy-s22");
  assert.equal(storageModelId({ match: { modelId: "galaxy-a54" }, picked: { modelId: "galaxy-s22" }, caseModelId: null }), "galaxy-a54", "the phone's match names the model");
});

test("storage at Apply: another model's pick, or a size not on the list, fills nothing", () => {
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-a54", variant: "128GB" }, variants: SIZES, caseModelId: null, caseVariant: null }), NONE);
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: "1TB" }, variants: SIZES, caseModelId: null, caseVariant: null }), NONE);
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: null }, variants: SIZES, caseModelId: null, caseVariant: null }), NONE);
  // No match, and the pick would replace the case's own model: not this path's to change.
  assert.equal(storageModelId({ match: { modelId: null }, picked: { modelId: "galaxy-s22" }, caseModelId: "galaxy-a54" }), null);
  assert.deepEqual(storageFromTest({ match: { modelId: null, variant: null }, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: "galaxy-a54", caseVariant: null }), NONE);
});

test("storage at Apply: nothing measured, nothing picked → nothing (the answer screen asks)", () => {
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: null, caseVariant: null }), NONE);
  assert.deepEqual(storageFromTest({ match: { modelId: null, variant: null }, picked: null, variants: [], caseModelId: null, caseVariant: null }), NONE);
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: null, caseVariant: null, measured: null }), NONE);
});

test("storage at Apply: a measured size that isn't on file is never replaced by a pick, a single size or a guess", () => {
  const flag = "Storage: phone measures 1TB, not on file — no trade-in price for that size.";
  // The matcher dropped the size (variant null); the reading still travels with the phone.
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: null, caseVariant: null, measured: "1TB" }), { variant: null, source: null, flag });
  // The customer tapped 256GB on the confirm card (an older app still asks): not used — the phone measured otherwise.
  assert.deepEqual(storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: null, caseVariant: null, measured: "1TB" }), {
    variant: null,
    source: null,
    flag: "Storage: phone measures 1TB, not on file (customer said 256GB — not used) — no trade-in price for that size.",
  });
  // A model sold in one size, but the phone measured another: the catalogue's size is not this phone's.
  assert.deepEqual(storageFromTest({ match: S22, picked: null, variants: ["128GB"], caseModelId: null, caseVariant: null, measured: "256GB" }).variant, null);
  // A size already on the case stays (nothing is patched), and the advisor is still told.
  const kept = storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: "256GB", measured: "1TB" });
  assert.equal(kept.variant, null);
  assert.equal(kept.flag, flag);
});

test("storage at Apply, re-test: a reading takes a size the customer TYPED off the case; staff's size stays", () => {
  // First test in the browser: the customer typed 256GB. A native re-test measures 1TB (not on file).
  const typed = storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: "256GB", measured: "1TB", caseSource: "customer" });
  assert.equal(typed.variant, null);
  assert.equal(typed.clear, true, "the claim comes off — it must not be priced as if true");
  assert.match(typed.flag ?? "", /customer's earlier 256GB removed/);
  // The same reading against a size STAFF saved: kept, flagged, never cleared.
  const staff = storageFromTest({ match: S22, picked: null, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: "256GB", measured: "1TB", caseSource: "advisor" });
  assert.equal(staff.clear, undefined);
  assert.equal(staff.variant, null);
  // Reverse order: the first test measured 1TB; a browser re-test (no reading of its own) picks 512GB.
  // Apply passes the case's earlier reading in as `measured`, so the pick is not used.
  const again = storageFromTest({ match: S22, picked: { modelId: "galaxy-s22", variant: "128GB" }, variants: SIZES, caseModelId: "galaxy-s22", caseVariant: null, measured: "1TB", caseSource: null });
  assert.equal(again.variant, null);
  assert.equal(again.source, null);
  assert.match(again.flag ?? "", /customer said 128GB — not used/);
});

test("storage at Apply: the disk reading counts however the model was named — a pick never beats it", () => {
  // No model code matched; the customer picked the S22. The disk read 256GB: that is measured, not claimed.
  const unmatched = { modelId: null, variant: null };
  assert.deepEqual(storageFromTest({ match: unmatched, picked: { modelId: "galaxy-s22", variant: "256GB" }, variants: SIZES, caseModelId: null, caseVariant: null, measured: "256GB" }), {
    variant: "256GB",
    source: "measured",
    flag: null,
  });
  // They picked 128GB, the disk read 256GB: the reading is used and the claim flagged.
  assert.deepEqual(storageFromTest({ match: unmatched, picked: { modelId: "galaxy-s22", variant: "128GB" }, variants: SIZES, caseModelId: null, caseVariant: null, measured: "256GB" }), {
    variant: "256GB",
    source: "measured",
    flag: "Storage: customer said 128GB, phone measures 256GB — measurement used.",
  });
  // The reading given explicitly agrees with the match's own: one answer.
  assert.equal(storageFromTest({ match: { ...S22, variant: "128GB" }, picked: null, variants: SIZES, caseModelId: null, caseVariant: null, measured: "128GB" }).source, "measured");
});

test("storage at Apply: the join told the phone the case's own model (its code named nothing, nobody picked) — that model's storage is settled", () => {
  const unmatched = { modelId: null, variant: null };
  const joined = { match: unmatched, picked: null, caseModelId: "galaxy-s22", caseModelJoined: true };
  assert.equal(storageModelId(joined), "galaxy-s22");
  assert.deepEqual(storageFromTest({ ...joined, variants: SIZES, caseVariant: null, measured: "256GB" }), { variant: "256GB", source: "measured", flag: null });
  // A reading beats a size already on the case, as for any match; a size not on file is said.
  assert.equal(storageFromTest({ ...joined, variants: SIZES, caseVariant: "128GB", caseSource: "advisor", measured: "256GB" }).variant, "256GB");
  assert.match(storageFromTest({ ...joined, variants: SIZES, caseVariant: null, measured: "1TB" }).flag ?? "", /phone measures 1TB, not on file/);
  // Nothing measured: the rules after the reading (the case's size stays; one size; nothing).
  assert.deepEqual(storageFromTest({ ...joined, variants: SIZES, caseVariant: "128GB" }), NONE);
  assert.deepEqual(storageFromTest({ ...joined, variants: ["256GB"], caseVariant: null }), { variant: "256GB", source: "catalogue", flag: null });
  // Not the join's model (the 0.8.0 rule): no phone match and no pick settles nothing.
  assert.equal(storageModelId({ ...joined, caseModelJoined: false }), null);
  assert.equal(storageModelId({ match: unmatched, picked: null, caseModelId: "galaxy-s22" }), null);
  // The phone's own match, or the customer's pick, still decide first.
  assert.equal(storageModelId({ ...joined, match: { modelId: "galaxy-a54" } }), "galaxy-a54");
  assert.equal(storageModelId({ ...joined, picked: { modelId: "galaxy-a54" } }), null, "a pick of another model is not the join's model");
});

/* ─────────────────────────── storage on a save ─────────────────────────── */

test("storage on a save: re-saving the size already there keeps where it came from (a claim stays a claim)", () => {
  // The pressed chip tapped again on the desk: still the customer's typed size — the lock still asks for the Settings tick.
  assert.deepEqual(storageOnSave({ next: "512GB", prev: "512GB", prevSource: "customer", modelChanged: false }), { source: "customer", changed: false });
  assert.deepEqual(storageOnSave({ next: "256GB", prev: "256GB", prevSource: "measured", modelChanged: false }), { source: "measured", changed: false });
  // An older case with no recorded source: the size is staff's.
  assert.deepEqual(storageOnSave({ next: "256GB", prev: "256GB", prevSource: null, modelChanged: false }), { source: "advisor", changed: false });
});

test("storage on a save: a different size from staff is the advisor's; Apply's word wins, even on the same size", () => {
  assert.deepEqual(storageOnSave({ next: "256GB", prev: "512GB", prevSource: "customer", modelChanged: false }), { source: "advisor", changed: true });
  assert.deepEqual(storageOnSave({ next: "256GB", prev: null, prevSource: null, modelChanged: false }), { source: "advisor", changed: true });
  // A measurement upgrades the customer's claim of the same size; nothing about the size changed.
  assert.deepEqual(storageOnSave({ next: "512GB", prev: "512GB", prevSource: "customer", from: "measured", modelChanged: false }), { source: "measured", changed: false });
  assert.deepEqual(storageOnSave({ next: "128GB", prev: null, prevSource: null, from: "catalogue", modelChanged: false }), { source: "catalogue", changed: true });
  // The same words for another model are a new size.
  assert.deepEqual(storageOnSave({ next: "256GB", prev: "256GB", prevSource: "customer", modelChanged: true }), { source: "advisor", changed: true });
  // Clearing it: no size, no source.
  assert.deepEqual(storageOnSave({ next: null, prev: "256GB", prevSource: "customer", modelChanged: false }), { source: null, changed: true });
  assert.deepEqual(storageOnSave({ next: null, prev: null, prevSource: null, modelChanged: false }), { source: null, changed: false });
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
  assert.ok(!same.ok && /can't be the same/.test(same.reason));
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

test("summary: the customer is never asked about damage — one note says the advisor certifies it, native or browser", () => {
  const d = readDeclared({ imei: IMEI_A, imei2: null, identityConfirmed: true });
  assert.ok(d.ok);
  for (const device of [NATIVE_060, { ...NATIVE_060, appVersion: "web-0.6.0" }]) {
    const s = summarise(DEFAULT_PLAN, allPass(), d.declared, device, MODELS);
    assert.equal(s.notes.filter((n) => /did not say|damage questions/.test(n)).length, 0);
    assert.equal(s.notes.filter((n) => n === CERTIFY_NOTE).length, 1);
  }
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
  const s = summarise(DEFAULT_PLAN, allPass({ battery_health: batteryHealthResult(72, AT) }), null, NATIVE_060, MODELS);
  const f = s.faults.find((x) => x.id === "battery_drain");
  assert.ok(f, "battery_drain added");
  assert.equal(f!.because, "Battery health 72 % (screenshot)");
  assert.deepEqual(f!.sources, ["tested"]);
  assert.equal(s.verdict, "faults_found");
  // Unreadable: untested, never a pass — and not critical, so the verdict stands.
  const u = summarise(DEFAULT_PLAN, allPass({ battery_health: batteryHealthResult(null, AT) }), null, NATIVE_060, MODELS);
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
  // A second, better screenshot never replaces the sub-80 % reading: the lower one stands.
  const second = nextBatteryHealth(first, batteryHealthResult(91, T2))!;
  assert.equal(second.outcome, "fail");
  assert.deepEqual(second.detail, { healthPct: 72, method: BATTERY_HEALTH_METHOD, earlier: [91] });
  const third = nextBatteryHealth(second, batteryHealthResult(85, T2))!;
  assert.equal(third.outcome, "fail");
  assert.deepEqual(third.detail?.earlier, [91, 85]);
  // A lower reading does replace a higher one.
  const lower = nextBatteryHealth(batteryHealthResult(91, AT), batteryHealthResult(74, T2))!;
  assert.equal(lower.outcome, "fail");
  assert.deepEqual(lower.detail, { healthPct: 74, method: BATTERY_HEALTH_METHOD, earlier: [91] });
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
  assert.equal(scanFirstMessage(BASE), "Phone identifying itself — scan code next.");
  assert.equal(scanFirstMessage({ ...BASE, phase: null }), scanFirstMessage(BASE), "no phase yet = identifying");
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "scan", unlocked: true }),
    "Scan the phone's code, or Take photos."
  );
  assert.match(scanFirstMessage({ ...BASE, phase: "scan", unlocked: true, cameraAtWork: true }), /Camera at work/);
  assert.equal(scanFirstMessage({ ...BASE, phase: "scan", locked: "Can't confirm the customer's phone is ready (x)." }), "Can't confirm the customer's phone is ready (x).");
  assert.match(scanFirstMessage({ ...BASE, phase: "scan", unlocked: true, photosDone: true }), /screen check next/);
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "test", unlocked: true, photosDone: true, screenDone: true, gradeLine: "Camera grade B is provisional.", gradeSettled: false }),
    "Phone testing — grade coming."
  );
  assert.equal(
    scanFirstMessage({ ...BASE, phase: "battery", photosDone: true, screenDone: true, gradeLine: "Camera grade B (final).", gradeSettled: true }),
    "Camera grade B (final). Phone testing."
  );
  assert.equal(scanFirstMessage({ ...BASE, phase: "done", photosDone: true, screenDone: true, gradeLine: "Camera grade A (final).", gradeSettled: true }), "Camera grade A (final). Tests done.");
  assert.match(scanFirstMessage({ ...BASE, phase: "test" }), /no camera check; certify it or Take photos/);
  // The phone is showing the test colours for the advisor (≥ 0.8.0).
  assert.match(scanFirstMessage({ ...BASE, phase: "colours" }), /showing test colours — tap what you see/);
  assert.match(scanFirstMessage({ ...BASE, phase: "colours", photosDone: true, screenDone: true, gradeLine: "Camera grade A (final).", gradeSettled: true }), /showing test colours/);
});

test("colours: SwapUp Check 0.8.0 and later (native or browser) shows the test colours; older apps can't", () => {
  assert.equal(readPhase("colours"), "colours");
  assert.equal(coloursApp({ appVersion: "0.8.0" }), true);
  assert.equal(coloursApp({ appVersion: "web-0.8.1" }), true);
  assert.equal(coloursApp({ appVersion: "1.0.0" }), true);
  for (const v of ["0.7.9", "web-0.7.0", "0.6.0", "", null, undefined]) assert.equal(coloursApp({ appVersion: v as string | null }), false, String(v));
  assert.equal(coloursApp(null), false);
});

test("tablet lock: why the camera is still locked for a scan-first phone", () => {
  assert.match(scanFirstLock(null, false, false), /when the phone shows its scan code/);
  assert.match(scanFirstLock("identify", false, false), /when the phone shows its scan code/);
  assert.match(scanFirstLock("scan", false, false), /Waiting for the phone's scan code/);
  for (const [phase, skipped, complete] of [["scan", true, false], ["test", false, false], ["identify", false, true]] as const)
    assert.match(scanFirstLock(phase, skipped, complete), /photos need an override/, `${phase} ${skipped} ${complete}`);
});
