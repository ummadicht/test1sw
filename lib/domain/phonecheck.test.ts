import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readPhonecheck,
  unwrapPhonecheck,
  isNoData,
  phonecheckUpsert,
  pcResults,
  evidenceFromPhonecheck,
  pcFacts,
  pcDeviceReport,
  readNames,
  readOffset,
  testedAtOf,
  readBatteryPct,
  pcVariant,
  checkPcUpload,
  pcExtractRequest,
  readPcExtraction,
  PC_EXTRACT_SCHEMA,
  PC_UPLOAD_MAX_BYTES,
  PC_TEST_NAMES,
  PC_CAMERA_NAMES,
  PC_STATUS_ITEMS,
  PC_BATTERY_METHOD,
  type PcRecord,
} from "./phonecheck.ts";
import { matchModel, BATTERY_HEALTH_METHOD, batteryHealthResult, type TradeModelRef } from "./diagnostics.ts";
import { grade, type GradingInput } from "./grading.ts";
import { DEFAULT_PLAN } from "./diagnostics.ts";
import { HEALTHY } from "./condition.ts";
import { luhnCheckDigit } from "./imei.ts";
import { addFaultSources, reconcileFaultSources } from "./gradeiqMap.ts";

/* ─────────────────────────── fixtures: synthetic, Luhn-valid IMEIs only ─────────────────────────── */

const luhn = (body14: string) => body14 + luhnCheckDigit(body14);
const IMEI = luhn("35000000000001");
const IMEI2 = luhn("35000000000019");
const RECEIVED = "2026-10-17T12:00:00.000Z";

/** Shaped like the records DeNovo pulled from GetDeviceInfo (field names as observed). */
function samsung(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IMEI,
    IMEI2,
    Serial: "R5CW000TEST",
    Make: "Samsung",
    Model: "Galaxy S23 Ultra",
    ModelNo: "SM-S918B",
    Memory: "256GB",
    Color: "Phantom Black",
    Carrier: "Unlocked",
    Grade: "B",
    Working: "Yes",
    Passed: "Digitizer N Pattern,LCD,Microphone,Loud Speaker,Front Camera,Rear Camera,Battery Drain,Bluetooth",
    Failed: "",
    Pending: "",
    BatteryHealthPercentage: "92",
    BatteryCycle: "311",
    OEMBatteryHealth: "0",
    DeviceLock: "Off",
    MDM: "Off",
    Knox: "Off",
    Rooted: "Off",
    Erased: "Yes",
    Type: "Secure Erase (NIST-800-88)",
    Parts: JSON.stringify({ Remarks: "Genuine", Data: [{ Status: "Genuine", name: "Battery" }] }),
    StationID: "Station-D04",
    TesterName: "Tester One",
    DeviceUpdatedDate: "2026-10-17 13:51:00",
    UpdatedTimeStamp: "2026-10-17T13:51:00.00+04:00",
    A4Reports: "123456789",
    A4ReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/A4-certificate/0123456789abcdef0123456789abcdef",
    erasureReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/erasure-report/0123456789abcdef0123456789abcdef",
    dhr_link: "https://historyreport.phonecheck.com/report-qr/0123456789abcdef",
    ...over,
  };
}

function read(raw: Record<string, unknown>, tz: string | null = null): PcRecord {
  const r = readPhonecheck(raw, { tz });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.record;
}

/* ─────────────────────────── P1–P14 (spec §3.10) ─────────────────────────── */

test("P1: a DeNovo-shaped Samsung record — every field mapped, test time in UTC", () => {
  const r = read(samsung());
  assert.deepEqual(r, {
    reportId: "123456789",
    key: "a4:123456789",
    imei: IMEI,
    imeiCheckDigit: "valid",
    imei2: IMEI2,
    imei2CheckDigit: "valid",
    serial: "R5CW000TEST",
    make: "Samsung",
    model: "Galaxy S23 Ultra",
    modelNo: "SM-S918B",
    colour: "Phantom Black",
    carrier: "Unlocked",
    variant: "256GB",
    testedAt: "2026-10-17T09:51:00.000Z",
    testedAtWhy: null,
    deviceUpdatedDate: "2026-10-17 13:51:00",
    working: "yes",
    passed: ["Digitizer N Pattern", "LCD", "Microphone", "Loud Speaker", "Front Camera", "Rear Camera", "Battery Drain", "Bluetooth"].map((name) => ({ name, manual: false })),
    failed: [],
    pending: [],
    batteryHealthPct: 92,
    batteryCycles: 311,
    testerGrade: "B",
    deviceLock: "off",
    rooted: "off",
    knox: "off",
    mdm: "off",
    erased: true,
    erasureType: "Secure Erase (NIST-800-88)",
    parts: "genuine",
    station: "Station-D04",
    tester: "Tester One",
    links: {
      a4: "https://cloudportal.phonecheck.com/cloud/reporting/A4-certificate/0123456789abcdef0123456789abcdef",
      erasure: "https://cloudportal.phonecheck.com/cloud/reporting/erasure-report/0123456789abcdef0123456789abcdef",
      dhr: "https://historyreport.phonecheck.com/report-qr/0123456789abcdef",
    },
    aiRead: false,
  });
  const { results } = pcResults(r, r.testedAt!);
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.outcome])),
    { touch: "pass", display: "pass", mic: "pass", speaker: "pass", battery: "pass", bluetooth: "pass", camera: "pass", battery_health: "pass" }
  );
  assert.deepEqual(results.battery_health, { outcome: "pass", detail: { healthPct: 92, method: PC_BATTERY_METHOD }, at: "2026-10-17T09:51:00.000Z" });
  assert.equal(results.charging, undefined, "Phonecheck didn't report the charging port");
});

test("P2: 'M-Microphone' passed → mic pass, entered by hand", () => {
  const r = read(samsung({ Passed: "M-Microphone" }));
  assert.deepEqual(r.passed, [{ name: "Microphone", manual: true }]);
  const mic = pcResults(r, RECEIVED).results.mic;
  assert.equal(mic.outcome, "pass");
  assert.equal(mic.detail!.manual, true);
  assert.deepEqual(mic.detail!.names, ["Microphone"]);
});

test("P3: 'Device Lock' failed with DeviceLock On → the lock is on; no test failed", () => {
  const r = read(samsung({ Passed: "", Failed: "Device Lock", DeviceLock: "On", MDM: "Off" }));
  assert.equal(r.deviceLock, "on");
  assert.equal(r.mdm, "off", "MDM is not the activation lock (DeNovo defect 3)");
  const out = pcResults(r, RECEIVED);
  assert.ok(Object.values(out.results).every((x) => x.outcome !== "fail"));
  assert.deepEqual(out.other, []);
  assert.deepEqual(pcFacts(r), { parts: "genuine", deviceLock: "on" });
  for (const s of PC_STATUS_ITEMS) {
    const o = pcResults(read(samsung({ Passed: "", Failed: s })), RECEIVED);
    assert.deepEqual(Object.keys(o.results), ["battery_health"], `${s}: no test result`);
    assert.deepEqual([o.other, o.cosmeticFails], [[], []], `${s}: not another test, not cosmetic`);
  }
});

test("P4: an 8-digit 'IMEI' (a Wi-Fi-only serial) is refused; so is no IMEI at all", () => {
  const r = readPhonecheck(samsung({ IMEI: "DMPX12345678" }));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /8 digits, not 15/);
  assert.equal(readPhonecheck(samsung({ IMEI: "" })).ok, false);
  assert.equal(readPhonecheck(samsung({ IMEI: luhn("35000000000001").slice(0, 14) })).ok, false, "14 digits are not completed here — exactly 15");
  assert.equal(readPhonecheck("nope").ok, false);
  // A bad check digit is kept, and said.
  const bad = read(samsung({ IMEI: IMEI.slice(0, 14) + String((Number(IMEI[14]) + 1) % 10) }));
  assert.equal(bad.imeiCheckDigit, "invalid");
  // A short IMEI2 is dropped, not a reason to refuse the record.
  assert.equal(read(samsung({ IMEI2: "1234" })).imei2, null);
});

test("P5: only the zone-less DeviceUpdatedDate and no PHONECHECK_TZ → no test time, with a why", () => {
  const r = read(samsung({ UpdatedTimeStamp: undefined }));
  assert.equal(r.testedAt, null);
  assert.match(r.testedAtWhy!, /has no time zone/);
  assert.equal(r.key, "a4:123456789");
  // With the tz set, it is read at that zone — never the server's own.
  assert.equal(read(samsung({ UpdatedTimeStamp: undefined }), "+04:00").testedAt, "2026-10-17T09:51:00.000Z");
  assert.equal(read(samsung({ UpdatedTimeStamp: undefined }), "+05:30").testedAt, "2026-10-17T08:21:00.000Z");
  // No report number either: the key falls back to the IMEI and the raw time.
  assert.equal(read(samsung({ UpdatedTimeStamp: undefined, A4Reports: "" })).key, `imei:${IMEI}:2026-10-17 13:51:00`);
  assert.equal(read(samsung({ A4Reports: "" })).key, `imei:${IMEI}:2026-10-17T09:51:00.000Z`);
});

test("P6: the same A4 report again — newer replaces, older or a replay is stale", () => {
  const first = read(samsung());
  const older = read(samsung({ UpdatedTimeStamp: "2026-10-17T12:00:00.00+04:00" }));
  const newer = read(samsung({ UpdatedTimeStamp: "2026-10-17T15:00:00.00+04:00" }));
  assert.equal(older.key, first.key);
  assert.equal(phonecheckUpsert(null, first), "insert");
  assert.equal(phonecheckUpsert(first, older), "stale");
  assert.equal(phonecheckUpsert(first, first), "stale", "a webhook replay");
  assert.equal(phonecheckUpsert(first, newer), "replace");
  assert.equal(phonecheckUpsert(first, { testedAt: null }), "stale", "nothing to prove it newer");
  assert.equal(phonecheckUpsert({ testedAt: null }, newer), "replace");
});

test("P7: wrappers — bare, array, {deviceInfo}, {devices}, {data} — each parses", () => {
  const rec = samsung();
  const bodies: unknown[] = [rec, [rec], { deviceInfo: rec }, { devices: [rec] }, { data: [rec] }, { result: rec }, { master: [rec] }];
  for (const b of bodies) {
    const rows = unwrapPhonecheck(b);
    assert.equal(rows.length, 1, JSON.stringify(Object.keys(b as object)));
    assert.equal(read(rows[0] as Record<string, unknown>).imei, IMEI);
  }
  assert.deepEqual(unwrapPhonecheck(null), []);
  const withData = { ...rec, Data: { note: "a field of the record" } };
  assert.deepEqual(unwrapPhonecheck(withData), [withData], "a record is never mistaken for a wrapper");
  assert.equal(unwrapPhonecheck(Array.from({ length: 150 }, () => rec)).length, 100, "at most 100");
  assert.equal(isNoData(404, null), true);
  assert.equal(isNoData(200, { status: 0, msg: "No Data Found" }), true);
  assert.equal(isNoData(200, [rec]), false);
});

test("P8: only rear camera names passed → camera untested ('front not tested')", () => {
  const r = read(samsung({ Passed: "Rear Camera,UltraWide Camera,Telephoto Camera Quality" }));
  const cam = pcResults(r, RECEIVED).results.camera;
  assert.equal(cam.outcome, "skip");
  assert.equal(cam.detail!.reason, "front not tested");
  assert.equal(cam.detail!.pending, undefined, "not pending — never tested");
  // A front pass with the rear pending is pending.
  const p = pcResults(read(samsung({ Passed: "Front Camera", Pending: "Rear Camera" })), RECEIVED).results.camera;
  assert.equal(p.outcome, "skip");
  assert.equal(p.detail!.pending, true);
  assert.equal(p.detail!.reason, "rear pending on Phonecheck");
  // A fail names its side.
  assert.equal(pcResults(read(samsung({ Failed: "Telephoto Camera" })), RECEIVED).results.camera.detail!.side, "rear");
  assert.equal(pcResults(read(samsung({ Failed: "Front Video Camera,Rear Camera" })), RECEIVED).results.camera.detail!.side, "both");
});

test("P9: an unknown name 'Foo Test' failed → other, verbatim", () => {
  const out = pcResults(read(samsung({ Passed: "", Failed: "Foo Test" })), RECEIVED);
  assert.deepEqual(out.other, [{ name: "Foo Test", result: "failed", manual: false }]);
  assert.ok(Object.values(out.results).every((x) => x.outcome !== "fail"));
  // Worst wins across lists.
  assert.deepEqual(pcResults(read(samsung({ Passed: "Foo Test", Pending: "Foo Test" })), RECEIVED).other, [{ name: "Foo Test", result: "pending", manual: false }]);
});

test("P10: battery '0' / '' / 'BH not supported' / '92' → null, null, null, 92", () => {
  assert.equal(read(samsung({ BatteryHealthPercentage: "0" })).batteryHealthPct, null);
  assert.equal(read(samsung({ BatteryHealthPercentage: "" })).batteryHealthPct, null);
  assert.equal(read(samsung({ BatteryHealthPercentage: "BH not supported" })).batteryHealthPct, null);
  assert.equal(read(samsung({ BatteryHealthPercentage: "92" })).batteryHealthPct, 92);
  assert.equal(readBatteryPct("100"), 100);
  assert.equal(readBatteryPct("101"), null);
  assert.equal(readBatteryPct("88%"), 88);
  // No reading → no battery_health result at all (Phonecheck didn't read it).
  assert.equal(pcResults(read(samsung({ BatteryHealthPercentage: "0" })), RECEIVED).results.battery_health, undefined);
});

test("P11: Grade 'A+' / 'NR' / none → kept verbatim, and never used by grade()", () => {
  assert.equal(read(samsung({ Grade: "A+" })).testerGrade, "A+");
  assert.equal(read(samsung({ Grade: "NR" })).testerGrade, "NR");
  assert.equal(read(samsung({ Grade: undefined })).testerGrade, null);
  const gradeOf = (g: unknown) => {
    const rec = read(samsung({ Grade: g }));
    const i: GradingInput = {
      plan: DEFAULT_PLAN,
      evidence: [evidenceFromPhonecheck(rec, "phonecheck", RECEIVED)],
      condition: { ...HEALTHY, issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m" },
      faults: [],
      camera: null,
      cameraComponents: null,
      cameraOem: null,
      physicalDevice: true,
      browserRun: false,
      phonecheckImeiOverride: null,
      pcFacts: pcFacts(rec),
    };
    return grade(i);
  };
  assert.deepEqual(gradeOf("A+"), gradeOf("C"));
  assert.deepEqual(gradeOf("NR"), gradeOf(undefined));
});

test("P12: Memory '1TB' / 'abc' / '2TB' → '1TB' / null / null", () => {
  assert.equal(read(samsung({ Memory: "1TB" })).variant, "1TB");
  assert.equal(read(samsung({ Memory: "abc" })).variant, null);
  assert.equal(read(samsung({ Memory: "2TB" })).variant, null, "not a size SwapUp prices");
  assert.equal(pcVariant("128 gb"), "128GB");
});

test("P13: 'Battery Drain' twice in one list → once", () => {
  const r = read(samsung({ Passed: "Battery Drain, Battery Drain,LCD;Battery Drain|Bluetooth\nM-LCD" }));
  assert.deepEqual(r.passed, [
    { name: "Battery Drain", manual: false },
    { name: "LCD", manual: false }, // automated and manual copies → not "entered by hand"
    { name: "Bluetooth", manual: false },
  ]);
  assert.deepEqual(readNames(["M-Face ID", "M-face id"]), [{ name: "Face ID", manual: true }]);
  assert.deepEqual(readNames(null), []);
});

test("P14: 'Glass Condition' failed → a cosmetic failure, not a test failure", () => {
  const out = pcResults(read(samsung({ Failed: "Glass Condition,Back Glass Condition", Passed: "Frame Condition" })), RECEIVED);
  assert.deepEqual(out.cosmeticFails, ["Glass Condition", "Back Glass Condition"]);
  assert.deepEqual(out.other, []);
  assert.equal(out.results.display, undefined);
});

/* ─────────────────────────── the name map ─────────────────────────── */

test("names: matched case-insensitively; a group passes only with no fail and nothing pending", () => {
  const r = (passed: string, failed = "", pending = "") => pcResults(read(samsung({ Passed: passed, Failed: failed, Pending: pending })), RECEIVED).results;
  assert.equal(r("loud speaker").speaker.outcome, "pass");
  assert.equal(r("Microphone,Front Mic Quality", "Rear Mic Quality").mic.outcome, "fail");
  const pend = r("Microphone", "", "Video Microphone").mic;
  assert.equal(pend.outcome, "skip");
  assert.equal(pend.detail!.pending, true);
  assert.equal(pend.detail!.reason, "pending on Phonecheck");
  assert.equal(r("Power Button,Camera Control Swipe").buttons.outcome, "pass");
  assert.equal(r("Charging").charging.outcome, "pass");
  assert.equal(r("Wireless Charging").charging, undefined, "Wireless Charging is not the port");
  assert.equal(r("Sim Reader Test").connectivity.outcome, "pass");
  // No name appears twice in the map.
  const all = [...Object.values(PC_TEST_NAMES).flat(), ...PC_CAMERA_NAMES.front, ...PC_CAMERA_NAMES.rear].map((n) => n.toLowerCase());
  assert.equal(new Set(all).size, all.length);
  // Every mapped id is a SwapUp plan id.
  const plan = new Set(DEFAULT_PLAN.map((p) => p.id));
  for (const id of Object.keys(PC_TEST_NAMES)) assert.ok(plan.has(id), id);
});

test("evidence: Working = No with an empty Failed list is the only 'not working, no test named'", () => {
  assert.equal(evidenceFromPhonecheck(read(samsung({ Working: "No", Failed: "" })), "phonecheck", RECEIVED).pc!.workingNo, true);
  assert.equal(evidenceFromPhonecheck(read(samsung({ Working: "No", Failed: "LCD" })), "phonecheck", RECEIVED).pc!.workingNo, false);
  assert.equal(evidenceFromPhonecheck(read(samsung({ Working: "Pending" })), "phonecheck", RECEIVED).pc!.workingNo, false);
  const e = evidenceFromPhonecheck(read(samsung({ UpdatedTimeStamp: undefined })), "phonecheck_upload", RECEIVED);
  assert.equal(e.source, "phonecheck_upload");
  assert.equal(e.at, null);
  assert.equal(e.results.mic.at, RECEIVED, "an unknown test time stamps the results with when SwapUp received it");
});

test("time: offsets are read; a bad date or offset is no time at all", () => {
  assert.equal(readOffset("+05:30"), 330);
  assert.equal(readOffset("-0400"), -240);
  assert.equal(readOffset("Z"), 0);
  assert.equal(readOffset("IST"), null);
  assert.equal(readOffset(undefined), null);
  assert.deepEqual(testedAtOf("2026-10-17T13:51:00+04:00", null, null), { at: "2026-10-17T09:51:00.000Z", why: null });
  assert.deepEqual(testedAtOf("2026-10-17 13:51:00.5Z", null, null), { at: "2026-10-17T13:51:00.500Z", why: null });
  assert.equal(testedAtOf("2026-02-30T10:00:00+04:00", null, null).at, null, "no 30 February");
  assert.match(testedAtOf(null, null, "+04:00").why!, /no test time/);
  assert.match(testedAtOf(null, "yesterday", "+04:00").why!, /could not be read/);
});

test("model: the record reads like a phone's own report — ModelNo is the SM code, storage maps back", () => {
  const MODELS: TradeModelRef[] = [{ id: "galaxy-s23-ultra", brand: "Samsung", model: "Galaxy S23 Ultra", variants: ["256GB", "512GB"], modelCodes: ["SM-S918B"] }];
  const m = matchModel(pcDeviceReport(read(samsung())), MODELS);
  assert.equal(m.modelId, "galaxy-s23-ultra");
  assert.equal(m.match, "exact");
  assert.equal(m.variant, "256GB");
  assert.equal(matchModel(pcDeviceReport(read(samsung({ Memory: "1TB" }))), MODELS).variant, null, "not a size on file");
  assert.equal(pcDeviceReport(read(samsung({ Memory: "" }))).totalDiskBytes, null);
});

test("batteryHealthResult: the method names its source; the screenshot default is unchanged", () => {
  assert.deepEqual(batteryHealthResult(76, RECEIVED, PC_BATTERY_METHOD), { outcome: "fail", detail: { healthPct: 76, method: PC_BATTERY_METHOD }, at: RECEIVED });
  assert.deepEqual(batteryHealthResult(null, RECEIVED, PC_BATTERY_METHOD).detail, { healthPct: null, method: PC_BATTERY_METHOD, reason: "no battery health reading" });
  assert.deepEqual(batteryHealthResult(null, RECEIVED).detail, { healthPct: null, method: BATTERY_HEALTH_METHOD, reason: "the screenshot could not be read" });
});

test("fault sources: 'phonecheck' sits after the phone's own test, before the customer and the camera", () => {
  const s = addFaultSources({ mic: ["advisor"], screen_cracked: ["camera_ai"] }, [
    { id: "mic", source: "phonecheck" },
    { id: "mic", source: "tested" },
    { id: "screen_cracked", source: "phonecheck" },
    { id: "screen_cracked", source: "declared" },
    { id: "mic", source: "phonecheck" },
  ]);
  assert.deepEqual(s, { mic: ["tested", "phonecheck", "advisor"], screen_cracked: ["phonecheck", "declared", "camera_ai"] });
  assert.deepEqual(reconcileFaultSources(s, ["mic"]), { mic: ["tested", "phonecheck", "advisor"] });
});

test("links: only https links are kept", () => {
  const r = read(samsung({ A4ReportLink: "javascript:alert(1)", dhr_link: "http://historyreport.phonecheck.com/x" }));
  assert.deepEqual(r.links, { a4: null, erasure: r.links.erasure, dhr: null });
  assert.equal(read(samsung({ Parts: "not json" })).parts, null);
  assert.equal(read(samsung({ Parts: JSON.stringify({ Remarks: "Not Genuine" }) })).parts, "not_genuine");
  assert.equal(read(samsung({ Parts: JSON.stringify({ Remarks: "Unknown" }) })).parts, "unknown");
  assert.equal(read(samsung({ DeviceLock: "NA" })).deviceLock, null);
});

/* ─────────────────────────── an uploaded report read by AI (owner, 2026-10-17) ─────────────────────────── */

const bytesOf = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const PDF = bytesOf("%PDF-1.7\n", 0, 0);
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const PNG = bytesOf(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = bytesOf("RIFF", 0, 0, 0, 0, "WEBPVP8 ");

test("upload: PDF / JPEG / PNG / WebP only, by content; size capped", () => {
  assert.deepEqual(checkPcUpload("application/pdf", PDF), { ok: true, mime: "application/pdf" });
  assert.deepEqual(checkPcUpload("image/jpeg", JPEG), { ok: true, mime: "image/jpeg" });
  assert.deepEqual(checkPcUpload("image/jpg", JPEG), { ok: true, mime: "image/jpeg" });
  assert.deepEqual(checkPcUpload("image/png", PNG), { ok: true, mime: "image/png" });
  assert.deepEqual(checkPcUpload(null, WEBP), { ok: true, mime: "image/webp" });
  assert.equal(checkPcUpload("image/gif", bytesOf("GIF89a")).ok, false);
  assert.equal(checkPcUpload("image/png", PDF).ok, false, "the declared type must match the content");
  assert.equal(checkPcUpload("application/pdf", new Uint8Array(0)).ok, false);
  const big = new Uint8Array(PC_UPLOAD_MAX_BYTES + 1);
  big.set(PDF);
  const r = checkPcUpload("application/pdf", big);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /limit is 8 MB/);
});

test("upload: the Gemini request carries the strict schema, the file inline, and no key", () => {
  const body = pcExtractRequest("application/pdf", "JVBERi0=") as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema, PC_EXTRACT_SCHEMA);
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: "application/pdf", data: "JVBERi0=" } });
  assert.match(String(body.contents[0].parts[0].text), /Never guess/);
  assert.ok(!/key/i.test(JSON.stringify(body.generationConfig)));
  for (const [k, v] of Object.entries(PC_EXTRACT_SCHEMA.properties)) {
    const f = v as { nullable?: boolean; enum?: string[]; format?: string };
    assert.equal(f.nullable, true, `${k} may be null`);
    if (f.enum) assert.equal(f.format, "enum", `${k}: Gemini's documented enum form`);
  }
});

const gemini = (out: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }] });

test("upload: the AI's reading → the same record shape the parser takes; unreadable stays null", () => {
  const ex = readPcExtraction(
    gemini({
      IMEI,
      IMEI2: null,
      Make: "Samsung",
      Model: "Galaxy S23 Ultra",
      ModelNo: "SM-S918B",
      Memory: "256GB",
      Color: "N/A",
      Carrier: "unknown",
      Grade: "B",
      Working: "yes",
      Passed: ["Microphone", "M-LCD", "", "N/A"],
      Failed: ["Glass Condition"],
      Pending: null,
      BatteryHealthPercentage: 0,
      BatteryCycle: 311,
      DeviceLock: "On",
      Rooted: "maybe",
      Erased: "No",
      PartsRemarks: "Not Genuine",
      A4Reports: "123456789",
      UpdatedTimeStamp: "2026-10-17T13:51:00+04:00",
      A4ReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/A4-certificate/abc",
      Invented: "x",
    })
  );
  assert.ok(ex.ok);
  assert.deepEqual(ex.raw, {
    IMEI,
    Make: "Samsung",
    Model: "Galaxy S23 Ultra",
    ModelNo: "SM-S918B",
    Memory: "256GB",
    Grade: "B",
    A4Reports: "123456789",
    UpdatedTimeStamp: "2026-10-17T13:51:00+04:00",
    Working: "Yes",
    DeviceLock: "On",
    Erased: "No",
    Passed: ["Microphone", "M-LCD"],
    Failed: ["Glass Condition"],
    BatteryCycle: "311",
    Parts: JSON.stringify({ Remarks: "Not Genuine" }),
  });
  const r = readPhonecheck(ex.raw, { aiRead: true });
  assert.ok(r.ok);
  assert.equal(r.record.aiRead, true);
  assert.equal(r.record.batteryHealthPct, null, "0 is not a reading");
  assert.equal(r.record.colour, null);
  assert.equal(r.record.rooted, null);
  assert.equal(r.record.parts, "not_genuine");
  assert.deepEqual(r.record.links, { a4: null, erasure: null, dhr: null }, "links are never taken from an AI read");
  const e = evidenceFromPhonecheck(r.record, "phonecheck_upload", RECEIVED);
  assert.equal(e.pc!.aiRead, true);
  assert.deepEqual(e.pc!.cosmeticFails, ["Glass Condition"]);
  assert.equal(e.results.display.detail!.manual, true);
});

test("upload: an AI reply with nothing usable is a reason, never a record", () => {
  assert.equal(readPcExtraction({}).ok, false);
  assert.match((readPcExtraction({ candidates: [{ finishReason: "SAFETY" }] }) as { reason: string }).reason, /SAFETY/);
  assert.equal(readPcExtraction({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }).ok, false);
  assert.equal(readPcExtraction(gemini([1, 2])).ok, false);
  // No legible IMEI → the parser refuses it, as for any record.
  const ex = readPcExtraction(gemini({ IMEI: null, Passed: ["Microphone"] }));
  assert.ok(ex.ok);
  assert.equal(readPhonecheck(ex.raw, { aiRead: true }).ok, false);
});
