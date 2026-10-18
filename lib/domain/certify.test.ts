import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CERT_ROWS,
  certChoices,
  certifyNeeded,
  certifySignals,
  certifyRow,
  certSentence,
  readCertification,
  withCertification,
  type Certification,
  type CertifyState,
  type CertifyInput,
  type CertifyResult,
} from "./certify.ts";
import { grade, type GradingCamera, type GradingInput, type TestEvidence } from "./grading.ts";
import { DEFAULT_PLAN, batteryHealthResult, mergeCondition, type TestResults } from "./diagnostics.ts";
import { HEALTHY, conditionFloor, type ConditionAnswers } from "./condition.ts";
import { NO_FLOOR } from "./gradeiqMap.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const AT = "2026-10-17T10:00:00.000Z";
const COND: ConditionAnswers = { ...HEALTHY, issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };
const state = (over: Partial<CertifyState> = {}): CertifyState => ({ faults: [], sources: {}, condition: COND, cameraFloor: null, certification: {}, ...over });
const tap = (row: CertifyInput["row"], value: string, over: Partial<CertifyInput> = {}): CertifyInput => ({ row, value, by: "Asha K.", userId: "usr_a", at: AT, withColours: true, testSessionId: "ts_1", ...over });
function ok(r: CertifyResult | { error: string }): CertifyResult {
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r as CertifyResult;
}
/** Apply a result as the next state. */
const next = (s: CertifyState, r: CertifyResult): CertifyState => ({ ...s, faults: r.faults, sources: r.sources, condition: r.condition, certification: r.certification });

/* ─────────────────────────── the card ─────────────────────────── */

test("the card: three rows, one tap each, the chips in order", () => {
  assert.deepEqual([...CERT_ROWS], ["screen", "body", "liquid"]);
  assert.deepEqual(certChoices("screen").map((c) => c.label), ["OK", "Scratches", "Lines or spots", "Cracked"]);
  assert.deepEqual(certChoices("body").map((c) => c.label), ["Like new", "Scuffs", "Dents", "Back cracked", "Bent"]);
  assert.deepEqual(certChoices("liquid").map((c) => c.label), ["Clean", "Tripped", "Can't see"]);
  const bad = certifyRow(state(), tap("screen", "perfect"));
  assert.deepEqual(bad, { error: "Tap one of: OK, Scratches, Lines or spots, Cracked." });
});

test("which rows: the screen when the sweep didn't check it or the grade isn't final; the body when the grade isn't final; liquid on that same card — none when the camera decided", () => {
  assert.deepEqual(certifyNeeded(null), ["screen", "body", "liquid"]);
  assert.deepEqual(certifyNeeded({ final: true, lcdChecked: true }), [], "the camera decided it all: no card, no liquid row");
  assert.deepEqual(certifyNeeded({ final: true, lcdChecked: false }), ["screen", "liquid"]);
  assert.deepEqual(certifyNeeded({ final: false, lcdChecked: true }), ["screen", "body", "liquid"]);
});

test("which rows: every final-grade signal the SwapUp grade clears only with a look asks for its row (certifySignals)", () => {
  const F = { final: true, lcdChecked: true };
  // A sweep fail it isn't sure of (IC1 "check the display by eye" / PV11) → the screen.
  assert.deepEqual(certifyNeeded({ ...F, lcdDoubt: true }), ["screen", "liquid"]);
  // Not conclusive (PV2) / needs a review (PV3) → both.
  assert.deepEqual(certifyNeeded({ ...F, conclusive: false }), ["screen", "body", "liquid"]);
  assert.deepEqual(certifyNeeded({ ...F, needsHumanReview: true }), ["screen", "body", "liquid"]);
  // A part rated low (PV10): the front → the screen; the back or frame → the body.
  assert.deepEqual(certifyNeeded({ ...F, lowParts: ["front"] }), ["screen", "liquid"]);
  assert.deepEqual(certifyNeeded({ ...F, lowParts: ["frame"] }), ["body", "liquid"]);
  // A suggested cracked back or bent frame not on the case (PV4) → the body.
  assert.deepEqual(certifyNeeded({ ...F, suggestedBody: true }), ["body", "liquid"]);
  // Read off what the camera recorded.
  const sig = certifySignals({
    final: true,
    lcd: { cameraChecked: true, verdict: "fail", confirmed: false },
    conclusive: true,
    needsHumanReview: false,
    suggested: [{ id: "back_cracked" }, { id: "rear_camera" }],
    components: [{ id: "front", grade: "B" }, { id: "back", grade: "C" }],
    faults: [],
  });
  assert.deepEqual(sig, { final: true, lcdChecked: true, lcdDoubt: true, conclusive: true, needsHumanReview: false, lowParts: ["back"], suggestedBody: true });
  assert.equal(certifySignals({ final: true, lcd: { cameraChecked: true, verdict: "pass" }, conclusive: true, needsHumanReview: false, suggested: [{ id: "back_cracked" }], faults: ["back_cracked"] }).suggestedBody, false, "already on the case");
  // A part's letter counts only from a FINAL grade.
  assert.deepEqual(certifySignals({ final: false, lcd: { cameraChecked: true, verdict: "pass" }, conclusive: null, needsHumanReview: false, suggested: [], components: [{ id: "front", grade: "D" }], faults: [] }).lowParts, []);
});

/* ─────────────────────────── one tap on the case ─────────────────────────── */

test("screen OK → flawless, no fault; Lines or spots → display_lines, source advisor; back to OK takes it off again", () => {
  let s = state({ condition: { ...COND, screen: "scratched" } });
  const a = ok(certifyRow(s, tap("screen", "ok")));
  assert.equal(a.changed, true);
  assert.equal(a.condition!.screen, "flawless", "the certification is the advisor's latest word");
  assert.deepEqual(a.faults, []);
  s = next(s, a);
  const b = ok(certifyRow(s, tap("screen", "lines")));
  assert.deepEqual(b.faults, ["display_lines"]);
  assert.deepEqual(b.sources, { display_lines: ["advisor"] });
  assert.equal(b.condition!.screen, "lines_or_spots");
  assert.deepEqual(b.certification.screen?.added, ["display_lines"]);
  assert.deepEqual(b.faultsAdded, ["display_lines"]);
  s = next(s, b);
  const c = ok(certifyRow(s, tap("screen", "ok")));
  assert.deepEqual(c.faults, []);
  assert.deepEqual(c.faultsRemoved, ["display_lines"]);
  assert.deepEqual(c.sources, {});
  assert.equal(c.condition!.screen, "flawless");
  assert.deepEqual(conditionFloor(c.condition!, c.faults), []);
});

test("a fault the phone's own test also found stays when the row changes — and keeps the screen at its floor", () => {
  const s = state({ faults: ["display_lines"], sources: { display_lines: ["tested"] }, condition: { ...COND, screen: "lines_or_spots" } });
  const a = ok(certifyRow(s, tap("screen", "lines")));
  assert.deepEqual(a.faults, ["display_lines"]);
  assert.deepEqual(a.certification.screen?.added, [], "it was already on the case — not this row's");
  const b = ok(certifyRow(next(s, a), tap("screen", "ok")));
  assert.deepEqual(b.faults, ["display_lines"], "the test's fault stays");
  assert.equal(b.condition!.screen, "lines_or_spots", "never better than the faults allow");
});

test("the same tap twice changes nothing; the same tap once the colours are showing upgrades it", () => {
  const s0 = state();
  const a = ok(certifyRow(s0, tap("screen", "ok", { withColours: false })));
  const s1 = next(s0, a);
  const again = ok(certifyRow(s1, tap("screen", "ok", { withColours: false })));
  assert.equal(again.changed, false);
  const colours = ok(certifyRow(s1, tap("screen", "ok", { withColours: true, by: "Ravi" })));
  assert.equal(colours.changed, true);
  assert.equal(colours.certification.screen?.withColours, true);
  assert.equal(colours.certification.screen?.by, "Ravi");
});

test("never better than the store camera confirmed: a camera-confirmed scratch keeps the screen scratched", () => {
  const a = ok(certifyRow(state({ cameraFloor: { ...NO_FLOOR, screen: "scratched" } }), tap("screen", "ok")));
  assert.equal(a.condition!.screen, "scratched");
  assert.equal(a.certification.screen?.value, "ok", "what the advisor tapped is still recorded as tapped");
});

test("body: Bent → frame_damage; Back cracked → back_cracked; Like new afterwards takes this row's faults off", () => {
  let s = state();
  const bent = ok(certifyRow(s, tap("body", "bent")));
  assert.deepEqual(bent.faults, ["frame_damage"]);
  assert.equal(bent.condition!.body, "bent");
  s = next(s, bent);
  const back = ok(certifyRow(s, tap("body", "back_cracked")));
  assert.deepEqual(back.faults, ["back_cracked"]);
  assert.deepEqual(back.faultsRemoved, ["frame_damage"]);
  assert.equal(back.condition!.body, "back_cracked");
  s = next(s, back);
  const fine = ok(certifyRow(s, tap("body", "like_new")));
  assert.deepEqual(fine.faults, []);
  assert.equal(fine.condition!.body, "flawless");
  assert.equal(ok(certifyRow(s, tap("body", "scuffs"))).condition!.body, "scuffed");
  assert.equal(ok(certifyRow(s, tap("body", "dents"))).condition!.body, "dented");
});

test("liquid: Tripped → water_damage and the liquid issue; Clean takes both off; an advisor's own liquid tick stays", () => {
  let s = state();
  const t = ok(certifyRow(s, tap("liquid", "tripped")));
  assert.deepEqual(t.faults, ["water_damage"]);
  assert.deepEqual(t.condition!.issues, ["liquid"]);
  assert.deepEqual(t.certification.liquid?.addedIssues, ["liquid"]);
  s = next(s, t);
  const c = ok(certifyRow(s, tap("liquid", "clean")));
  assert.deepEqual(c.faults, []);
  assert.deepEqual(c.condition!.issues, []);
  // Already ticked by hand before the tap: the tap didn't add it, so Clean leaves it.
  const own = state({ condition: { ...COND, issues: ["liquid"] } });
  const t2 = ok(certifyRow(own, tap("liquid", "tripped")));
  assert.deepEqual(t2.certification.liquid?.addedIssues, []);
  assert.deepEqual(ok(certifyRow(next(own, t2), tap("liquid", "clean"))).condition!.issues, ["liquid"]);
  assert.deepEqual(ok(certifyRow(s, tap("liquid", "cant_see"))).faults, []);
});

test("before Apply: no condition yet → the tap never invents one; Apply folds the certification in, and its merge keeps it", () => {
  const a = ok(certifyRow(state({ condition: null }), tap("body", "scuffs")));
  assert.equal(a.condition, null, "nobody looked at the rest of the condition yet");
  assert.deepEqual(a.faults, []);
  const bent = ok(certifyRow(state({ condition: null }), tap("body", "bent")));
  assert.equal(bent.condition, null);
  assert.deepEqual(bent.faults, ["frame_damage"], "the fault goes on at once");
  // Apply: the tests merged in (mergeCondition makes one from SwapUp's usual base), then the certification.
  const applied = withCertification(mergeCondition(null, ["mic"]), a.certification, ["mic"], NO_FLOOR);
  assert.equal(applied.body, "scuffed");
  assert.deepEqual(applied.issues, ["mic"]);
  // Never better than the camera confirmed.
  assert.equal(withCertification(mergeCondition(null, []), a.certification, [], { screen: "flawless", body: "dented" }).body, "dented");
  // A certification after Apply: the advisor's own earlier answer is replaced, the faults' floor stays.
  const after = ok(certifyRow(state({ condition: { ...COND, body: "dented" } }), tap("body", "scuffs")));
  assert.equal(after.condition!.body, "scuffed");
});

test("stored certifications read back defensively — a row that doesn't read is dropped, never guessed", () => {
  const good = ok(certifyRow(state(), tap("screen", "scratches"))).certification;
  assert.deepEqual(readCertification(JSON.parse(JSON.stringify(good))), good);
  assert.deepEqual(readCertification({ screen: { value: "perfect", by: "x", at: AT }, body: { value: "scuffs", at: AT }, liquid: "clean" }), {});
  assert.deepEqual(readCertification(null), {});
  assert.deepEqual(readCertification({ body: { value: "bent", by: "Ravi", at: AT, added: ["frame_damage", "nonsense"] } }).body?.added, ["frame_damage"]);
});

test("in words: one plain line per row, the colours named only when they were showing", () => {
  assert.equal(certSentence("screen", { value: "ok", by: "Asha K.", withColours: true }), "Screen certified by Asha K.: no lines, spots, dead pixels or scratches, on the test colours.");
  assert.equal(certSentence("screen", { value: "ok", by: "Asha K.", withColours: false }), "Screen certified by Asha K.: no lines, spots, dead pixels or scratches.");
  assert.equal(certSentence("screen", { value: "cracked", by: "Asha K.", withColours: true }), "Screen certified by Asha K.: cracked glass.");
  assert.equal(certSentence("body", { value: "scuffs", by: "Ravi", withColours: false }), "Body certified by Ravi: light scuffs.");
  assert.equal(certSentence("liquid", { value: "clean", by: "Ravi", withColours: false }), "Liquid indicator certified by Ravi: not tripped.");
  assert.equal(certSentence("liquid", { value: "cant_see", by: "Ravi", withColours: false }), "Liquid indicator: Ravi couldn't see it.");
});

/* ─────────────────────────── what the grade makes of it ─────────────────────────── */

function allPass(over: Partial<Record<string, TestResults[string] | undefined>> = {}): TestResults {
  const r: TestResults = {};
  for (const p of DEFAULT_PLAN) r[p.id] = { outcome: "pass", detail: null, at: AT };
  r.battery_health = batteryHealthResult(91, AT);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  }
  return r;
}
const swapup = (results: TestResults): TestEvidence => ({ source: "swapup_check", results, at: AT });
/** The four live cases: GradeIQ's AI out of credit — camera grading "failed", no LCD sweep, display untested. */
const FAILED: GradingCamera = {
  state: "ready",
  status: "failed",
  final: false,
  gradeRange: null,
  conclusive: null,
  needsHumanReview: false,
  suggested: [],
  lcd: { cameraChecked: false, verdict: null, reason: "the camera never got a clear view of the lit screen" },
  overrides: [],
  identity: { verdict: "unverified", reasons: [] },
  identityOverride: null,
};
function input(over: Partial<GradingInput> = {}): GradingInput {
  return {
    plan: DEFAULT_PLAN,
    evidence: [swapup(allPass({ display: undefined }))],
    condition: COND,
    faults: [],
    camera: FAILED,
    cameraComponents: null,
    cameraOem: null,
    physicalDevice: true,
    browserRun: false,
    phonecheckImeiOverride: null,
    pcFacts: null,
    ...over,
  };
}
function certified(rows: Partial<Record<"screen" | "body" | "liquid", [string, boolean?]>>): Certification {
  let s = state();
  for (const [row, [value, colours]] of Object.entries(rows) as [CertifyInput["row"], [string, boolean?]][]) s = next(s, ok(certifyRow(s, tap(row, value, { withColours: colours ?? true }))));
  return s.certification;
}
const codes = (g: ReturnType<typeof grade>) => [...g.reasons, ...g.provisional, ...g.disclosures].map((r) => r.code);

test("C1: the live cases — no sweep, no camera grade: not fully tested, the display untested", () => {
  const g = grade(input());
  assert.equal(g.status, "incomplete");
  assert.equal(g.label, "Not fully tested");
  assert.match(g.reasons[0].text, /Display \/ dead pixels/);
});

test("C2: the advisor certifies screen OK on the colours, body and liquid → graded; the display line names the advisor", () => {
  const cert = certified({ screen: ["ok"], body: ["like_new"], liquid: ["clean"] });
  const g = grade(input({ certification: cert }));
  assert.equal(g.status, "graded");
  assert.equal(g.grade, "Superb");
  assert.equal(g.final, true, "battery read, both rows certified on the colours: nothing left to check by hand");
  const display = g.tests.find((l) => l.id === "display")!;
  assert.equal(display.result, "passed");
  assert.deepEqual(display.sources.map((s) => [s.source, s.outcome, s.by, s.colours, s.manual]), [["advisor", "pass", "Asha K.", true, true]]);
  assert.ok(!codes(g).includes("PV1"));
});

test("C3: only the screen certified → the body is still to check (PV1 names it)", () => {
  const g = grade(input({ certification: certified({ screen: ["ok"] }) }));
  assert.equal(g.status, "graded");
  assert.deepEqual(g.provisional.map((p) => p.text), ["Body not camera-graded or certified."]);
});

test("C4: certified without the test colours → provisional PV13; Lines or spots → needs repair on the advisor's check", () => {
  const g = grade(input({ certification: certified({ screen: ["ok", false], body: ["like_new"] }) }));
  assert.equal(g.status, "graded");
  assert.equal(g.provisional.find((p) => p.code === "PV13")?.text, "Screen certified by Asha K. without the test colours.");
  // The camera's sweep already checked the colours (only its cosmetic grade isn't final): no PV13 — nothing rests on the look alone.
  const swept = grade(input({ camera: { ...FAILED, status: "provisional", lcd: { cameraChecked: true, verdict: "pass", reason: null, confirmed: true } }, certification: certified({ screen: ["ok", false], body: ["like_new"] }) }));
  assert.ok(!swept.provisional.some((p) => p.code === "PV13"), JSON.stringify(swept.provisional));
  const lines = grade(input({ certification: certified({ screen: ["lines"] }), faults: ["display_lines"], condition: { ...COND, screen: "lines_or_spots" } }));
  assert.equal(lines.status, "needs_repair");
  assert.ok(lines.reasons.some((r) => r.code === "NR1" && /Display \/ dead pixels failed on Asha K\.'s check by eye/.test(r.text)), JSON.stringify(lines.reasons));
});

test("C5: a certification never stands in for a test — with no test at all the phone is still not tested", () => {
  const g = grade(input({ evidence: [], certification: certified({ screen: ["ok"], body: ["like_new"] }) }));
  assert.equal(g.status, "not_tested");
  assert.equal(g.tests.find((l) => l.id === "display")!.result, "not_tested");
});

test("C6: a camera-confirmed fail beats the advisor's OK — the worse result wins", () => {
  const results = allPass({ display: { outcome: "fail", detail: { camera: "fail", confirmed: true, selfTest: null }, at: AT } });
  const g = grade(input({ evidence: [swapup(results)], faults: ["display_lines"], condition: { ...COND, screen: "lines_or_spots" }, certification: certified({ screen: ["ok"] }) }));
  assert.equal(g.tests.find((l) => l.id === "display")!.result, "failed");
  assert.equal(g.status, "needs_repair");
  const via = g.tests.find((l) => l.id === "display")!.sources.find((s) => s.source === "swapup_check")!;
  assert.equal(via.via, "store_camera");
});

test("C7: a final camera that confirmed scratches, an advisor who certified OK → DS10, the camera's finding stands", () => {
  const cam: GradingCamera = { ...FAILED, status: "final", final: true, lcd: { cameraChecked: false, verdict: null, reason: "x" }, floor: { screen: "scratched", body: "flawless" }, faults: [] };
  const g = grade(input({ camera: cam, condition: { ...COND, screen: "scratched" }, certification: certified({ screen: ["ok"] }) }));
  assert.equal(g.grade, "Good");
  assert.equal(g.disclosures.find((d) => d.code === "DS10")?.text, 'Camera found visible scratches; Asha K. certified "OK" — camera stands.');
});

test("C8: the body certified clears the camera's bent-frame suggestion, and says what the camera saw", () => {
  const cam: GradingCamera = { ...FAILED, status: "final", final: true, lcd: { cameraChecked: true, verdict: "pass", reason: null, confirmed: true }, floor: NO_FLOOR, faults: [], suggested: [{ id: "frame_damage", because: "Camera saw a bend", photoIndex: 2, confidence: 0.9 }] };
  const before = grade(input({ camera: cam, evidence: [swapup(allPass())] }));
  assert.ok(codes(before).includes("PV4"));
  const after = grade(input({ camera: cam, evidence: [swapup(allPass())], certification: certified({ body: ["like_new"] }) }));
  assert.ok(!codes(after).includes("PV4"));
  assert.match(after.disclosures.find((d) => d.code === "DS10")!.text, /saw bent \/ broken frame; Asha K\. recorded the body "Like new"/);
});

test("C9: liquid indicator not visible → a disclosure, the grade stands", () => {
  const g = grade(input({ certification: certified({ screen: ["ok"], body: ["like_new"], liquid: ["cant_see"] }) }));
  assert.equal(g.status, "graded");
  assert.equal(g.disclosures.find((d) => d.code === "DS9")?.text, "Liquid indicator not checked — Asha K. couldn't see it.");
  const tripped = grade(input({ certification: certified({ liquid: ["tripped"] }), faults: ["water_damage"], condition: { ...COND, issues: ["liquid"] } }));
  assert.equal(tripped.status, "needs_repair");
});

test("C10: a camera that wasn't conclusive or wants a person to review — cleared once both screen and body are certified", () => {
  const cam: GradingCamera = { ...FAILED, status: "provisional", final: false, conclusive: false, needsHumanReview: true };
  const one = grade(input({ camera: cam, certification: certified({ screen: ["ok"] }) }));
  assert.ok(codes(one).includes("PV2") && codes(one).includes("PV3"));
  // The grade reads the case's condition, which the tap set (certifyRow) — scuffed.
  const both = grade(input({ camera: cam, condition: { ...COND, body: "scuffed" }, certification: certified({ screen: ["ok"], body: ["scuffs"] }) }));
  assert.ok(!codes(both).includes("PV2") && !codes(both).includes("PV3"));
  assert.equal(both.grade, "Good");
});
