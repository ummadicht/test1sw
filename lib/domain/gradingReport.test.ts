import { test } from "node:test";
import { namesBrand } from "./testing/brand.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildReportBody, canonicalJson, scrubText, REPORT_SCHEMA, REPORT_SCALE, FAULT_SOURCE_LABEL, type ReportInput } from "./gradingReport.ts";
import { grade, LETTER_NOTE, type GradingInput, type TestEvidence } from "./grading.ts";
import { DEFAULT_PLAN, batteryHealthResult, mergeCondition, type TestResults } from "./diagnostics.ts";
import { HEALTHY, type ConditionAnswers } from "./condition.ts";
import { blankCameraCheck, type CaseCameraCheck } from "./gradeiqMap.ts";
import { readPhonecheck, evidenceFromPhonecheck, pcFacts, type PcRecord } from "./phonecheck.ts";
import { luhnCheckDigit } from "./imei.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const AT = "2026-10-17T10:00:00.000Z";
const IMEI = "35000000000001" + luhnCheckDigit("35000000000001");
const IMEI2 = "35000000000019" + luhnCheckDigit("35000000000019");
const GIQ_SESSION = "6f1c1b7e-0000-4000-8000-000000000001";
const PHOTO = (n: number) => `https://swapmore.com/apps/gradeiq/api/uploads/${GIQ_SESSION}-${n}.jpg`;

function allPass(over: Partial<TestResults> = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome: "pass", detail: null, at: AT };
  r.battery_health = batteryHealthResult(91, AT);
  return { ...r, ...over } as TestResults;
}

const COND: ConditionAnswers = { ...HEALTHY, screen: "scratched", issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };

/** The case's full camera record — including GradeIQ's id and letter, which must never reach the body. */
const CAMERA: CaseCameraCheck = {
  ...blankCameraCheck(AT),
  testSessionId: "ts_1",
  gradeiqId: GIQ_SESSION,
  state: "ready",
  grade: "C",
  status: "final",
  final: true,
  conclusive: true,
  lcd: { cameraChecked: true, verdict: "pass", reason: null, confirmed: true },
  identity: { verdict: "match", reasons: [] },
  devicefax: true,
};

function pcRecord(over: Record<string, unknown> = {}): PcRecord {
  const r = readPhonecheck({
    IMEI,
    IMEI2,
    ModelNo: "SM-S918B",
    Passed: "Microphone,LCD",
    Failed: "True Tone",
    BatteryHealthPercentage: "88",
    Grade: "A+",
    Working: "Yes",
    DeviceLock: "Off",
    Parts: JSON.stringify({ Remarks: "Genuine" }),
    StationID: "Station-D04",
    TesterName: "Tester One",
    A4Reports: "123456789",
    A4ReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/A4-certificate/0123456789abcdef0123456789abcdef",
    UpdatedTimeStamp: "2026-10-17T13:30:00.00+04:00",
    Erased: "No",
    ...over,
  });
  assert.ok(r.ok);
  return r.record;
}

function gradingInput(over: Partial<GradingInput> = {}, rec: PcRecord = pcRecord()): GradingInput {
  const evidence: TestEvidence[] = [{ source: "swapup_check", results: allPass(), at: AT }, evidenceFromPhonecheck(rec, "phonecheck", AT)];
  return {
    plan: DEFAULT_PLAN,
    evidence,
    condition: COND,
    faults: [],
    camera: CAMERA,
    cameraComponents: [{ id: "front", grade: "B" }],
    cameraOem: null,
    physicalDevice: true,
    browserRun: false,
    phonecheckImeiOverride: null,
    pcFacts: pcFacts(rec),
    ...over,
  };
}

function reportInput(over: Partial<ReportInput> = {}, g: Partial<GradingInput> = {}): ReportInput {
  const rec = pcRecord();
  // Extra fields the server may hold — a customer's name and number — must never be copied.
  const phone = {
    label: "Samsung Galaxy S23 Ultra",
    variant: "256GB",
    variantSource: "measured",
    modelMatch: "exact",
    imei: IMEI,
    imei2: IMEI2,
    kym: { status: "clear", label: "No block — OK to buy", at: AT },
    customerName: "Asha Verma",
    customerPhone: "9876543210",
  };
  return {
    grading: grade(gradingInput(g, rec)),
    case: { ref: "SU-24-000123", store: "Samsung Service Centre, Indiranagar", storeCode: "BLR01" },
    phone,
    condition: COND,
    camera: {
      check: CAMERA,
      findings: [
        { componentLabel: "front glass", type: "scratch", label: "Light scratches", meaning: "Visible scratches", severity: "moderate", effect: "condition", confirmed: true, photoUrl: PHOTO(0) },
        { componentLabel: "back", type: "scuff", label: "Faint scuff", meaning: null, severity: "minor", effect: "none", confirmed: true, photoUrl: PHOTO(1) },
        { componentLabel: "frame", type: "dent", label: "Possible dent", meaning: "Dents on the frame", severity: "moderate", effect: "flag", confirmed: false, photoUrl: PHOTO(2) },
        { componentLabel: "rear cameras", type: "crack", label: "Cracked lens", meaning: "Rear camera faulty", severity: "severe", effect: "suggested", confirmed: true, photoUrl: PHOTO(0) },
      ],
      passportId: "DFX-7Q2K-91XA",
    },
    faults: ["rear_camera"],
    faultSources: { rear_camera: ["phonecheck", "camera_ai"] },
    phonecheck: { record: rec, source: "pull" },
    checkedAt: { swapupCheck: AT, camera: AT, phonecheck: rec.testedAt },
    sessions: { app: "native", appVersion: "0.6.2", earlierSessions: 1 },
    ...over,
  };
}

const sha = (body: unknown) => createHash("sha256").update(canonicalJson(body)).digest("hex");

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

/* ─────────────────────────── R1–R4 (spec §6.2) ─────────────────────────── */

const MONEY = /amount|price|quote|tradeValue|bonus|payable|refurbCost|marketSell|offer|margin|₹/i;

test("R1: no money anywhere in the body — whatever the status", () => {
  const variants: Partial<GradingInput>[] = [
    {},
    { faults: ["screen_cracked", "battery_drain"], condition: mergeCondition(COND, ["screen_cracked", "battery_drain"]) },
    { evidence: [] },
    { condition: null },
    { faults: ["water_damage"], condition: { ...COND, issues: ["liquid"] } },
    { camera: null, pcFacts: { parts: "not_genuine", deviceLock: "on" }, browserRun: true },
  ];
  for (const g of variants) {
    const { body } = buildReportBody(reportInput({}, g));
    const json = JSON.stringify(body);
    assert.ok(!MONEY.test(json), `${body.grade.status}: ${json.match(MONEY)?.[0]}`);
  }
});

test("R2: no UUID, no GradeIQ upload path, no full IMEI, no customer, no GradeIQ letter", () => {
  const input = reportInput();
  const { body, photoSources } = buildReportBody(input);
  const json = JSON.stringify(body);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(json), "no UUID — GradeIQ's session id is its write key");
  assert.ok(!json.includes("/api/uploads/"));
  assert.ok(!/\d{15}/.test(json), "no full IMEI");
  assert.ok(!json.includes(IMEI) && !json.includes(IMEI2));
  assert.ok(!json.includes("Asha") && !json.includes("9876543210"), "no customer name or number");
  assert.ok(!json.includes("cloudportal.phonecheck.com"), "Phonecheck's report links are staff-only");
  assert.ok(!json.includes("Tester One"), "no tester name");
  const keys = keysOf(body);
  for (const k of ["gradeiqId", "cosmeticGrade", "overallGrade", "functionalGrade", "photoUrl", "devicefax", "session", "links", "customerName", "customerPhone", "serial"])
    assert.ok(!keys.has(k), `no ${k}`);
  assert.ok(!("grade" in body.camera), "the camera section carries no letter");
  assert.ok(!json.includes('"C"'), "GradeIQ's letter C is nowhere");
  // The photos are numbers in the body; their URLs are the server's.
  assert.deepEqual(photoSources, [PHOTO(0)]);
  assert.deepEqual(
    body.camera.findings.map((f) => [f.part, f.what, f.photo]),
    [
      ["front glass", "Visible scratches", 0],
      ["rear cameras", "Rear camera faulty", 0],
    ]
  );
});

test("R3: canonical JSON is the same when keys are reordered; the hash moves when the grade does", () => {
  const { body } = buildReportBody(reportInput());
  const rev = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(rev) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, rev(x)])) : v;
  const reordered = rev(body);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(body));
  assert.equal(canonicalJson(reordered), canonicalJson(body));
  assert.equal(sha(reordered), sha(body));
  const worse = buildReportBody(reportInput({ condition: { ...COND, body: "dented" } }, { condition: { ...COND, body: "dented" } })).body;
  assert.equal(worse.grade.grade, "Fair");
  assert.notEqual(sha(worse), sha(body));
  assert.match(sha(body), /^[0-9a-f]{64}$/);
});

test("R4: deterministic for a fixed input", () => {
  const a = buildReportBody(reportInput());
  const b = buildReportBody(reportInput());
  assert.deepEqual(a, b);
  assert.equal(canonicalJson(a.body), canonicalJson(b.body));
});

/* ─────────────────────────── what the body says ─────────────────────────── */

test("body: both scales — the SwapUp grade, its letter, and the one line that explains it", () => {
  const { body } = buildReportBody(reportInput());
  assert.equal(body.schema, REPORT_SCHEMA);
  assert.equal(REPORT_SCALE, "Superb > Good > Fair > Best Value · tested at the store, not by the buyer");
  assert.equal(body.grade.grade, "Good");
  assert.equal(body.grade.letter, "B");
  assert.equal(body.grade.label, body.grade.final ? "Good (B)" : "Good (B) · provisional");
  assert.equal(body.grade.scale, REPORT_SCALE);
  assert.equal(body.grade.letterScale, LETTER_NOTE);
  assert.equal(body.grade.letterScale, "A = Superb, B = Good, C = Fair, D = Best Value — not CTIA.");
  const cracked = { faults: ["screen_cracked" as const], condition: mergeCondition(COND, ["screen_cracked"]) };
  // Phonecheck's failed True Tone is not a SwapUp fault: nobody can say what the phone grades after repair.
  assert.equal(buildReportBody(reportInput({}, cracked)).body.grade.afterRepairLabel, null);
  const repair = buildReportBody(reportInput({}, { ...cracked, evidence: [{ source: "swapup_check", results: allPass(), at: AT }] })).body;
  assert.equal(repair.grade.status, "needs_repair");
  assert.equal(repair.grade.letter, null);
  // A new display replaces the scratched glass too: the condition records only "cracked".
  assert.equal(repair.grade.afterRepair, "Superb");
  assert.equal(repair.grade.afterRepairLabel, repair.grade.provisional.length ? "Superb (A) · provisional" : "Superb (A)");
  assert.deepEqual(repair.repairs, { parts: ["Display assembly"], inspection: [] });
  // The after-repair grade is as sure as the grade it rests on: battery health not read (PV5) → provisional.
  const unread = buildReportBody(
    reportInput({}, { ...cracked, evidence: [{ source: "swapup_check", results: allPass({ battery_health: { outcome: "skip", detail: { healthPct: null }, at: AT } }), at: AT }] })
  ).body;
  assert.ok(unread.grade.provisional.some((p) => p.code === "PV5"));
  assert.equal(unread.grade.afterRepairLabel, "Superb (A) · provisional");
  const partial = buildReportBody(reportInput({}, { evidence: [{ source: "swapup_check", results: allPass({ mic: { outcome: "skip", detail: null, at: AT } }), at: AT }] })).body;
  assert.equal(partial.grade.ceilingLabel, "Good (B)");
  assert.equal(partial.grade.letter, null);
});

test("body: the phone — masked IMEIs, check digit, KYM", () => {
  const { body } = buildReportBody(reportInput());
  assert.equal(body.phone.imei, `35${"•".repeat(9)}${IMEI.slice(-4)}`);
  assert.equal(body.phone.imei2, `35${"•".repeat(9)}${IMEI2.slice(-4)}`);
  assert.equal(body.phone.imeiCheckDigit, "valid");
  assert.deepEqual(body.phone.kym, { status: "clear", label: "No block — OK to buy", at: AT });
  const none = buildReportBody(reportInput({ phone: { ...reportInput().phone, imei: null, imei2: null, kym: null } })).body;
  assert.deepEqual([none.phone.imei, none.phone.imei2, none.phone.imeiCheckDigit, none.phone.kym], [null, null, null, null]);
});

test("body: tests, other Phonecheck tests, battery, condition, faults with their sources", () => {
  const { body } = buildReportBody(reportInput());
  assert.equal(body.tests.length, DEFAULT_PLAN.length);
  assert.deepEqual(body.tests.find((t) => t.id === "mic")!.sources.map((s) => [s.source, s.outcome]), [
    ["swapup_check", "pass"],
    ["phonecheck", "pass"],
  ]);
  assert.deepEqual(body.otherTests, [{ name: "True Tone", result: "failed", source: "phonecheck", manual: false }]);
  assert.deepEqual(body.battery, {
    healthPct: 88,
    passLine: 80,
    readings: [
      { pct: 91, source: "screenshot", at: AT },
      { pct: 88, source: "phonecheck", at: "2026-10-17T09:30:00.000Z" },
    ],
    cycles: null,
  });
  assert.deepEqual(body.condition, { screen: "Visible scratches", body: "Flawless", issues: [], powersOn: true, calls: true });
  assert.deepEqual(body.faults, [{ id: "rear_camera", label: "Rear camera faulty", sources: [FAULT_SOURCE_LABEL.phonecheck, FAULT_SOURCE_LABEL.camera_ai], certifiedBy: null }]);
  const advisor = buildReportBody(reportInput({ faults: ["mic"], faultSources: {} })).body;
  assert.deepEqual(advisor.faults[0].sources, ["Advisor"], "a fault with no source was the advisor's");
});

test("body: camera — LCD in words, passport id only when it is one, never the letter", () => {
  const { body } = buildReportBody(reportInput());
  assert.deepEqual(
    { ...body.camera, findings: undefined },
    { checked: true, status: "final", final: true, lcd: "passed", findings: undefined, reference: "DFX-7Q2K-91XA", photos: [], why: null, checkedBy: null }
  );
  const lcd = (l: CaseCameraCheck["lcd"]) => buildReportBody(reportInput({ camera: { ...reportInput().camera, check: { ...CAMERA, lcd: l } } })).body.camera.lcd;
  assert.equal(lcd({ cameraChecked: false, verdict: null, reason: "not run" }), "not_checked");
  assert.equal(lcd({ cameraChecked: true, verdict: "fail", reason: null, confirmed: true }), "failed");
  assert.equal(lcd({ cameraChecked: true, verdict: "fail", reason: null, confirmed: false }), "unsure");
  assert.equal(lcd({ cameraChecked: true, verdict: "fail", reason: null }), "unsure", "an old record without `confirmed` is not a confirmed fail");
  const ref = (passportId: string | null) => buildReportBody(reportInput({ camera: { ...reportInput().camera, passportId } })).body.camera.reference;
  assert.equal(ref(GIQ_SESSION), null, "anything not shaped DFX-… is dropped");
  assert.equal(ref("DFX-<script>"), null);
  assert.equal(ref(null), null);
  const none = buildReportBody(reportInput({ camera: { check: null, findings: [], passportId: null } })).body.camera;
  assert.deepEqual(none, { checked: false, status: null, final: false, lcd: "not_checked", findings: [], reference: null, photos: [], why: "The store camera didn't photograph this phone.", checkedBy: null });
});

test("body: Phonecheck — report number and the tester's own grade, how it arrived; no links", () => {
  const { body } = buildReportBody(reportInput());
  assert.deepEqual(body.phonecheck, {
    testedAt: "2026-10-17T09:30:00.000Z",
    station: "Station-D04",
    reportNo: "123456789",
    working: "yes",
    testerGrade: "A+",
    erased: false,
    parts: "genuine",
    deviceLock: "off",
    uploaded: false,
    aiRead: false,
  });
  const up = buildReportBody(reportInput({ phonecheck: { record: { ...pcRecord(), aiRead: true }, source: "upload" } })).body.phonecheck!;
  assert.deepEqual([up.uploaded, up.aiRead], [true, true]);
  assert.equal(buildReportBody(reportInput({ phonecheck: null })).body.phonecheck, null);
});

test("R2b: free text staff typed can't leak an IMEI, a phone number or a UUID", () => {
  const override = { by: "Priya", userId: "u1", reason: `box says ${IMEI2}, customer on 9876543210, ref ${GIQ_SESSION}`, at: AT, items: ["imei"] };
  const { body } = buildReportBody(reportInput({}, { phonecheckImeiOverride: override, camera: { ...CAMERA, overrides: [override] } }));
  const json = JSON.stringify(body);
  assert.ok(!json.includes(IMEI2) && !json.includes("9876543210") && !json.includes(GIQ_SESSION));
  assert.match(body.grade.provisional.find((p) => p.code === "PV8")!.text, /box says 35•{9}\d{4}, customer on •{8}10, ref \[id\]/);
  assert.equal(body.grade.disclosures.find((d) => d.code === "DS4")!.text, body.grade.disclosures.find((d) => d.code === "DS4")!.text.replace(/\d{10,}/g, ""));
  assert.equal(scrubText("Battery health 79 % — under 80 %."), "Battery health 79 % — under 80 %.", "ordinary numbers stand");
});

/* ─────────────────────────── canonical JSON ─────────────────────────── */

test("canonicalJson: sorted keys at every depth, JSON.stringify's rules otherwise", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalJson([undefined, NaN, Infinity, "₹"]), '[null,null,null,"₹"]');
  assert.equal(canonicalJson("é\n"), JSON.stringify("é\n"));
  const v = { x: [1, 2, { k: true }], y: "s" };
  assert.deepEqual(JSON.parse(canonicalJson(v)), v);
});

test("body: no word on the report names the buyback partner (owner, 2026-10-17)", () => {
  const cracked = { faults: ["screen_cracked" as const], condition: mergeCondition(COND, ["screen_cracked"]) };
  for (const input of [reportInput(), reportInput({}, cracked)]) assert.ok(!namesBrand(canonicalJson(buildReportBody(input).body)));
  assert.ok(!namesBrand(`${REPORT_SCALE} ${LETTER_NOTE}`));
});

/* ─────────────────────────── as rich as the store camera's own report (owner, 2026-10-17) ─────────────────────────── */

const DISP = (n: number) => `https://swapmore.com/apps/gradeiq/api/uploads/${GIQ_SESSION}-disp-1-${n}.jpg`;
/** The four live cases: GradeIQ's AI out of credit — photos taken, the grade a stand-in ("failed"), the colours photographed but unread. */
const FAILED_CAMERA: CaseCameraCheck = {
  ...CAMERA,
  grade: null,
  status: "failed",
  final: false,
  by: "Asha K.",
  lcd: { cameraChecked: false, verdict: "unknown", reason: "captured 2 of 3 colours, AI reader off — check by eye", confirmed: false, captured: 2, requested: 3, aiOff: true },
};
const STUB_SWEEP = {
  verdict: "unknown" as const,
  confidence: 0,
  note: "Display validation unavailable (AI call failed) — check the screen manually.",
  findings: [],
  source: "stub" as const,
  patterns: ["white", "black"],
  captures: [
    { pattern: "white", photo: DISP(0) },
    { pattern: "black", photo: DISP(1) },
  ],
  requested: ["white", "black", "red"],
  missing: ["red"],
  reason: null,
};
function failedInput(over: Partial<ReportInput["camera"]> = {}, rest: Partial<ReportInput> = {}): ReportInput {
  const base = reportInput({}, { camera: FAILED_CAMERA });
  return {
    ...base,
    camera: {
      check: FAILED_CAMERA,
      findings: [],
      passportId: null,
      photos: [0, 1, 2].map((n) => ({ url: PHOTO(n), label: null })),
      parts: null,
      signals: { stub: true, obstruction: false, retake: false, lowCoverage: false },
      display: STUB_SWEEP,
      ...over,
    },
    ...rest,
  };
}

test("photos: every exterior photo but the front glass is on the report with its angle — even when the camera couldn't grade — and never as a URL", () => {
  const { body, photoSources } = buildReportBody(failedInput());
  // The front glass faces the camera with the phone's screen on it — possibly still its scan
  // code, whose GradeIQ session id opens that session: never on the public report.
  assert.deepEqual(body.camera.photos, [
    { n: 0, label: "Back" },
    { n: 1, label: "Left side" },
  ]);
  assert.deepEqual(body.camera.findings, [], "no marks without a final grade");
  assert.equal(body.camera.why, "The automatic grader is off.");
  assert.equal(body.camera.checkedBy, "Asha K.");
  assert.deepEqual(photoSources.slice(0, 2), [PHOTO(1), PHOTO(2)]);
  assert.ok(!photoSources.includes(PHOTO(0)), "the front glass can't be fetched by number either");
  const json = JSON.stringify(body);
  assert.ok(!json.includes("/api/uploads/") && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(json), "photos are numbers; their URLs stay on the server");
  // GradeIQ's own labels win when it stored them.
  const labelled = buildReportBody(failedInput({ photos: [{ url: PHOTO(0), label: "Front glass (screen off)" }, { url: PHOTO(1), label: "" }] })).body;
  assert.deepEqual(labelled.camera.photos!.map((p) => p.label), ["Back"]);
});

test("photos: a final grade's marks carry their box, on the same photo numbers as the angle grid", () => {
  const input = reportInput();
  const { body } = buildReportBody({
    ...input,
    camera: {
      ...input.camera,
      photos: [0, 1].map((n) => ({ url: PHOTO(n), label: null })),
      findings: input.camera.findings.map((f, i) => ({ ...f, box: i === 0 ? ([0.1, 0.2, 0.3, 0.4] as [number, number, number, number]) : null })),
    },
  });
  // A mark on the front glass is said, without the front-glass photo.
  assert.deepEqual(body.camera.findings[0], { part: "front glass", what: "Visible scratches", severity: "moderate", photo: null, box: [0.1, 0.2, 0.3, 0.4] });
  assert.equal(body.camera.photos![0].label, "Back");
  assert.ok(body.camera.findings.every((f) => f.photo === null), "every mark here was framed on the front-glass photo");
});

test("parts: a final grade, part by part in words — never the camera's letter, its score, or a letter in its note", () => {
  const input = reportInput();
  const { body } = buildReportBody({
    ...input,
    camera: {
      ...input.camera,
      parts: [
        { id: "front", label: "front glass", assessed: true, note: "Light scratches, grade B overall." },
        { id: "back", label: "back", assessed: true, note: "" },
        { id: "cameras", label: "rear cameras", assessed: true, note: "Cracked lens on the main camera." },
        { id: "display", label: "display (screen on)", assessed: false, note: "" },
      ],
    },
  });
  assert.deepEqual(body.camera.parts, [
    { part: "front glass", word: "Wear", note: "Light scratches, overall." },
    { part: "back", word: "1 light mark", note: null },
    { part: "rear cameras", word: "Damage: rear camera faulty", note: "Cracked lens on the main camera." },
    { part: "display (screen on)", word: "Not seen by the camera", note: null },
  ]);
  assert.ok(!JSON.stringify(body).includes('"C"') && !/grade B/.test(JSON.stringify(body)));
  // Not final: no parts at all.
  assert.equal(buildReportBody(failedInput({ parts: [{ id: "front", label: "front glass", assessed: true, note: "x" }] })).body.camera.parts, undefined);
});

test("screen colours: each colour asked for, with its frame; what's missing; why it wasn't checked — in SwapUp's words", () => {
  const { body, photoSources } = buildReportBody(failedInput());
  assert.deepEqual(body.screen!.colours, [
    { pattern: "white", photo: 2 },
    { pattern: "black", photo: 3 },
    { pattern: "red", photo: null },
  ]);
  assert.deepEqual(photoSources.slice(2), [DISP(0), DISP(1)]);
  assert.deepEqual(body.screen!.missing, ["red"]);
  assert.deepEqual(body.screen!.marks, [], "the reader was off: no marks are invented");
  assert.equal(body.screen!.why, "Colours photographed; the automatic reader is off.");
  // The reasons GradeIQ gives become fixed sentences; its text never passes through.
  const why = (reason: string, lcdOverride: CaseCameraCheck["lcdOverride"] = null, display: ReportInput["camera"]["display"] = STUB_SWEEP) =>
    buildReportBody(failedInput({ check: { ...FAILED_CAMERA, lcdOverride, lcd: { cameraChecked: false, verdict: null, reason } }, display })).body.screen!.why;
  assert.equal(why("the camera never got a clear view of the lit screen (on a folding phone, unfold it and show the inner display)"), "The store camera couldn't see the lit screen.");
  assert.equal(why("the phone never confirmed it was showing the test patterns"), "The customer's phone didn't show the colours.");
  assert.equal(why("the camera was unlocked by Ravi before…", { by: "Ravi", reason: "x", at: AT }, null), "The camera was started before the customer's phone was ready (Ravi).");
  assert.equal(why("The screen sweep hasn't run.", null, null), "The store camera's colour check didn't run.");
  // A sweep the reader judged: the marks, with their boxes and frames.
  const read = buildReportBody(
    reportInput({ camera: { ...reportInput().camera, display: { ...STUB_SWEEP, verdict: "fail", source: "gemini", missing: [], findings: [{ type: "line", label: "Vertical line", confidence: 0.9, pattern: "white", severity: "moderate", box: [0.1, 0.4, 0.9, 0.42] }] } } })
  ).body.screen!;
  assert.deepEqual(read.marks, [{ pattern: "white", what: "Vertical line", severity: "moderate", photo: 1, box: [0.1, 0.4, 0.9, 0.42] }]);
  assert.equal(read.why, null, "the sweep checked it");
  const json = JSON.stringify(buildReportBody(failedInput()).body);
  for (const word of [/gemini/i, /gradeiq/i, /\b402\b/, /credit/i, /unfold/i, /AI call failed/i]) assert.ok(!word.test(json), `${word} must not reach the report`);
});

test("certification: what the advisor checked by eye, by name — and the faults it put on the case say so", () => {
  const cert = {
    screen: { value: "ok", label: "OK", by: "Asha K.", userId: "usr_a", at: AT, withColours: true, testSessionId: "ts_1", added: [], addedIssues: [] },
    body: { value: "bent", label: "Bent", by: "Ravi", userId: "usr_r", at: AT, withColours: false, testSessionId: "ts_1", added: ["frame_damage" as const], addedIssues: [] },
  };
  const { body } = buildReportBody(failedInput({}, { certification: cert, faults: ["frame_damage"], faultSources: { frame_damage: ["advisor"] } }));
  assert.deepEqual(body.certification, {
    screen: { value: "ok", label: "OK", by: "Asha K.", at: AT, withColours: true, line: "Screen certified by Asha K.: no lines, spots, dead pixels or scratches, on the test colours." },
    body: { value: "bent", label: "Bent", by: "Ravi", at: AT, withColours: false, line: "Body certified by Ravi: bent or broken frame." },
  });
  assert.equal(body.faults[0].certifiedBy, "Ravi");
  assert.ok(!JSON.stringify(body).includes("usr_"), "staff ids stay on the case");
  assert.deepEqual(buildReportBody(reportInput()).body.certification, {});
});

test("the phone: OS, colour, the camera's identity check; Phonecheck's locks, cycles and parts; the camera's parts evidence only when final", () => {
  const rec = { ...pcRecord(), colour: "Phantom Black", batteryCycles: 312, rooted: "off" as const, mdm: "on" as const };
  const input = reportInput({ phone: { ...reportInput().phone, os: "Android 14" }, phonecheck: { record: rec, source: "pull" } });
  const { body } = buildReportBody({ ...input, camera: { ...input.camera, check: { ...CAMERA, identityOverride: null }, colour: "Lavender", oem: { verdict: "suspect_aftermarket", evidence: ["Screen edge looks aftermarket"] } } });
  assert.equal(body.phone.os, "Android 14");
  assert.equal(body.phone.colour, "Phantom Black", "Phonecheck's colour first");
  assert.deepEqual(body.phone.identity, { verdict: "match", acceptedBy: null });
  assert.equal(body.battery.cycles, 312);
  assert.deepEqual(body.locks, { activation: "off", rooted: "off", mdm: "on" });
  assert.deepEqual(body.parts, { phonecheck: "genuine", camera: "suspect", evidence: ["Screen edge looks aftermarket"] });
  // A failed grade's evidence is not used.
  const failed = buildReportBody(failedInput({ oem: { verdict: "suspect_aftermarket", evidence: ["x"] }, colour: "Lavender" }, { phonecheck: null })).body;
  assert.equal(failed.parts, null);
  assert.equal(failed.phone.colour, null);
  assert.equal(failed.locks, null);
});

