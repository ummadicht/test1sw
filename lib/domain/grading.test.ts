import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  grade,
  mergeEvidence,
  cosmeticGrade,
  gradeLetter,
  gradeWithLetter,
  gradingLabel,
  GRADE_LETTER,
  GRADING_RULESET_VERSION,
  LETTER_NOTE,
  SCALE_NOTE,
  type GradingCamera,
  type GradingInput,
  type TestEvidence,
  type Grading,
} from "./grading.ts";
import { DEFAULT_PLAN, batteryHealthResult, mergeCondition, type TestResults } from "./diagnostics.ts";
import { HEALTHY, type ConditionAnswers, type FaultId } from "./condition.ts";
import { gradeAfterRefurb, MARKET_GRADES } from "./marketSell.ts";
import { resultsWithCameraDisplay } from "./gradeiqMap.ts";
import { readPhonecheck, evidenceFromPhonecheck, pcFacts, PC_TEST_NAMES, PC_CAMERA_NAMES } from "./phonecheck.ts";
import { luhnCheckDigit } from "./imei.ts";

/* ─────────────────────────── fixture B (spec §2.6) ─────────────────────────── */

const AT = "2026-10-17T10:00:00.000Z";
const PC_AT = "2026-10-17T09:30:00.000Z";
/** Synthetic, Luhn-valid — never a real IMEI. */
const IMEI = "35000000000001" + luhnCheckDigit("35000000000001");

function allPass(over: Partial<TestResults> = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome: "pass", detail: null, at: AT };
  r.battery_health = batteryHealthResult(91, AT);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  }
  return r;
}
const fail = (detail: Record<string, unknown> | null = null) => ({ outcome: "fail" as const, detail, at: AT });
const skip = (detail: Record<string, unknown> | null = null) => ({ outcome: "skip" as const, detail, at: AT });

const COND: ConditionAnswers = { ...HEALTHY, issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };
const cond = (over: Partial<ConditionAnswers> = {}): ConditionAnswers => ({ ...COND, ...over });

const CAMERA: GradingCamera = {
  state: "ready",
  status: "final",
  final: true,
  gradeRange: null,
  conclusive: true,
  needsHumanReview: false,
  suggested: [],
  lcd: { cameraChecked: true, verdict: "pass", reason: null, confirmed: true },
  overrides: [],
  identity: { verdict: "match", reasons: [] },
  identityOverride: null,
};
const camera = (over: Partial<GradingCamera> = {}): GradingCamera => ({ ...CAMERA, ...over });

const swapup = (results: TestResults = allPass()): TestEvidence => ({ source: "swapup_check", results, at: AT });

function input(over: Partial<GradingInput> = {}): GradingInput {
  return {
    plan: DEFAULT_PLAN,
    evidence: [swapup()],
    condition: COND,
    faults: [],
    camera: CAMERA,
    cameraComponents: null,
    cameraOem: null,
    physicalDevice: true,
    browserRun: false,
    phonecheckImeiOverride: null,
    pcFacts: null,
    ...over,
  };
}

/** A Phonecheck record (DeNovo's field names) → evidence, through the real parser. */
function pcRecord(raw: Record<string, unknown>) {
  const r = readPhonecheck({ IMEI, UpdatedTimeStamp: "2026-10-17T13:30:00.00+04:00", ...raw });
  assert.ok(r.ok, "fixture record parses");
  return r.record;
}
function pc(raw: Record<string, unknown>, source: "phonecheck" | "phonecheck_upload" = "phonecheck"): TestEvidence {
  return evidenceFromPhonecheck(pcRecord(raw), source, PC_AT);
}

const codes = (g: Grading) => [...g.reasons, ...g.provisional, ...g.disclosures].map((r) => r.code);
const has = (g: Grading, code: string) => assert.ok(codes(g).includes(code), `expected ${code} in ${codes(g).join(",")}`);
const hasNot = (g: Grading, code: string) => assert.ok(!codes(g).includes(code), `did not expect ${code} in ${codes(g).join(",")}`);
const line = (g: Grading, id: string) => g.tests.find((l) => l.id === id)!;

/* ─────────────────────────── G1–G6: the cosmetic ladder ─────────────────────────── */

test("G1: B — graded Superb (A), final", () => {
  const g = grade(input());
  assert.equal(g.status, "graded");
  assert.equal(g.grade, "Superb");
  assert.equal(g.letter, "A");
  assert.equal(g.final, true);
  assert.equal(g.label, "Superb (A)");
  assert.equal(g.reasons[0].code, "G1");
  assert.deepEqual(g.provisional, []);
  assert.deepEqual(g.disclosures, []);
  assert.deepEqual(g.battery, { pct: 91, pass: true, readings: [{ pct: 91, source: "screenshot", at: AT }] });
});

test("G2–G6: screen and body set the grade, worse of the two", () => {
  const cases: [Partial<ConditionAnswers>, FaultId[], string, string][] = [
    [{ screen: "scratched" }, [], "Good", "B"],
    [{ body: "scuffed" }, [], "Good", "B"],
    [{ body: "dented" }, [], "Fair", "C"],
    [{ body: "bent" }, ["frame_damage"], "Best Value", "D"], // G5: frame_damage is cosmetic, not needs_repair
    [{ screen: "scratched", body: "dented" }, [], "Fair", "C"], // G6
  ];
  for (const [c, faults, want, letter] of cases) {
    const g = grade(input({ condition: cond(c), faults }));
    assert.equal(g.status, "graded", JSON.stringify(c));
    assert.equal(g.grade, want, JSON.stringify(c));
    assert.equal(g.letter, letter);
    assert.equal(g.label, `${want} (${letter})`);
    assert.equal(g.final, true);
  }
});

test("G1b: the grade is never better than the case's own faults — frame_damage on a 'flawless' body grades bent", () => {
  const g = grade(input({ faults: ["frame_damage"] }));
  assert.equal(g.status, "graded");
  assert.equal(g.grade, "Best Value");
  assert.equal(g.letter, "D");
  assert.match(g.reasons[0].text, /^Screen flawless, body bent or broken frame\.$/);
});

/* ─────────────────────────── G7–G15: needs repair ─────────────────────────── */

test("G7: mic fail + fault mic → needs repair, part mic, after repair Superb", () => {
  const g = grade(input({ evidence: [swapup(allPass({ mic: fail() }))], faults: ["mic"], condition: mergeCondition(COND, ["mic"]) }));
  assert.equal(g.status, "needs_repair");
  assert.equal(g.label, "Needs repair");
  assert.equal(g.grade, null);
  assert.equal(g.letter, null);
  assert.deepEqual(g.repairs, { faults: ["mic"], parts: ["mic"], inspection: [] });
  assert.equal(g.afterRepair, "Superb");
  has(g, "NR1");
  has(g, "NR2");
  hasNot(g, "DS6");
  assert.equal(g.reasons[0].code, "NR1");
  assert.match(g.reasons[0].text, /^Microphone failed on SwapUp Check\.$/);
});

test("G8: cracked screen → needs repair, after repair Superb", () => {
  const g = grade(input({ faults: ["screen_cracked"], condition: cond({ screen: "cracked" }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR2");
  has(g, "NR4");
  assert.deepEqual(g.repairs.parts, ["display"]);
  assert.equal(g.afterRepair, "Superb");
  assert.equal(g.cosmetic, null, "a cracked screen is on no SwapUp grade");
  assert.ok(g.reasons.some((r) => r.code === "NR4" && /^Screen: .+ — repair before grading\.$/.test(r.text)));
});

test("G9: cracked back → needs repair, after repair Good", () => {
  const g = grade(input({ faults: ["back_cracked"], condition: cond({ body: "back_cracked" }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR4");
  assert.equal(g.afterRepair, "Good");
});

test("G10: battery health 79 + battery_drain → needs repair, part battery", () => {
  const g = grade(input({ evidence: [swapup(allPass({ battery_health: batteryHealthResult(79, AT) }))], faults: ["battery_drain"], condition: mergeCondition(COND, ["battery_drain"]) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR6");
  assert.match(g.reasons.find((r) => r.code === "NR6")!.text, /^Battery health 79 % — under 80 %\.$/);
  assert.deepEqual(g.repairs.parts, ["battery"]);
  assert.equal(g.afterRepair, "Superb");
  assert.deepEqual(g.battery, { pct: 79, pass: false, readings: [{ pct: 79, source: "screenshot", at: AT }] });
});

test("G10b: an earlier sub-80 % screenshot of the same check still counts (the lowest reading stands)", () => {
  // A row stored before the lowest-reading rule: the 88 % replaced the 74 %, which sits in `earlier`.
  const stored = { outcome: "pass" as const, detail: { healthPct: 88, method: "battery screenshot read by GradeIQ", earlier: [74] }, at: AT };
  const g = grade(input({ evidence: [swapup(allPass({ battery_health: stored }))] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR6");
  assert.equal(g.battery.pct, 74);
  assert.equal(g.battery.pass, false);
  assert.notEqual(g.label, "Superb (A)");
});

test("G10c: no after-repair grade while key tests have no result (IC1)", () => {
  const g = grade(
    input({
      evidence: [swapup(allPass({ touch: undefined, mic: undefined, speaker: undefined, battery_health: batteryHealthResult(72, AT) }))],
      faults: ["battery_drain"],
      condition: mergeCondition(COND, ["battery_drain"]),
    })
  );
  assert.equal(g.status, "needs_repair");
  has(g, "IC1");
  assert.equal(g.afterRepair, null);
});

test("G11: battery health 80 is the line — graded Superb", () => {
  const g = grade(input({ evidence: [swapup(allPass({ battery_health: batteryHealthResult(80, AT) }))] }));
  assert.equal(g.status, "graded");
  assert.equal(g.grade, "Superb");
  assert.equal(g.final, true);
  assert.equal(g.battery.pass, true);
});

test("G12: battery health not read → Superb (A) · provisional", () => {
  const g = grade(input({ evidence: [swapup(allPass({ battery_health: batteryHealthResult(null, AT) }))] }));
  assert.equal(g.status, "graded");
  assert.equal(g.final, false);
  assert.equal(g.label, "Superb (A) · provisional");
  assert.equal(g.letter, "A");
  has(g, "PV5");
  assert.deepEqual(g.battery, { pct: null, pass: null, readings: [] });
});

test("G13: swollen battery → needs repair + safety disclosure", () => {
  const g = grade(input({ faults: ["battery_swollen"], condition: mergeCondition(COND, ["battery_swollen"]) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR8");
  has(g, "DS1");
  assert.equal(g.disclosures.find((d) => d.code === "DS1")!.text, "Swollen battery — do not charge; safety.");
});

test("G14: liquid damage → needs repair, inspection, no after-repair grade", () => {
  const g = grade(input({ faults: ["water_damage"], condition: cond({ issues: ["liquid"] }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR2");
  has(g, "NR5");
  assert.deepEqual(g.repairs.inspection, ["water_damage"]);
  assert.equal(g.afterRepair, null);
});

test("G15: doesn't switch on → needs repair, inspection [no_power]", () => {
  const g = grade(input({ faults: ["no_power"], condition: cond({ powersOn: false }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR3");
  assert.deepEqual(g.repairs.inspection, ["no_power"]);
  assert.equal(g.afterRepair, null);
});

/* ─────────────────────────── G16–G17: incomplete ─────────────────────────── */

test("G16: mic skipped → not fully tested, ceiling Superb, the reason names the microphone", () => {
  const g = grade(input({ evidence: [swapup(allPass({ mic: skip() }))] }));
  assert.equal(g.status, "incomplete");
  assert.equal(g.label, "Not fully tested");
  assert.equal(g.grade, null);
  assert.equal(g.letter, null);
  assert.equal(g.ceiling, "Superb");
  assert.equal(g.final, false);
  assert.equal(g.reasons[0].code, "IC1");
  assert.match(g.reasons[0].text, /Microphone/);
  assert.equal(line(g, "mic").result, "not_tested");
});

test("G17: mic skipped + speaker failed → needs repair; mic still listed as untested", () => {
  const g = grade(input({ evidence: [swapup(allPass({ mic: skip(), speaker: fail() }))] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR1");
  has(g, "IC1");
  assert.match(g.reasons.find((r) => r.code === "IC1")!.text, /Microphone/);
  assert.equal(g.ceiling, null, "ceiling only for incomplete");
});

/* ─────────────────────────── G18–G22: the camera, by-eye, note-only fails ─────────────────────────── */

test("G18: camera grade provisional → graded, provisional 'Camera grade not final.'", () => {
  const g = grade(input({ camera: camera({ status: "provisional", final: false }) }));
  assert.equal(g.status, "graded");
  assert.equal(g.final, false);
  assert.deepEqual(g.provisional, [{ code: "PV1", text: "Camera grade not final." }]);
});

test("G19: no camera → graded, provisional 'Not camera-graded…'", () => {
  const g = grade(input({ camera: null }));
  assert.equal(g.status, "graded");
  assert.equal(g.provisional[0].code, "PV1");
  assert.match(g.provisional[0].text, /^Not camera-graded — recorded by eye\.$/);
  const failed = grade(input({ camera: camera({ state: "failed", status: "failed", final: false }) }));
  assert.equal(failed.provisional[0].text, "Camera grading failed — recorded by eye.");
});

test("G20: camera not conclusive (B–C) → provisional, and the camera's letters never appear", () => {
  const g = grade(input({ camera: camera({ conclusive: false, gradeRange: { best: "B", worst: "C" } }) }));
  assert.equal(g.status, "graded");
  has(g, "PV2");
  assert.ok(!/B–C/.test(JSON.stringify(g)), "GradeIQ's letters would read as the SwapUp letter scale");
});

test("G21: camera suggested a bent frame not on the case → provisional", () => {
  const g = grade(input({ camera: camera({ suggested: [{ id: "frame_damage", because: "Camera saw a bend", photoIndex: 1, confidence: 0.9 }] }) }));
  has(g, "PV4");
  assert.equal(g.provisional.find((p) => p.code === "PV4")!.text, "Camera saw bent / broken frame — not on the case; check by eye.");
  // On the case already: nothing to check.
  const on = grade(input({ faults: ["frame_damage"], condition: cond({ body: "bent" }), camera: camera({ suggested: [{ id: "frame_damage", because: "x", photoIndex: 1, confidence: 0.9 }] }) }));
  hasNot(on, "PV4");
});

test("G22: flashlight failed → graded, provisional (not a SwapUp fault)", () => {
  const g = grade(input({ evidence: [swapup(allPass({ flash: fail() }))] }));
  assert.equal(g.status, "graded");
  assert.equal(g.final, false);
  assert.equal(g.provisional.find((p) => p.code === "PV6")!.text, "Flashlight failed — not a SwapUp fault; confirm by hand.");
});

test("G23: biometrics failed + fingerprint ticked → needs repair (the partner's issue)", () => {
  const g = grade(input({ evidence: [swapup(allPass({ faceid: fail() }))], condition: cond({ issues: ["fingerprint"] }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR5");
  hasNot(g, "PV6");
});

/* ─────────────────────────── G24–G26: can't grade, not tested ─────────────────────────── */

test("G24: emulator → can't grade", () => {
  const g = grade(input({ physicalDevice: false }));
  assert.equal(g.status, "cannot_grade");
  assert.equal(g.label, "Can't grade");
  assert.equal(g.reasons[0].code, "CG1");
  assert.equal(g.letter, null);
});

test("G25: identity mismatch → can't grade; a manager's override → graded + disclosure", () => {
  const mismatch = { verdict: "mismatch" as const, reasons: ["different model"] };
  const a = grade(input({ camera: camera({ identity: mismatch }) }));
  assert.equal(a.status, "cannot_grade");
  has(a, "CG3");
  const b = grade(input({ camera: camera({ identity: mismatch, identityOverride: { by: "Priya", userId: "u1", reason: "box and bill match", at: AT, items: ["identity"] } }) }));
  assert.equal(b.status, "graded");
  has(b, "DS5");
  assert.match(b.disclosures.find((d) => d.code === "DS5")!.text, /Priya checked it: box and bill match/);
});

test("G26: no evidence → not tested", () => {
  const g = grade(input({ evidence: [] }));
  assert.equal(g.status, "not_tested");
  assert.equal(g.label, "Not tested");
  assert.equal(g.reasons[0].code, "NT1");
  assert.equal(g.reasons[0].text, "Not tested yet.");
  hasNot(g, "IC1");
  assert.ok(g.tests.every((l) => l.result === "not_tested" && l.sources.length === 0));
});

/* ─────────────────────────── G27–G36: Phonecheck ─────────────────────────── */

const ALL_PC_PASSED = [...Object.entries(PC_TEST_NAMES).filter(([id]) => id !== "charging").map(([, n]) => n[0]), PC_CAMERA_NAMES.front[0], PC_CAMERA_NAMES.rear[0]];

test("G27: Phonecheck alone, every mapped test passed → not fully tested: it doesn't test the charging port", () => {
  const g = grade(input({ evidence: [pc({ Passed: ALL_PC_PASSED.join(","), BatteryHealthPercentage: "90", Working: "Yes" })] }));
  assert.equal(g.status, "incomplete");
  assert.equal(g.ceiling, "Superb");
  has(g, "IC1");
  assert.equal(g.reasons[0].text, "Not tested: Charging port.");
  assert.ok(g.reasons.some((r) => r.code === "IC2" && r.text === "Charging port: Phonecheck doesn't test the charging port."));
  assert.equal(line(g, "charging").result, "not_tested");
  assert.deepEqual(line(g, "charging").sources, []);
  assert.equal(line(g, "camera").result, "passed");
  assert.deepEqual(g.battery.readings, [{ pct: 90, source: "phonecheck", at: "2026-10-17T09:30:00.000Z" }]);
});

test("G28: SwapUp mic pass + Phonecheck 'Microphone' fail → needs repair; the line shows both", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Failed: "Microphone" })] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR1");
  assert.equal(g.reasons[0].text, "Microphone failed on Phonecheck.");
  const l = line(g, "mic");
  assert.equal(l.result, "failed");
  assert.deepEqual(
    l.sources.map((s) => [s.source, s.outcome]),
    [
      ["swapup_check", "pass"],
      ["phonecheck", "fail"],
    ]
  );
  assert.deepEqual(l.sources[1].names, ["Microphone"]);
  has(g, "DS6");
});

test("G29: SwapUp mic skipped + Phonecheck 'M-Microphone' passed → graded, marked manual", () => {
  const g = grade(input({ evidence: [swapup(allPass({ mic: skip() })), pc({ Passed: "M-Microphone" })] }));
  assert.equal(g.status, "graded");
  const s = line(g, "mic").sources.find((x) => x.source === "phonecheck")!;
  assert.equal(s.outcome, "pass");
  assert.equal(s.manual, true);
  assert.equal(line(g, "mic").result, "passed");
});

test("G30: Phonecheck 'Device Lock' failed, DeviceLock On → graded + activation-lock disclosure, not a test failure", () => {
  const rec = pcRecord({ Failed: "Device Lock", DeviceLock: "On", Working: "No" });
  const g = grade(input({ evidence: [swapup(), evidenceFromPhonecheck(rec, "phonecheck", PC_AT)], pcFacts: pcFacts(rec) }));
  assert.equal(g.status, "graded");
  has(g, "DS3");
  hasNot(g, "CG4");
  assert.equal(g.disclosures.find((d) => d.code === "DS3")!.text, "Activation lock on — the customer signs out before hand-over.");
});

test("G31: uploaded Phonecheck results → provisional", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Passed: "Microphone" }, "phonecheck_upload")] }));
  assert.equal(g.status, "graded");
  has(g, "PV7");
  hasNot(g, "PV12");
  assert.equal(g.label, "Superb (A) · provisional");
});

test("G31b: a Phonecheck report read by AI → provisional, both reasons", () => {
  const r = readPhonecheck({ IMEI, Passed: "Microphone", UpdatedTimeStamp: "2026-10-17T13:30:00+04:00" }, { aiRead: true });
  assert.ok(r.ok);
  const g = grade(input({ evidence: [swapup(), evidenceFromPhonecheck(r.record, "phonecheck_upload", PC_AT)] }));
  has(g, "PV7");
  assert.equal(g.provisional.find((p) => p.code === "PV12")!.text, "Phonecheck report read by AI — check the figures.");
  assert.equal(g.final, false);
});

test("G32: Phonecheck failed 'Glass Condition' with the screen recorded flawless → provisional", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Failed: "Glass Condition" })] }));
  assert.equal(g.status, "graded");
  has(g, "PV9");
  // The case records it: nothing to check.
  const ok = grade(input({ evidence: [swapup(), pc({ Failed: "Glass Condition" })], condition: cond({ screen: "scratched" }) }));
  hasNot(ok, "PV9");
});

test("G33: a part that isn't genuine → disclosure", () => {
  const g = grade(input({ pcFacts: { parts: "not_genuine", deviceLock: "off" } }));
  assert.equal(g.status, "graded");
  has(g, "DS2");
  const oem = grade(input({ cameraOem: "suspect_aftermarket" }));
  has(oem, "DS2");
});

test("G34: Phonecheck battery 76 + screenshot 82 → needs repair at 76, both readings kept", () => {
  const g = grade(input({ evidence: [swapup(allPass({ battery_health: batteryHealthResult(82, AT) })), pc({ BatteryHealthPercentage: "76" })] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR6");
  assert.equal(g.battery.pct, 76);
  assert.equal(g.battery.pass, false);
  assert.deepEqual(
    g.battery.readings.map((r) => [r.pct, r.source]),
    [
      [82, "screenshot"],
      [76, "phonecheck"],
    ]
  );
  assert.match(g.reasons.find((r) => r.code === "NR6")!.text, /^Battery health 76 % — under 80 %\.$/);
});

test("G35: Phonecheck Working No with nothing failed → can't grade", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Working: "No", Passed: "Microphone" })] }));
  assert.equal(g.status, "cannot_grade");
  has(g, "CG4");
});

test("G36: Phonecheck with only Battery Drain pending → graded; Phonecheck's battery line reads pending", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Pending: "Battery Drain" })] }));
  assert.equal(g.status, "graded");
  assert.equal(g.final, true);
  const s = line(g, "battery").sources.find((x) => x.source === "phonecheck")!;
  assert.equal(s.outcome, "pending");
  assert.equal(line(g, "battery").result, "passed", "SwapUp Check's pass stands");
});

/* ─────────────────────────── G37–G40 ─────────────────────────── */

test("G37: mic failed but the case has no mic fault → needs repair + disclosure", () => {
  const g = grade(input({ evidence: [swapup(allPass({ mic: fail() }))] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR1");
  assert.equal(g.disclosures.find((d) => d.code === "DS6")!.text, "Microphone failed; fault not on the case (microphone faulty).");
  assert.equal(g.afterRepair, null, "an unrecorded failure can't be repaired on paper");
});

test("G38: a weak camera screen-sweep fail folded to skip, no self-test → not fully tested", () => {
  const lcd = { cameraChecked: true, verdict: "fail" as const, reason: null, confirmed: false, doubt: "the screen sweep saw only minor marks" };
  const results = resultsWithCameraDisplay(allPass({ display: undefined }), lcd, AT);
  assert.equal(results.display.outcome, "skip");
  const g = grade(input({ evidence: [swapup(results)], camera: camera({ lcd }) }));
  assert.equal(g.status, "incomplete");
  has(g, "IC1");
  assert.equal(g.reasons[0].text, "Not tested: Display / dead pixels.");
  assert.ok(g.reasons.some((r) => r.code === "IC2" && /^Display \/ dead pixels: the screen sweep saw only minor marks — check the display by eye\.$/.test(r.text)));
  hasNot(g, "PV11");
});

test("G39: condition not recorded → can't grade", () => {
  const g = grade(input({ condition: null }));
  assert.equal(g.status, "cannot_grade");
  has(g, "CG2");
  assert.equal(g.cosmetic, null);
});

test("G40: advisor recorded better than the camera saw → disclosure", () => {
  const g = grade(input({ camera: camera({ overrides: [{ by: "Ravi", userId: "u2", reason: "smudge, not a scratch", at: AT, items: ["screen:scratched"] }] }) }));
  assert.equal(g.status, "graded");
  assert.equal(g.disclosures.find((d) => d.code === "DS4")!.text, "Recorded better than the camera saw, by Ravi: smudge, not a scratch");
});

/* ─────────────────────────── G41–G43: the contract ─────────────────────────── */

test("G41: every grading names its ruleset", () => {
  for (const i of [input(), input({ evidence: [] }), input({ condition: null }), input({ faults: ["mic"] })]) assert.equal(grade(i).ruleset, GRADING_RULESET_VERSION);
});

test("G42: deterministic — the same input with its keys reordered grades the same", () => {
  const i = input({ evidence: [swapup(allPass({ flash: fail() })), pc({ Passed: "Microphone,Rear Camera", Failed: "Glass Condition", BatteryHealthPercentage: "88" })], faults: ["mic", "battery_drain"], condition: cond({ issues: ["mic", "battery"] }) });
  const rev = <T>(o: T): T =>
    Array.isArray(o) ? (o.map(rev) as T) : o && typeof o === "object" ? (Object.fromEntries(Object.entries(o as object).reverse().map(([k, v]) => [k, rev(v)])) as T) : o;
  const reordered = rev(i);
  assert.notDeepEqual(Object.keys(reordered), Object.keys(i));
  assert.deepEqual(grade(reordered), grade(i));
  assert.deepEqual(grade(input({ faults: ["mic", "battery_drain"] })), grade(input({ faults: ["battery_drain", "mic"] })), "fault order doesn't matter");
});

test("G43: every on-ladder condition grades exactly as gradeAfterRefurb", () => {
  for (const screen of ["flawless", "scratched"] as const)
    for (const body of ["flawless", "scuffed", "dented", "bent"] as const) {
      const c = cond({ screen, body });
      const g = grade(input({ condition: c, faults: body === "bent" ? ["frame_damage"] : [] }));
      assert.equal(g.status, "graded", `${screen}/${body}`);
      assert.equal(g.grade, gradeAfterRefurb(c), `${screen}/${body}`);
      assert.equal(g.cosmetic, cosmeticGrade(c));
    }
});

/* ─────────────────────────── G44–G48 ─────────────────────────── */

test("G44: lines on the screen with no fault recorded → needs repair", () => {
  const g = grade(input({ condition: cond({ screen: "lines_or_spots" }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR4");
  assert.equal(g.afterRepair, null, "no recorded fault, so no part says the screen is fixed");
});

test("G45: calls don't work → needs repair", () => {
  const g = grade(input({ condition: cond({ calls: false }) }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR3");
});

test("G46: multi-touch failed → needs repair", () => {
  const g = grade(input({ evidence: [swapup(allPass({ multitouch: fail() }))] }));
  assert.equal(g.status, "needs_repair");
  has(g, "NR7");
  hasNot(g, "NR1");
});

test("G47: final camera rated the front glass C while the grade is Good → provisional, letter unchanged", () => {
  const g = grade(input({ condition: cond({ screen: "scratched" }), cameraComponents: [{ id: "front", grade: "C" }, { id: "cameras", grade: "D" }] }));
  assert.equal(g.status, "graded");
  assert.equal(g.grade, "Good");
  assert.equal(g.letter, "B", "the letter is the SwapUp grade's, never the camera's");
  const pv10 = g.provisional.filter((p) => p.code === "PV10");
  assert.equal(pv10.length, 1, "lenses are not front/back/frame");
  assert.equal(pv10[0].text, "Camera rated the front glass low — check by eye.");
  // Fair or worse already: nothing to warn about.
  hasNot(grade(input({ condition: cond({ body: "dented" }), cameraComponents: [{ id: "frame", grade: "D" }] })), "PV10");
});

test("G48: camera sweep failed unconfirmed, display self-test passed → provisional", () => {
  const lcd = { cameraChecked: true, verdict: "fail" as const, reason: null, confirmed: false, doubt: "the screen sweep saw only minor marks (faint line)" };
  const g = grade(input({ camera: camera({ lcd }) }));
  assert.equal(g.status, "graded");
  assert.equal(g.provisional.find((p) => p.code === "PV11")!.text, "The screen sweep saw only minor marks (faint line); display test passed — check by eye.");
});

/* ─────────────────────────── G49: the grade never prices ─────────────────────────── */

test("G49: nothing that prices imports the grade", () => {
  for (const f of ["offer.ts", "decision.ts", "bonus.ts", "ratecard.ts", "buySell.ts", "upgrade.ts", "marketSell.ts", "repair.ts", "credit.ts", "priceiqTradeIn.ts", "premium.ts", "answer.ts"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.ok(!/from\s+["']\.\/(grading|gradingReport|phonecheck)(\.ts)?["']/.test(src), `${f} must not import the grading engine`);
  }
});

/* ─────────────────────────── both scales (owner, 2026-10-17) ─────────────────────────── */

test("letter: a strict one-to-one translation of the SwapUp grade", () => {
  assert.deepEqual(GRADE_LETTER, { Superb: "A", Good: "B", Fair: "C", "Best Value": "D" });
  assert.deepEqual(MARKET_GRADES.map((g) => gradeLetter(g)), ["A", "B", "C", "D"]);
  assert.equal(gradeLetter(null), null);
  assert.equal(gradeWithLetter("Best Value"), "Best Value (D)");
  assert.equal(gradeWithLetter(null), null);
  assert.equal(new Set(Object.values(GRADE_LETTER)).size, 4, "one letter per grade");
  assert.equal(LETTER_NOTE, "A = Superb, B = Good, C = Fair, D = Best Value — not CTIA.");
  assert.equal(SCALE_NOTE, "SwapUp grade, as tested at the store — not the buyer's own inspection.");
});

test("letter: null whenever the SwapUp grade is null — even with a cosmetic grade worked out", () => {
  const notGraded = [
    grade(input({ evidence: [] })),
    grade(input({ physicalDevice: false })),
    grade(input({ faults: ["mic"] })),
    grade(input({ evidence: [swapup(allPass({ mic: skip() }))] })),
  ];
  for (const g of notGraded) {
    assert.notEqual(g.status, "graded");
    assert.equal(g.grade, null);
    assert.equal(g.letter, null);
    assert.ok(!/\([ABCD]\)/.test(g.label), g.label);
  }
  assert.equal(notGraded[3].cosmetic, "Superb", "cosmetic is still worked out, but it is not the grade");
});

test("labels: both scales, provisional marked", () => {
  assert.equal(gradingLabel("graded", "Good", true), "Good (B)");
  assert.equal(gradingLabel("graded", "Good", false), "Good (B) · provisional");
  assert.equal(gradingLabel("needs_repair", null, false), "Needs repair");
  assert.equal(gradingLabel("incomplete", null, false), "Not fully tested");
  assert.equal(gradingLabel("cannot_grade", null, false), "Can't grade");
  assert.equal(gradingLabel("not_tested", null, false), "Not tested");
  assert.ok(!/ctia/i.test(JSON.stringify(grade(input({ condition: cond({ screen: "scratched" }) })))), "the grading itself never says CTIA");
});

/* ─────────────────────────── merging ─────────────────────────── */

test("merge: worse-of — fail beats pass beats skip; unsupported everywhere is 'not on this phone'", () => {
  const plan = [
    { id: "a", name: "A", critical: true },
    { id: "b", name: "B", critical: false },
    { id: "c", name: "C", critical: false },
    { id: "d", name: "D", critical: false },
    { id: "e", name: "E", critical: false },
  ];
  const r = (outcome: "pass" | "fail" | "skip" | "unsupported") => ({ outcome, detail: null, at: AT });
  const m = mergeEvidence(plan, [
    { source: "swapup_check", results: { a: r("pass"), b: r("skip"), c: r("unsupported"), d: r("unsupported") }, at: AT },
    { source: "phonecheck", results: { a: r("fail"), b: r("pass"), c: r("unsupported"), d: r("skip") }, at: AT },
  ]);
  assert.deepEqual(
    m.lines.map((l) => [l.id, l.result]),
    [
      ["a", "failed"],
      ["b", "passed"],
      ["c", "not_on_phone"],
      ["d", "not_tested"],
      ["e", "not_tested"],
    ]
  );
  assert.equal(m.results.a.outcome, "fail");
  assert.equal(m.results.e, undefined, "no source, no result");
});

test("merge: a failed camera's side is the union of the sides that failed", () => {
  const plan = [{ id: "camera", name: "Cameras (front + rear)", critical: true }];
  const m = mergeEvidence(plan, [
    { source: "swapup_check", results: { camera: fail({ side: "front" }) }, at: AT },
    { source: "phonecheck", results: { camera: fail({ side: "rear" }) }, at: AT },
  ]);
  assert.equal(m.results.camera.detail!.side, "both");
  const g = grade(input({ evidence: [swapup(allPass({ camera: fail({ side: "front" }) })), pc({ Failed: "Rear Camera" })] }));
  assert.match(g.reasons[0].text, /^Front and rear cameras failed on SwapUp Check and Phonecheck\.$/);
  assert.equal(g.disclosures.filter((d) => d.code === "DS6").length, 2, "neither camera fault recorded");
});

/* ─────────────────────────── the rest of the rules ─────────────────────────── */

test("PV8: a Phonecheck record attached despite a different IMEI → provisional", () => {
  const g = grade(input({ phonecheckImeiOverride: { by: "Priya", userId: "u1", reason: "IMEI 2 printed on the box", at: AT, items: ["imei"] } }));
  assert.equal(g.status, "graded");
  assert.match(g.provisional.find((p) => p.code === "PV8")!.text, /attached by Priya: IMEI 2 printed on the box/);
});

test("PV6: a Phonecheck test SwapUp has no id for, failed → provisional, verbatim", () => {
  const g = grade(input({ evidence: [swapup(), pc({ Failed: "True Tone", Passed: "Wireless Charging" })] }));
  assert.equal(g.status, "graded");
  assert.equal(g.provisional.find((p) => p.code === "PV6")!.text, "True Tone failed on Phonecheck — not a SwapUp fault; confirm by hand.");
  assert.deepEqual(g.otherTests, [
    { name: "True Tone", result: "failed", source: "phonecheck", manual: false },
    { name: "Wireless Charging", result: "passed", source: "phonecheck", manual: false },
  ]);
  assert.equal(line(g, "charging").sources.length, 1, "Wireless Charging is not the charging port");
});

test("DS7 + DS8: browser run and a Phonecheck model that disagrees are disclosed, the grade stands", () => {
  const g = grade(input({ browserRun: true, pcModelMismatch: { phonecheck: "Galaxy S23", case: "Galaxy S22" } }));
  assert.equal(g.status, "graded");
  has(g, "DS7");
  assert.equal(g.disclosures.find((d) => d.code === "DS8")!.text, "Phonecheck says Galaxy S23; case says Galaxy S22 — case kept.");
});

test("reasons[0] follows status precedence: not tested > can't grade > needs repair > incomplete", () => {
  const g = grade(input({ physicalDevice: false, faults: ["mic"], evidence: [swapup(allPass({ mic: skip() }))] }));
  assert.equal(g.status, "cannot_grade");
  assert.deepEqual(
    g.reasons.map((r) => r.code),
    ["CG1", "NR2", "IC1"]
  );
});

test("an empty plan reads as DEFAULT_PLAN", () => {
  assert.deepEqual(grade(input({ plan: [] })), grade(input()));
});

test("IC1: the one-line why is short — the names, at most three; each test's own reason is a line of its own behind Show details", () => {
  const g = grade(
    input({
      evidence: [
        swapup(
          allPass({
            display: skip({ reason: "not camera-checked: the advisor went on without the camera" }),
            charging: skip({ reason: "no charger was plugged in within 45 s" }),
          })
        ),
      ],
    })
  );
  assert.equal(g.reasons[0].text, "Not tested: Display / dead pixels and Charging port.");
  assert.ok(g.reasons[0].text.split(/\s+/).length <= 15);
  assert.deepEqual(
    g.reasons.filter((r) => r.code === "IC2").map((r) => r.text),
    ["Display / dead pixels: not camera-checked: the advisor went on without the camera.", "Charging port: no charger was plugged in within 45 s."]
  );
  const many = grade(input({ evidence: [swapup(allPass({ touch: undefined, mic: undefined, speaker: undefined, charging: undefined }))] }));
  assert.match(many.reasons[0].text, /^Not tested: .+, .+ and 2 more\.$/);
});
