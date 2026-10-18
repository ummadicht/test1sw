import { test } from "node:test";
import { namesBrand } from "../../lib/domain/testing/brand.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReportBody, REPORT_SCALE, type ReportInput } from "../../lib/domain/gradingReport.ts";
import { grade, LETTER_NOTE, type GradingInput, type TestEvidence } from "../../lib/domain/grading.ts";
import { DEFAULT_PLAN, batteryHealthResult, type TestResults } from "../../lib/domain/diagnostics.ts";
import { HEALTHY, type ConditionAnswers } from "../../lib/domain/condition.ts";
import { blankCameraCheck, type CaseCameraCheck } from "../../lib/domain/gradeiqMap.ts";
import { readPhonecheck, evidenceFromPhonecheck, pcFacts, PC_UPLOAD_MAX_BYTES, type PcRecord } from "../../lib/domain/phonecheck.ts";
import { luhnCheckDigit } from "../../lib/domain/imei.ts";
import type { ReportEnvelope } from "../../lib/server/gradingReport.ts";
import type { PcSummary } from "../../lib/server/phonecheck.ts";
import {
  BUYER_LINE,
  PC_JSON_MAX_BYTES,
  REASON_WORD,
  TONE_TEXT,
  absoluteUrl,
  checkUpload,
  extractedRows,
  gradeLine,
  gradeTail,
  gradeTone,
  headlineExtra,
  mismatchOf,
  overrideReasonOk,
  pcRecordLine,
  photoPath,
  pinnedPath,
  readJsonUpload,
  reasonLists,
  reportView,
  shortHash,
  sourceWord,
  testCounts,
  tokenOf,
  when,
} from "./gradingView.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */
// A report body exactly as the server builds it (lib/domain/grading.ts → lib/domain/gradingReport.ts).

const AT = "2026-10-17T10:00:00.000Z";
const IMEI = "35000000000001" + luhnCheckDigit("35000000000001");
const TOKEN = "A8j2qL8t-P2MdEM_ww16pw";
const GIQ_SESSION = "6f1c1b7e-0000-4000-8000-000000000001";
const PHOTO = `https://swapmore.com/apps/gradeiq/api/uploads/${GIQ_SESSION}-0.jpg`;

function allPass(over: Partial<TestResults> = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome: "pass", detail: null, at: AT };
  r.battery_health = batteryHealthResult(91, AT);
  return { ...r, ...over } as TestResults;
}

const COND: ConditionAnswers = { ...HEALTHY, screen: "scratched", issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };

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
    ModelNo: "SM-S918B",
    Passed: "LCD,Loud Speaker",
    Failed: "Microphone,True Tone",
    BatteryHealthPercentage: "76",
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

function gradingInput(over: Partial<GradingInput> = {}, pc: { record: PcRecord; upload: boolean } | null = null): GradingInput {
  const evidence: TestEvidence[] = [{ source: "swapup_check", results: allPass(), at: AT }];
  if (pc) evidence.push(evidenceFromPhonecheck(pc.record, pc.upload ? "phonecheck_upload" : "phonecheck", AT));
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
    pcFacts: pc ? pcFacts(pc.record) : null,
    ...over,
  };
}

function envelope(g: Partial<GradingInput> = {}, over: Partial<ReportInput> = {}, pc: { record: PcRecord; upload: boolean } | null = null, meta: Partial<ReportEnvelope> = {}): ReportEnvelope {
  const input: ReportInput = {
    grading: grade(gradingInput(g, pc)),
    case: { ref: "SU-AND-00120", store: "Andheri West Experience Center", storeCode: "AND" },
    phone: { label: "Samsung Galaxy S23 Ultra", variant: "256GB", variantSource: "measured", modelMatch: "exact", imei: IMEI, imei2: null, kym: null },
    condition: g.condition === undefined ? COND : g.condition,
    camera: {
      check: CAMERA,
      findings: [{ componentLabel: "front glass", type: "scratch", label: "Light scratches", meaning: "Visible scratches", severity: "moderate", effect: "condition", confirmed: true, photoUrl: PHOTO }],
      passportId: "DFX-7Q2K-91XA",
    },
    faults: g.faults ?? [],
    faultSources: {},
    phonecheck: pc ? { record: pc.record, source: pc.upload ? "upload" : "pull" } : null,
    checkedAt: { swapupCheck: AT, camera: AT, phonecheck: pc?.record.testedAt ?? null },
    sessions: { app: "native", appVersion: "0.6.2", earlierSessions: 0 },
    ...over,
  };
  const { body } = buildReportBody(input);
  return { schema: "swapup.grading-report/v1", version: 3, sha256: "1974b79a3c2b64b4cf8bb8bee4e45df6b3fe8f5b5b63807acfdd3c3a5913bbed", issuedAt: AT, reason: "traded_in", final: true, body, ...meta };
}

const MONEY_KEYS = ["amount", "price", "quote", "tradeValue", "bonus", "bonusValue", "payable", "refurbCost", "marketSell", "offer", "margin"];

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

/* ─────────────────────────── the grade line ─────────────────────────── */

test("tone: green only for a final grade; amber provisional / not fully tested; red needs repair / can't grade", () => {
  assert.equal(gradeTone("graded", true), "up");
  assert.equal(gradeTone("graded", false), "warn");
  assert.equal(gradeTone("incomplete", false), "warn");
  assert.equal(gradeTone("needs_repair", false), "bad");
  assert.equal(gradeTone("cannot_grade", false), "bad");
  assert.equal(gradeTone("not_tested", false), "plain");
  assert.equal(TONE_TEXT.plain, "");
});

test("the line reads the server's label as-is, with its letter: 'SwapUp grade: Good (B)'", () => {
  assert.equal(gradeLine("Good (B)"), "SwapUp grade: Good (B)");
  assert.equal(gradeLine("Good (B) · provisional"), "SwapUp grade: Good (B) · provisional");
  assert.equal(gradeLine("Needs repair"), "SwapUp grade: Needs repair");
});

test("headline extra: after repair, at best, provisional — each with both scales", () => {
  assert.equal(headlineExtra({ status: "needs_repair", final: false, afterRepairLabel: "Superb (A)", ceilingLabel: null }), "After repair: Superb (A)");
  assert.equal(headlineExtra({ status: "needs_repair", final: false, afterRepairLabel: null, ceilingLabel: null }), "No grade until repaired.");
  assert.equal(headlineExtra({ status: "incomplete", final: false, afterRepairLabel: null, ceilingLabel: "Good (B)" }), "At best Good (B) once key tests pass");
  assert.equal(headlineExtra({ status: "graded", final: false, afterRepairLabel: null, ceilingLabel: null }), null, "the label already says provisional");
  assert.equal(headlineExtra({ status: "graded", final: true, afterRepairLabel: null, ceilingLabel: null }), null);
  assert.equal(headlineExtra({ status: "not_tested", final: false, afterRepairLabel: null, ceilingLabel: null }), null);
});

test("one-line tail (the receipt): after repair / at best, both scales; nothing for a graded phone", () => {
  assert.equal(gradeTail({ status: "needs_repair", afterRepairLabel: "Superb (A)", ceilingLabel: null }), " · after repair Superb (A)");
  assert.equal(gradeTail({ status: "needs_repair", afterRepairLabel: null, ceilingLabel: null }), "");
  assert.equal(gradeTail({ status: "incomplete", afterRepairLabel: null, ceilingLabel: "Fair (C)" }), " · at best Fair (C)");
  assert.equal(gradeTail({ status: "graded", afterRepairLabel: null, ceilingLabel: null }), "");
});

test("reason lists: why first, then the rest, what to check by hand, what a buyer must hear", () => {
  const r = reasonLists({
    reasons: [
      { code: "NR1", text: "Microphone failed." },
      { code: "NR2", text: "Recorded fault: Microphone faulty." },
    ],
    provisional: [{ code: "PV5", text: "Battery health not read." }],
    disclosures: [{ code: "DS3", text: "Activation lock on." }],
  });
  assert.deepEqual(r, { why: "Microphone failed.", more: ["Recorded fault: Microphone faulty."], check: ["Battery health not read."], disclose: ["Activation lock on."] });
  assert.equal(reasonLists({ reasons: [], provisional: [], disclosures: [] }).why, null);
});

/* ─────────────────────────── links ─────────────────────────── */

test("links: token out of a report path, a pinned version, the absolute URL, a short hash", () => {
  assert.equal(tokenOf(`/r/${TOKEN}`), TOKEN);
  assert.equal(tokenOf(`/r/${TOKEN}?v=3`), TOKEN);
  assert.equal(tokenOf("/r/short"), null);
  assert.equal(tokenOf(`/x/${TOKEN}`), null);
  assert.equal(tokenOf(null), null);
  assert.equal(pinnedPath(`/r/${TOKEN}`, 3), `/r/${TOKEN}?v=3`);
  assert.equal(pinnedPath(`/r/${TOKEN}?v=1`, 3), `/r/${TOKEN}?v=3`, "re-pinning replaces the version");
  assert.equal(absoluteUrl("https://swapup.104-197-168-25.sslip.io/", `/r/${TOKEN}`), `https://swapup.104-197-168-25.sslip.io/r/${TOKEN}`);
  assert.equal(absoluteUrl(null, `/r/${TOKEN}`), `/r/${TOKEN}`);
  assert.equal(absoluteUrl("http://x", "https://y/r/1"), "https://y/r/1");
  assert.equal(shortHash("1974b79a3c2b64b4cf8bb8bee4e45df6"), "1974b79a3c2b");
  assert.equal(photoPath(TOKEN, 2, 5), `/api/r/${TOKEN}/photo/2?v=5`);
});

test("dates: India time, whatever the server's zone; nothing for nothing", () => {
  assert.match(when("2026-10-17T13:51:00.000Z"), /17 Oct 2026/);
  assert.match(when("2026-10-17T13:51:00.000Z"), /07:21\s*pm/i);
  assert.equal(when(null), "—");
  assert.equal(when("not a date"), "—");
  assert.equal(when("2026-10-17T20:00:00.000Z", "date"), "18 Oct 2026");
});

/* ─────────────────────────── the report, as the page reads it ─────────────────────────── */

test("report view: a graded phone — both scales under the grade, the letter line, the scale line", () => {
  const v = reportView(envelope(), TOKEN);
  assert.equal(v.headline.status, "graded");
  assert.equal(v.headline.label, "Good (B)");
  assert.equal(v.headline.tone, "up");
  assert.equal(v.letterNote, LETTER_NOTE);
  assert.match(v.letterNote, /A = Superb, B = Good, C = Fair, D = Best Value/);
  assert.match(v.letterNote, /not CTIA/i);
  assert.equal(v.scale, REPORT_SCALE);
  assert.match(v.scale, /Superb > Good > Fair > Best Value/);
  assert.equal(v.why, "Screen visible scratches, body flawless.");
  assert.equal(v.ref, "SU-AND-00120");
});

test("report view: an older version keeps its hashed body, but the scale line under the grade is today's wording", () => {
  const env = envelope();
  const old = { ...env, body: { ...env.body, grade: { ...env.body.grade, scale: "an older scale line, as hashed into version 1" } } };
  const v = reportView(old, TOKEN);
  assert.equal(v.scale, REPORT_SCALE);
  assert.equal(v.headline.label, env.body.grade.label, "the grade itself is the version's own");
});

test("report view: no page word names the buyback partner's brand", () => {
  const variants = [
    envelope(),
    envelope({ faults: ["screen_cracked"], condition: { ...COND, screen: "cracked" } }, { faults: ["screen_cracked"] }),
    envelope({ condition: { ...COND, body: "back_cracked" } }),
    envelope({}, {}, { record: pcRecord(), upload: true }),
    envelope({ cameraComponents: [{ id: "front", grade: "D" }] }),
  ];
  for (const env of variants) assert.ok(!namesBrand(JSON.stringify(reportView(env, TOKEN))), JSON.stringify(reportView(env, TOKEN).why));
  assert.ok(!namesBrand(LETTER_NOTE));
});

test("report view: no money and no store margin anywhere — no rupee figure, no money field", () => {
  const variants = [
    envelope(),
    envelope({ faults: ["screen_cracked", "battery_drain"], condition: { ...COND, screen: "cracked" } }, { faults: ["screen_cracked", "battery_drain"] }),
    envelope({}, {}, { record: pcRecord(), upload: true }),
    envelope({ evidence: [] }),
  ];
  for (const env of variants) {
    const v = reportView(env, TOKEN);
    const json = JSON.stringify(v);
    assert.ok(!json.includes("₹"), "no rupee sign");
    assert.ok(!/\bRs\.?\s?\d/i.test(json), "no Rs figure");
    const keys = keysOf(v);
    for (const k of MONEY_KEYS) assert.ok(!keys.has(k), `no ${k} field`);
    assert.ok(!/\d{15}/.test(json), "no full IMEI");
    assert.ok(!json.includes(GIQ_SESSION) && !json.includes("/api/uploads/"), "no GradeIQ session id or upload path");
    assert.ok(!json.includes("cloudportal.phonecheck.com"), "Phonecheck's links are staff-only");
    assert.ok(!json.includes("Tester One"), "no tester name");
  }
  assert.match(BUYER_LINE, /buyer's inspection decides the final price/);
});

test("report view: the store camera's own letter never reaches the page — only the SwapUp grade and its letter", () => {
  const v = reportView(envelope(), TOKEN);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('"C"'), "GradeIQ's C is nowhere");
  assert.ok(!/gradeiq/i.test(json), "no GradeIQ name, id or link");
  assert.equal(v.camera.summary, "Camera grade (final).");
});

test("report view: photos go through SwapUp's proxy, pinned to the version", () => {
  const v = reportView(envelope({}, {}, null, { version: 4 }), TOKEN);
  assert.deepEqual(v.camera.findings, [{ part: "front glass", what: "Visible scratches", severity: "moderate", photo: `/api/r/${TOKEN}/photo/0?v=4` }]);
});

test("report view: each test line names its sources — SwapUp Check pass and Phonecheck fail on one line", () => {
  const env = envelope({ faults: ["mic"], condition: COND }, { faults: ["mic"] }, { record: pcRecord(), upload: false });
  const v = reportView(env, TOKEN);
  const mic = v.tests.find((t) => t.id === "mic")!;
  assert.equal(mic.word, "Failed");
  assert.equal(mic.tone, "bad");
  assert.equal(mic.key, true);
  assert.deepEqual(mic.sources, ["SwapUp Check: passed", "Phonecheck: failed — Microphone"]);
  assert.equal(v.headline.status, "needs_repair");
  assert.equal(v.headline.label, "Needs repair");
  assert.ok(!v.headline.label.includes("("), "no letter without a SwapUp grade");
  assert.equal(v.headline.tone, "bad");
  // True Tone has no SwapUp id: shown verbatim, from Phonecheck.
  assert.deepEqual(v.otherTests, [{ name: "True Tone", word: "Failed", tone: "bad", source: "Phonecheck", manual: false }]);
  // Battery health is its own section, once — never also a test line (Phonecheck read 76 %, under the line).
  assert.equal(v.tests.find((t) => t.id === "battery_health"), undefined);
  assert.equal(v.battery.value, "76 %");
  assert.equal(v.testCounts, `${v.tests.length} tests: ${v.tests.length - 1} passed, 1 failed`);
});

test("report view: battery — the lowest reading counts, red under the pass line, each reading names its source", () => {
  const v = reportView(envelope({}, {}, { record: pcRecord(), upload: false }), TOKEN);
  assert.equal(v.battery.value, "76 %");
  assert.equal(v.battery.tone, "bad");
  assert.match(v.battery.note, /Pass line 80 %/);
  assert.equal(v.battery.readings.length, 2);
  assert.match(v.battery.readings[0], /^91 % — battery screen \(SwapUp Check\)/);
  assert.match(v.battery.readings[1], /^76 % — Phonecheck/);
  // One reading: the figure once — its source in the note, no list repeating it.
  const single = reportView(envelope(), TOKEN);
  assert.equal(single.battery.readings.filter((r) => /%/.test(r)).length, 0);
  assert.match(single.battery.note, /^battery screen \(SwapUp Check\).* · pass line 80 %$/);
  const none = reportView(envelope({ evidence: [{ source: "swapup_check", results: allPass({ battery_health: { outcome: "skip", detail: null, at: AT } }), at: AT }] }), TOKEN);
  assert.equal(none.battery.value, "Not read");
  assert.equal(none.battery.tone, "warn");
});

test("report view: Phonecheck references — the tester's grade is labelled as theirs and never ours; an upload and an AI read say so", () => {
  const pulled = reportView(envelope({}, {}, { record: pcRecord(), upload: false }), TOKEN);
  const tester = pulled.references.find((r) => r.label === "Phonecheck tester's grade")!;
  assert.equal(tester.value, "A+");
  assert.match(tester.note!, /not used for this grade/);
  assert.equal(pulled.references.find((r) => r.label === "Phonecheck")!.value, "Fetched from Phonecheck");
  assert.equal(pulled.references.find((r) => r.label === "Phonecheck report no.")!.value, "123456789");
  // Parts and the activation lock are on "The phone" now — once, not again under the references.
  assert.equal(pulled.references.find((r) => r.label === "Parts"), undefined);
  assert.equal(pulled.references.find((r) => r.label === "Activation lock"), undefined);
  assert.equal(pulled.phone.find((r) => r.label === "Parts")!.value, "Original (Phonecheck)");
  assert.deepEqual(pulled.locks.find((r) => r.label === "Activation lock"), { label: "Activation lock", value: "Off", note: "Phonecheck" });
  assert.equal(pulled.references.find((r) => r.label === "Store camera report")!.value, "DFX-7Q2K-91XA");

  const uploaded = reportView(envelope({}, {}, { record: pcRecord(), upload: true }), TOKEN);
  assert.equal(uploaded.references.find((r) => r.label === "Phonecheck")!.value, "Uploaded by staff");
  assert.ok(uploaded.check.some((c) => /uploaded by staff/.test(c)), "PV7 is a point to check by hand");

  const ai = pcRecord();
  const aiEnv = envelope({}, {}, { record: { ...ai, aiRead: true }, upload: true });
  const aiView = reportView(aiEnv, TOKEN);
  assert.equal(aiView.references.find((r) => r.label === "Phonecheck")!.value, "Upload, read by AI");
  assert.match(aiView.references.find((r) => r.label === "Phonecheck")!.note!, /Check the figures/);
});

test("report view: the phone — masked IMEI with its check digit, storage with where it came from, the register after lock", () => {
  const v = reportView(envelope({}, { phone: { label: "Samsung Galaxy S23 Ultra", variant: "256GB", variantSource: "measured", modelMatch: "exact", imei: IMEI, imei2: null, kym: { status: "clear", label: "No block — OK to buy", at: AT } } }), TOKEN);
  const imei = v.phone.find((r) => r.label === "IMEI")!;
  assert.match(imei.value, /^35•+\d{4}$/);
  assert.equal(imei.note, "check digit OK");
  assert.deepEqual(v.phone.find((r) => r.label === "Storage"), { label: "Storage", value: "256GB", note: "measured on the phone" });
  assert.equal(v.phone.find((r) => r.label === "Model")!.value, "Model code match");
  assert.equal(v.locks.find((r) => r.label === "Government IMEI register")!.value, "No block — OK to buy");
  const before = reportView(envelope(), TOKEN);
  assert.equal(before.locks.find((r) => r.label === "Government IMEI register"), undefined, "no register line before lock");
});

test("report view: not fully tested — at best, with both scales", () => {
  const v = reportView(envelope({ evidence: [{ source: "swapup_check", results: allPass({ mic: { outcome: "skip", detail: null, at: AT } }), at: AT }] }), TOKEN);
  assert.equal(v.headline.status, "incomplete");
  assert.equal(v.headline.label, "Not fully tested");
  assert.equal(v.headline.extra, "At best Good (B) once key tests pass");
  assert.equal(v.tests.find((t) => t.id === "mic")!.word, "Not tested");
});

test("report view: needs repair — what it grades once repaired", () => {
  const v = reportView(envelope({ faults: ["mic"], evidence: [{ source: "swapup_check", results: allPass({ mic: { outcome: "fail", detail: null, at: AT } }), at: AT }] }, { faults: ["mic"] }), TOKEN);
  assert.equal(v.headline.status, "needs_repair");
  assert.equal(v.headline.extra, "After repair: Good (B)");
  assert.deepEqual(v.repairs.parts, ["Microphone"]);
  assert.deepEqual(v.faults, [{ label: "Microphone faulty", sources: "Advisor" }]);
});

test("report view: footer — version, why it was issued, ruleset, full sha256, the buyer line", () => {
  const v = reportView(envelope(), TOKEN);
  assert.equal(v.footer.version, 3);
  assert.equal(v.footer.reason, REASON_WORD.traded_in);
  assert.equal(v.footer.reason, "frozen at hand-over");
  assert.equal(v.footer.final, true);
  assert.equal(v.footer.sha256.length, 64);
  assert.equal(v.footer.ruleset, "2026-10-17.2");
  assert.match(v.footer.hashNote, /not a signature/);
  assert.ok(v.footer.hashNote.includes(`/api/r/${TOKEN}?v=3`), "names exactly where to recompute it");
  assert.equal(v.footer.buyerLine, BUYER_LINE);
});

test("report view: deterministic for the same envelope", () => {
  const env = envelope({}, {}, { record: pcRecord(), upload: false });
  assert.deepEqual(reportView(env, TOKEN), reportView(env, TOKEN));
});

test("source words: manual checks and pending results say so", () => {
  assert.equal(sourceWord({ source: "phonecheck", outcome: "pass", manual: true, names: ["M-Microphone"], at: AT }), "Phonecheck: passed (manual check) — M-Microphone");
  assert.equal(sourceWord({ source: "phonecheck_upload", outcome: "pending", at: AT }), "Phonecheck (uploaded): pending");
  assert.equal(sourceWord({ source: "swapup_check", outcome: "unsupported", at: null }), "SwapUp Check: not on this phone");
});

test("test counts", () => {
  assert.equal(testCounts([{ result: "passed" }, { result: "passed" }, { result: "failed" }, { result: "not_tested" }]).line, "4 tests: 2 passed, 1 failed, 1 not tested");
  assert.equal(testCounts([{ result: "passed" }]).line, "1 test: 1 passed");
});

/* ─────────────────────────── the Phonecheck tools ─────────────────────────── */

test("upload check: the JSON export — a .json file, at most 256 KB", () => {
  assert.deepEqual(checkUpload({ name: "device.json", type: "application/json", size: 2000 }, "json"), { ok: true, kind: "json" });
  assert.deepEqual(checkUpload({ name: "device.json", type: "", size: 2000 }, "json"), { ok: true, kind: "json" });
  const big = checkUpload({ name: "device.json", type: "application/json", size: PC_JSON_MAX_BYTES + 1 }, "json");
  assert.ok(!big.ok && /256 KB/.test(big.reason));
  const pdf = checkUpload({ name: "report.pdf", type: "application/pdf", size: 2000 }, "json");
  assert.ok(!pdf.ok && /Report PDF or photo/.test(pdf.reason));
  assert.ok(!checkUpload({ name: "device.json", type: "application/json", size: 0 }, "json").ok, "empty");
});

test("upload check: the report itself — PDF / JPEG / PNG / WebP up to 8 MB; HEIC and anything else refused before the paid read", () => {
  assert.deepEqual(checkUpload({ name: "a4.pdf", type: "application/pdf", size: 900_000 }, "report"), { ok: true, kind: "report", mime: "application/pdf" });
  assert.deepEqual(checkUpload({ name: "shot.png", type: "image/png", size: 900_000 }, "report"), { ok: true, kind: "report", mime: "image/png" });
  assert.deepEqual(checkUpload({ name: "shot.webp", type: "image/webp", size: 900_000 }, "report"), { ok: true, kind: "report", mime: "image/webp" });
  assert.deepEqual(checkUpload({ name: "photo.JPG", type: "", size: 900_000 }, "report"), { ok: true, kind: "report", mime: "image/jpeg" }, "no type: the extension decides");
  assert.deepEqual(checkUpload({ name: "photo.jpg", type: "image/jpg", size: 900_000 }, "report"), { ok: true, kind: "report", mime: "image/jpeg" });
  const heic = checkUpload({ name: "IMG_1.HEIC", type: "image/heic", size: 900_000 }, "report");
  assert.ok(!heic.ok && /HEIC/.test(heic.reason));
  const txt = checkUpload({ name: "notes.txt", type: "text/plain", size: 900 }, "report");
  assert.ok(!txt.ok && /PDF/.test(txt.reason));
  const big = checkUpload({ name: "a4.pdf", type: "application/pdf", size: PC_UPLOAD_MAX_BYTES + 1 }, "report");
  assert.ok(!big.ok && /8 MB/.test(big.reason));
  assert.ok(checkUpload({ name: "a4.pdf", type: "application/pdf", size: PC_UPLOAD_MAX_BYTES }, "report").ok, "exactly 8 MB is allowed");
});

test("JSON upload: a record or an array goes as-is; anything else says why", () => {
  assert.deepEqual(readJsonUpload('{"IMEI":"1"}'), { ok: true, record: { IMEI: "1" } });
  assert.deepEqual(readJsonUpload('[{"IMEI":"1"}]'), { ok: true, record: [{ IMEI: "1" }] });
  const bad = readJsonUpload("{nope");
  assert.ok(!bad.ok && /isn't valid JSON/.test(bad.reason));
  assert.ok(!readJsonUpload("42").ok);
  assert.ok(!readJsonUpload("null").ok);
});

const SUMMARY: PcSummary = {
  id: "pc_abcdefgh12",
  source: "upload",
  aiRead: true,
  imei: IMEI,
  imei2: null,
  reportNo: "480800508",
  testedAt: "2026-10-17T13:51:00.000Z",
  testedAtWhy: null,
  receivedAt: AT,
  phone: "Samsung Galaxy S23 Ultra",
  modelNo: "SM-S918B",
  variant: "256GB",
  working: "no",
  passed: 20,
  failed: ["Microphone"],
  pending: [],
  batteryHealthPct: 91,
  testerGrade: "B",
  deviceLock: "off",
  parts: "genuine",
  erased: false,
  station: "Teja-D04",
  tester: null,
  links: { a4: null, erasure: null, dhr: null },
  attached: null,
};

test("mismatch: only the case route's 409 with the stored record counts", () => {
  const m = mismatchOf(409, { error: "This Phonecheck report is for IMEI A, but the case has B.", outcome: "mismatch", record: SUMMARY });
  assert.ok(m);
  assert.equal(m.record.id, "pc_abcdefgh12");
  assert.match(m.error, /case has B/);
  assert.equal(mismatchOf(409, { error: "already on case SU-1" }), null, "another 409 is just an error");
  assert.equal(mismatchOf(400, { outcome: "mismatch", record: SUMMARY }), null);
  assert.equal(mismatchOf(409, { outcome: "mismatch", record: {} }), null, "no record id, nothing to attach");
  assert.equal(mismatchOf(409, null), null);
});

test("override reason: 8 characters or more, as the server asks", () => {
  assert.equal(overrideReasonOk("typo"), false);
  assert.equal(overrideReasonOk("   short  "), false);
  assert.equal(overrideReasonOk("dialled *#06#"), true);
});

test("what the AI read: every field, 'not read' where it returned nothing — never filled in", () => {
  const rows = extractedRows({ IMEI, Make: "Samsung", Failed: ["Microphone", "True Tone"], BatteryHealthPercentage: "91", Parts: JSON.stringify({ Remarks: "Genuine" }), UpdatedTimeStamp: "2026-10-17T13:51:00+04:00" });
  const get = (l: string) => rows.find((r) => r.label === l)!;
  assert.deepEqual(get("IMEI"), { label: "IMEI", value: IMEI, read: true });
  assert.deepEqual(get("Model"), { label: "Model", value: "not read", read: false });
  assert.equal(get("Failed").value, "Microphone, True Tone");
  assert.equal(get("Parts").value, "Genuine");
  assert.equal(get("Pending").read, false);
  assert.ok(rows.some((r) => r.label === "Tested at"));
  assert.ok(!rows.some((r) => r.label === "Tested at (no zone)"), "one tested-at row");
  const zoneless = extractedRows({ DeviceUpdatedDate: "2026-10-17 13:51:00" });
  assert.ok(zoneless.some((r) => r.label === "Tested at (no zone)" && r.read));
  assert.ok(!zoneless.some((r) => r.label === "Tested at"));
  assert.ok(extractedRows(null).every((r) => !r.read));
});

test("a stored Phonecheck record as one line", () => {
  assert.equal(
    pcRecordLine(SUMMARY),
    `Samsung Galaxy S23 Ultra · tested ${when(SUMMARY.testedAt)} · 1 failed · battery 91 % · report 480800508 · read by AI from an upload`
  );
  assert.match(pcRecordLine({ ...SUMMARY, aiRead: false, source: "webhook", failed: [], batteryHealthPct: null, testedAt: null }), /test time not recorded · none failed · battery not read · .* · sent by Phonecheck$/);
});

/* ─────────────────────────── the pages never touch money ─────────────────────────── */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("static: the public report page and the shared renderer import nothing that prices, and need no sign-in", () => {
  const page = read("../../app/r/[token]/page.tsx");
  const view = read("../report/GradingReportView.tsx");
  for (const [name, src] of [
    ["app/r/[token]/page.tsx", page],
    ["GradingReportView.tsx", view],
  ] as const) {
    for (const bad of ["lib/domain/money", "inr(", "<Money", "marketSell", "tradeValue", "payable", "bonusValue", "refurbCost", "getCase", "lib/server/cases"])
      assert.ok(!src.includes(bad), `${name} must not use ${bad}`);
  }
  assert.ok(!page.includes("requirePage"), "the link is the key — no sign-in");
  assert.ok(page.includes("publicReport("), "reads only the issued version");
  assert.match(page, /robots:\s*\{\s*index:\s*false/);
});

test("static: the grade line and the Phonecheck panel show no money", () => {
  for (const file of ["./GradeRow.tsx", "./PhonecheckPanel.tsx"]) {
    const src = read(file);
    for (const bad of ["lib/domain/money", "inr(", "<Money", "marketSell", "tradeValue", "payable", "refurbCost"]) assert.ok(!src.includes(bad), `${file} must not use ${bad}`);
  }
});

test("static: one answer on the case page — the grade sits on the answer card, no comparison panel beside it, no second grade card", () => {
  const ws = read("./CaseWorkspace.tsx");
  const card = read("./AnswerCard.tsx");
  assert.ok(card.includes("<GradeRow"), "the answer card carries the grade line");
  assert.ok(!ws.includes("GradingCard"), "no separate grade card");
  assert.ok(!ws.includes("GradeRow"), "the grade is on the answer step only");
  assert.ok(!ws.includes("why-answer"), "no second 'why' panel");
  assert.ok(!ws.includes("DecisionPanel"), "no comparison panel at all — the answer step is the one answer");
  assert.equal((ws.match(/<AnswerCard/g) ?? []).length, 1, "the answer is mounted once");
  assert.ok(!read("./StepTradeIn.tsx").includes("buySell"), "the store margin left the trade-in step for the card under the answer");
  assert.ok(read("./StoreMargin.tsx").includes("Store margin · staff only"));
});

test("static: the desk's own words never name the buyback partner's brand", () => {
  const files = [
    "./AnswerCard.tsx",
    "./AnswerAskForms.tsx",
    "./answerAsks.ts",
    "./GradeRow.tsx",
    "./PhonecheckPanel.tsx",
    "./StoreMargin.tsx",
    "./marginLines.ts",
    "./StepTradeIn.tsx",
    "./LockedSummary.tsx",
    "./CaseWorkspace.tsx",
    "./StepRepair.tsx",
    "./StepUpgrade.tsx",
    "./StepNav.tsx",
    "./caseSteps.ts",
    "./gradingView.ts",
    "../report/GradingReportView.tsx",
    "../../app/r/[token]/page.tsx",
    "../../app/cases/[id]/report/page.tsx",
    "../../app/cases/[id]/receipt/page.tsx",
    "../../app/pickups/[id]/page.tsx",
  ];
  for (const f of files) assert.ok(!namesBrand(read(f)), `${f} names the partner's brand`);
});

/* ─────────────────────────── as rich as the store camera's own report (owner, 2026-10-17) ─────────────────────────── */

const DISP = (n: number) => `https://swapmore.com/apps/gradeiq/api/uploads/${GIQ_SESSION}-disp-1-${n}.jpg`;
const FAILED: CaseCameraCheck = {
  ...CAMERA,
  grade: null,
  status: "failed",
  final: false,
  by: "Asha K.",
  lcd: { cameraChecked: false, verdict: "unknown", reason: "captured 2 of 3 colours, AI reader off — check by eye", confirmed: false, captured: 2, requested: 3, aiOff: true },
};
const CERT = {
  screen: { value: "ok", label: "OK", by: "Asha K.", userId: "usr_a", at: AT, withColours: true, testSessionId: "ts_1", added: [], addedIssues: [] },
  body: { value: "scuffs", label: "Scuffs", by: "Asha K.", userId: "usr_a", at: AT, withColours: true, testSessionId: "ts_1", added: [], addedIssues: [] },
  liquid: { value: "clean", label: "Clean", by: "Asha K.", userId: "usr_a", at: AT, withColours: true, testSessionId: "ts_1", added: [], addedIssues: [] },
};
/** The four live cases after the advisor certified: photos taken but ungraded (AI out of credit), colours photographed but unread. */
function failedEnvelope(certified = true): ReportEnvelope {
  const display = {
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
  const results = allPass({ display: undefined as never });
  delete (results as Record<string, unknown>).display;
  return envelope(
    { camera: FAILED, evidence: [{ source: "swapup_check", results, at: AT }], certification: certified ? CERT : null, condition: { ...COND, screen: "flawless", body: "scuffed" } },
    {
      condition: { ...COND, screen: "flawless", body: "scuffed" },
      camera: {
        check: FAILED,
        findings: [],
        passportId: "DFX-7Q2K-91XA",
        photos: [0, 1, 2].map((n) => ({ url: `https://swapmore.com/apps/gradeiq/api/uploads/${GIQ_SESSION}-${n}.jpg`, label: null })),
        parts: null,
        signals: { stub: true, obstruction: false, retake: false, lowCoverage: false },
        display,
      },
      certification: certified ? CERT : null,
    }
  );
}

test("report view: the photos are on the page even when the camera couldn't grade — with who recorded the condition instead", () => {
  const v = reportView(failedEnvelope(), TOKEN);
  assert.deepEqual(v.camera.photos.map((p) => [p.label, p.src, p.marks.length]), [
    // Never the front glass: the phone's screen faces the camera for it (its scan code may be on it).
    ["Back", `/api/r/${TOKEN}/photo/0?v=3`, 0],
    ["Left side", `/api/r/${TOKEN}/photo/1?v=3`, 0],
  ]);
  assert.equal(v.camera.caption, "Not camera-graded — Asha K. recorded it by eye.");
  assert.equal(reportView(failedEnvelope(false), TOKEN).camera.caption, "The automatic grader is off.");
  // The record number shows because its photos are on the report.
  assert.ok(v.references.some((r) => r.label === "Store camera report"));
});

test("report view: a final grade's marks are boxed on their photo, coloured by how bad", () => {
  const env = envelope({}, { camera: { check: CAMERA, passportId: null, photos: [{ url: PHOTO, label: "Back" }], findings: [{ componentLabel: "back", type: "scratch", label: "Light scratches", meaning: "Visible scratches", severity: "moderate", effect: "condition", confirmed: true, photoUrl: PHOTO, box: [0.1, 0.2, 0.3, 0.6] }] } });
  const v = reportView(env, TOKEN);
  assert.deepEqual(v.camera.photos[0].marks, [{ top: 10, left: 20, height: 20, width: 40, tone: "warn", what: "Visible scratches" }]);
  assert.equal(v.camera.caption, null, "graded: nothing to explain");
});

test("report view: screen colours — each colour with its frame, the count, why it wasn't checked and who checked it by hand", () => {
  const v = reportView(failedEnvelope(), TOKEN);
  assert.deepEqual(v.screen!.colours.map((c) => [c.name, c.photo]), [
    ["White", `/api/r/${TOKEN}/photo/2?v=3`],
    ["Black", `/api/r/${TOKEN}/photo/3?v=3`],
    ["Red", null],
  ]);
  assert.equal(v.screen!.count, "2 of 3 colours photographed");
  // The advisor's look is said once, in "Certified by the advisor".
  assert.deepEqual(v.screen!.lines, ["Colours photographed; the automatic reader is off."]);
  assert.deepEqual(reportView(failedEnvelope(false), TOKEN).screen!.lines, ["Colours photographed; the automatic reader is off.", "Screen colours: not checked."]);
});

test("report view: what the advisor checked by hand sits under the grade, one line per row; the display line names them", () => {
  const v = reportView(failedEnvelope(), TOKEN);
  assert.equal(v.headline.label, "Good (B)", "certified screen OK + body scuffs, battery read: graded, final");
  assert.deepEqual(v.checked, [
    "Screen certified by Asha K.: no lines, spots, dead pixels or scratches, on the test colours.",
    "Body certified by Asha K.: light scuffs.",
    "Liquid indicator certified by Asha K.: not tripped.",
  ]);
  assert.deepEqual(v.tests.find((t) => t.id === "display")!.sources, ["Advisor Asha K., by eye on the test colours: passed"]);
  assert.equal(v.footer.checkedBy, null, "the certification box names who checked — not the footer again");
  // A fault a certification put on the case names who found it, by eye.
  const bent = envelope({ faults: ["frame_damage"], condition: { ...COND, body: "bent" } }, { faults: ["frame_damage"], faultSources: { frame_damage: ["camera_ai", "advisor"] }, certification: { body: { ...CERT.body, value: "bent", label: "Bent", added: ["frame_damage"] } } });
  assert.deepEqual(reportView(bent, TOKEN).faults, [{ label: "Bent / broken frame", sources: "Store camera, Asha K., by eye" }]);
  const json = JSON.stringify(v);
  for (const word of [/gemini/i, /gradeiq/i, /\b402\b/, /AI call failed/i, /unfold/i]) assert.ok(!word.test(json), `${word} must not reach the page`);
});

test("source words: the store camera's colour check and an advisor's look by eye say so", () => {
  assert.equal(sourceWord({ source: "swapup_check", outcome: "pass", via: "store_camera", at: AT }), "Store camera colour check: passed");
  assert.equal(sourceWord({ source: "advisor", outcome: "fail", by: "Ravi", at: AT }), "Advisor Ravi, by eye: failed");
});

test("report view: no store-camera photos — the photo section says why instead of staying blank", () => {
  const v = reportView(envelope({ camera: null, cameraComponents: [] }, { camera: { check: null, findings: [], passportId: null } }), TOKEN);
  assert.equal(v.camera.photos.length, 0);
  // One line says the camera wasn't there — no caption, no sweep line, no empty colour section.
  assert.equal(v.camera.summary, "The store camera didn't photograph this phone.");
  assert.equal(v.camera.caption, null);
  assert.equal(v.camera.lcd, null);
  assert.equal(v.screen, null);
});
