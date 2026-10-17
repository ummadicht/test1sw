import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readSnapshot,
  readScreen,
  publicPhotoUrl,
  finality,
  isConfirmed,
  mapCamera,
  identityOf,
  worseDisplay,
  gradeiqFunctionalMap,
  applyCameraFloor,
  cameraOverrideProblems,
  addFaultSources,
  reconcileFaultSources,
  disagreements,
  assessmentView,
  type GradeiqSnapshot,
} from "./gradeiqMap.ts";
import { mergeCondition, unionFaults, type TestResults, type Declared } from "./diagnostics.ts";
import type { ConditionAnswers } from "./condition.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const PUBLIC = "https://swapmore.com/apps/gradeiq";
const AT = "2026-10-16T10:00:00.000Z";
const BOX: [number, number, number, number] = [0.1, 0.1, 0.3, 0.4];

type F = { type: string; label?: string; severity?: string; confidence?: number; photoIndex?: number; box?: unknown; location?: string; uncorroborated?: boolean };
const finding = (f: F) => ({ label: f.type, severity: "moderate", confidence: 0.86, photoIndex: 0, box: BOX, ...f });
const comp = (id: string, grade: string, findings: F[] = []) => ({ id, name: id, grade, confidence: 0.9, findings: findings.map(finding) });

/** A GradeIQ GET /api/sessions/{id} body: a clean, final, flash-graded A phone. */
function raw(over: Record<string, unknown> = {}, cosOver: Record<string, unknown> = {}, screenOver: Record<string, unknown> = {}) {
  return {
    id: "6f1c1b7e-0000-4000-8000-000000000001",
    client_id: "swapmore-in",
    status: "open",
    cosmetic_grade: "A",
    functional_grade: "Working",
    overall_grade: "A · Working",
    photos: ["/api/uploads/x-0.jpg", "/api/uploads/x-1.jpg"],
    capture: { verdict: "ok", code: "ok", reasons: [], attempt: 1 },
    offer: { price: 12345, currency: "INR" },
    staged: "data:image/jpeg;base64,AAAA".repeat(50),
    identity: { verdict: "unverified", flags: [] },
    cosmetic: {
      grade: "A",
      conclusive: true,
      tierUsed: "flash",
      visionModel: "gemini-3.6-flash",
      refining: false,
      needsHumanReview: false,
      coverage: 0.9,
      score: 88,
      specialists: [comp("front", "A"), comp("back", "A"), comp("frame", "A"), comp("cameras", "A"), comp("display", "A")],
      ...cosOver,
    },
    screen: {
      displayCheck: { verdict: "pass", confidence: 0.92, findings: [], note: "", source: "gemini", patterns: ["white", "black"], captures: [{ pattern: "white", photo: "/api/uploads/x-disp-0.jpg" }], requested: ["white", "black"], missing: [] },
      ...screenOver,
    },
    ...over,
  };
}
const snap = (...a: Parameters<typeof raw>): GradeiqSnapshot => readSnapshot(raw(...a), PUBLIC, AT);
const FINAL = { status: "final" as const, final: true, provisional: false, reasons: [] };
const PROVISIONAL = { status: "provisional" as const, final: false, provisional: true, reasons: ["x"] };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

/* ─────────────────────────── reading GradeIQ ─────────────────────────── */

test("snapshot: GradeIQ's price and its base64 photo copies are never kept", () => {
  const s = snap();
  const json = JSON.stringify(s);
  assert.ok(!json.includes("staged"));
  assert.ok(!json.includes("base64"));
  assert.ok(!json.includes("12345"), "the offer price must not survive");
  assert.ok(!("offer" in s));
});

test("snapshot: photo paths are re-rooted on the public GradeIQ URL", () => {
  const s = snap();
  assert.deepEqual(s.photos, [`${PUBLIC}/api/uploads/x-0.jpg`, `${PUBLIC}/api/uploads/x-1.jpg`]);
  assert.equal(s.displayCheck?.captures[0].photo, `${PUBLIC}/api/uploads/x-disp-0.jpg`);
  // the export builds URLs from the request's own origin (127.0.0.1 on the VM)
  assert.equal(publicPhotoUrl("http://127.0.0.1:3700/apps/gradeiq/api/uploads/a.jpg", PUBLIC + "/"), `${PUBLIC}/api/uploads/a.jpg`);
  assert.equal(publicPhotoUrl("", PUBLIC), null);
  assert.equal(publicPhotoUrl(42, PUBLIC), null);
});

test("snapshot: the capture verdict comes from the column first, then the screen blob", () => {
  assert.equal(snap().capture?.verdict, "ok");
  assert.equal(snap({ capture: {} }, {}, { capture: { verdict: "retake", reasons: ["blurry"] } }).capture?.verdict, "retake");
  assert.equal(snap({ capture: {} }).capture, null);
});

test("snapshot: a missing identity check is 'unverified', never a pass", () => {
  assert.equal(snap({ identity: undefined }).identity.verdict, "unverified");
  assert.equal(snap({ identity: { verdict: "bogus" } }).identity.verdict, "unverified");
});

test("snapshot: nonsense in, nothing invented", () => {
  const s = readSnapshot("not json", PUBLIC, AT);
  assert.equal(s.cosmeticGrade, "");
  assert.deepEqual(s.components, []);
  assert.equal(s.tierUsed, null);
  assert.equal(s.displayCheck, null);
  assert.equal(finality(s).final, false);
  assert.deepEqual(mapCamera(s, finality(s)).faults, []);
});

test("screen: GradeIQ's /screen poll read defensively; an unknown session reads as idle and unpaired", () => {
  assert.deepEqual(readScreen({ pattern: "idle" }), { pattern: "idle", shown: null, cosmeticDone: false, handoffDone: false, capture: null, connectedAt: null });
  const s = readScreen({ pattern: "white", shown: "white", cosmeticDone: true, handoffDone: false, capture: { verdict: "retake", reasons: ["glare"] }, connectedAt: AT });
  assert.equal(s.shown, "white");
  assert.equal(s.capture?.verdict, "retake");
  assert.deepEqual(s.capture?.reasons, ["glare"]);
});

/* ─────────────────────────── finality ─────────────────────────── */

test("finality: final only with a grade, a real tier, no refinement, capture ok and no case on the phone", () => {
  assert.equal(finality(snap()).status, "final");
  assert.equal(finality(null).status, "none");
  assert.equal(finality(snap({ cosmetic_grade: "" }, { refining: true })).status, "grading");
  assert.equal(finality(snap({}, { tierUsed: "stub" })).status, "failed");
  const refining = finality(snap({}, { refining: true }));
  assert.equal(refining.status, "provisional");
  assert.equal(finality(snap({ capture: { verdict: "retake", reasons: ["blurry"] } })).status, "provisional");
  assert.equal(finality(snap({ capture: {} })).status, "provisional");
  const cased = finality(snap({}, { obstruction: { present: true, type: "case", note: "" } }));
  assert.equal(cased.final, false);
  assert.match(cased.reasons.join(" "), /case/);
});

test("finality: a refinement still running after 180 s stays provisional, labelled as such", () => {
  const f = finality(snap({}, { refining: true }), { timedOut: true });
  assert.equal(f.status, "provisional");
  assert.match(f.reasons.join(" "), /final check did not finish/);
});

test("finality: coverage under 50% with no grade is a failure to retake, not a grade", () => {
  const f = finality(snap({ cosmetic_grade: "" }, { coverage: 0.3, refining: false }));
  assert.equal(f.status, "failed");
  assert.match(f.reasons[0], /Not enough of the phone/);
});

/* ─────────────────────────── the confirmed bar ─────────────────────────── */

test("confirmed: confidence ≥ 0.7, corroborated and located — all three", () => {
  assert.equal(isConfirmed({ confidence: 0.7, uncorroborated: false, box: BOX }), true);
  assert.equal(isConfirmed({ confidence: 0.69, uncorroborated: false, box: BOX }), false);
  assert.equal(isConfirmed({ confidence: 0.95, uncorroborated: true, box: BOX }), false);
  assert.equal(isConfirmed({ confidence: 0.95, uncorroborated: false, box: null }), false);
});

/* ─────────────────────────── mapping (§3.4) ─────────────────────────── */

test("map: a clean final A phone adds nothing", () => {
  const s = snap();
  const m = mapCamera(s, finality(s));
  assert.deepEqual(m.faults, []);
  assert.deepEqual(m.suggested, []);
  assert.deepEqual(m.floor, { screen: "flawless", body: "flawless" });
  assert.equal(m.lcd.cameraChecked, true);
  assert.deepEqual(m.flags, []);
});

test("map: a confirmed crack on the front glass is a cracked screen and the screen_cracked fault", () => {
  const s = snap({ cosmetic_grade: "D" }, { specialists: [comp("front", "D", [{ type: "crack", label: "Spider crack", severity: "severe" }])] });
  const m = mapCamera(s, finality(s));
  assert.deepEqual(ids(m.faults), ["screen_cracked"]);
  assert.equal(m.faults[0].photoIndex, 0);
  assert.deepEqual(m.faults[0].box, BOX);
  assert.equal(m.floor.screen, "cracked");
  assert.equal(m.findings[0].effect, "fault");
  assert.equal(m.findings[0].meaning, "Cracked glass");
  assert.equal(m.findings[0].photoUrl, `${PUBLIC}/api/uploads/x-0.jpg`);
});

test("map: an unconfirmed crack or a minor chip is a flag to look at — never a fault", () => {
  for (const f of [
    { type: "crack", confidence: 0.6 },
    { type: "crack", uncorroborated: true },
    { type: "crack", box: null },
    { type: "chip", severity: "minor" },
  ]) {
    const s = snap({}, { specialists: [comp("front", "B", [f])] });
    const m = mapCamera(s, finality(s));
    assert.deepEqual(m.faults, [], JSON.stringify(f));
    assert.equal(m.floor.screen, "flawless");
    assert.match(m.flags.join(" "), /may have seen a (crack|chip)/);
  }
  const s = snap({}, { specialists: [comp("front", "C", [{ type: "chip", severity: "moderate" }])] });
  assert.deepEqual(ids(mapCamera(s, finality(s)).faults), ["screen_cracked"], "a confirmed moderate chip is a crack");
});

test("map: scratches — GradeIQ's A (faint micro-scratches) stays flawless; B/C or moderate+ is 'scratched'", () => {
  const minorOnA = snap({}, { specialists: [comp("front", "A", [{ type: "scratch", severity: "minor" }])] });
  assert.equal(mapCamera(minorOnA, FINAL).floor.screen, "flawless");
  const minorOnB = snap({}, { specialists: [comp("front", "B", [{ type: "scratch", severity: "minor" }])] });
  assert.equal(mapCamera(minorOnB, FINAL).floor.screen, "scratched");
  const moderate = snap({}, { specialists: [comp("front", "A", [{ type: "wear", severity: "moderate" }])] });
  assert.equal(mapCamera(moderate, FINAL).floor.screen, "scratched");
  assert.deepEqual(mapCamera(moderate, FINAL).faults, [], "scratches are condition, not a fault");
  const weak = snap({}, { specialists: [comp("front", "C", [{ type: "scratch", severity: "severe", confidence: 0.5 }])] });
  assert.equal(mapCamera(weak, FINAL).floor.screen, "flawless", "an unconfirmed scratch changes nothing");
});

test("map: dead pixels count only from screen-on frames (a display grade)", () => {
  const lit = snap({}, { specialists: [comp("display", "C", [{ type: "deadpixel", label: "Dead pixel cluster" }])] });
  const m = mapCamera(lit, FINAL);
  assert.deepEqual(ids(m.faults), ["display_lines"]);
  assert.equal(m.floor.screen, "lines_or_spots");
  const unlit = snap({}, { specialists: [comp("display", "", [{ type: "deadpixel" }])] });
  const u = mapCamera(unlit, FINAL);
  assert.deepEqual(u.faults, []);
  assert.equal(u.findings[0].effect, "none");
  assert.match(u.flags.join(" "), /did not see the display/);
});

test("map: back glass — confirmed crack is back_cracked; moderate scuffs are 'scuffed'", () => {
  const s = snap({}, { specialists: [comp("back", "D", [{ type: "crack", severity: "severe" }, { type: "scuff", severity: "moderate" }])] });
  const m = mapCamera(s, FINAL);
  assert.deepEqual(ids(m.faults), ["back_cracked"]);
  assert.equal(m.floor.body, "back_cracked");
  const scuffed = mapCamera(snap({}, { specialists: [comp("back", "B", [{ type: "scuff", severity: "moderate" }])] }), FINAL);
  assert.equal(scuffed.floor.body, "scuffed");
  assert.deepEqual(scuffed.faults, []);
});

test("map: frame — a dent is 'dented' (no fault); a severe bend is 'bent' with frame_damage SUGGESTED only", () => {
  const dent = mapCamera(snap({}, { specialists: [comp("frame", "C", [{ type: "dent", severity: "moderate", label: "Corner dent" }])] }), FINAL);
  assert.equal(dent.floor.body, "dented");
  assert.deepEqual(dent.faults, []);
  const bent = mapCamera(snap({}, { specialists: [comp("frame", "D", [{ type: "dent", severity: "severe", label: "Bent rail", location: "left side" }])] }), FINAL);
  assert.equal(bent.floor.body, "bent");
  assert.deepEqual(bent.faults, [], "frame_damage needs inspection — never auto-added");
  assert.deepEqual(ids(bent.suggested), ["frame_damage"]);
  const modCrack = mapCamera(snap({}, { specialists: [comp("frame", "C", [{ type: "crack", severity: "moderate" }])] }), FINAL);
  assert.equal(modCrack.floor.body, "flawless", "GradeIQ's own rule: frame damage counts only when severe");
  assert.match(modCrack.flags.join(" "), /crack on the frame/);
});

test("map: a cracked lens is a SUGGESTED camera fault, rear unless the finding says front", () => {
  const rear = mapCamera(snap({}, { specialists: [comp("cameras", "C", [{ type: "crack", label: "Cracked lens cover" }])] }), FINAL);
  assert.deepEqual(rear.faults, []);
  assert.deepEqual(ids(rear.suggested), ["rear_camera"]);
  const front = mapCamera(snap({}, { specialists: [comp("cameras", "C", [{ type: "chip", label: "Chipped selfie lens" }])] }), FINAL);
  assert.deepEqual(ids(front.suggested), ["front_camera"]);
});

test("map: a provisional grade is shown, never applied — what it would add becomes a flag", () => {
  const s = snap({}, { refining: true, specialists: [comp("front", "D", [{ type: "crack", severity: "severe" }])] });
  const fin = finality(s);
  assert.equal(fin.provisional, true);
  const m = mapCamera(s, fin);
  assert.equal(m.usable, false);
  assert.deepEqual(m.faults, []);
  assert.deepEqual(m.floor, { screen: "flawless", body: "flawless" });
  assert.match(m.flags.join(" "), /Not final, so not added/);
  assert.equal(m.findings.length, 1, "the finding is still listed for staff");
});

test("map: a case on the phone — grade not used", () => {
  const s = snap({}, { obstruction: { present: true, type: "case", note: "" }, specialists: [comp("back", "D", [{ type: "crack", severity: "severe" }])] });
  const m = mapCamera(s, finality(s));
  assert.deepEqual(m.faults, []);
  assert.equal(m.floor.body, "flawless");
});

test("map: flags for what the camera could not judge", () => {
  const s = snap(
    { cosmetic_grade: "D" },
    {
      conclusive: false,
      gradeRange: { best: "B", worst: "D" },
      needsHumanReview: true,
      oem: { verdict: "suspect_aftermarket", confidence: 0.7, evidence: ["Off-colour back glass"] },
      specialists: [comp("front", "D"), comp("back", "")],
    }
  );
  const m = mapCamera(s, finality(s));
  const all = m.flags.join(" | ");
  assert.match(all, /B–D, not conclusive/);
  assert.match(all, /person to review/);
  assert.match(all, /non-original part/);
  assert.match(all, /did not see the back/);
  assert.match(all, /grade D with no confirmed crack/);
  assert.deepEqual(m.faults, []);
});

/* ─────────────────────────── the LCD sweep ─────────────────────────── */

test("lcd: a confident sweep failure is display_lines even while the cosmetic grade is provisional", () => {
  const s = snap({}, { refining: true }, { displayCheck: { verdict: "fail", confidence: 0.84, findings: [{ label: "Green line", severity: "moderate" }], patterns: ["white"], captures: [], requested: ["white"], missing: [] } });
  const m = mapCamera(s, finality(s));
  assert.deepEqual(ids(m.faults), ["display_lines"]);
  assert.equal(m.faults[0].component, "display_check");
  assert.equal(m.floor.screen, "lines_or_spots");
  assert.equal(m.lcd.verdict, "fail");
  assert.equal(m.lcd.confirmed, true);
});

test("lcd: a weak sweep failure is a flag; unknown or incomplete is 'LCD not camera-checked'", () => {
  const weak = mapCamera(snap({}, {}, { displayCheck: { verdict: "fail", confidence: 0.5, patterns: ["white"], requested: ["white"], missing: [] } }), FINAL);
  assert.deepEqual(weak.faults, []);
  assert.match(weak.flags.join(" "), /low confidence/);
  assert.equal(weak.lcd.confirmed, false);
  // GradeIQ says "fail" for ANY finding while keeping the model's confidence (maybe a pass's):
  // confident but minor-only is a flag, not display_lines.
  const minor = mapCamera(snap({}, {}, { displayCheck: { verdict: "fail", confidence: 0.9, findings: [{ label: "faint speck", severity: "minor" }], patterns: ["white"], requested: ["white"], missing: [] } }), FINAL);
  assert.deepEqual(minor.faults, []);
  assert.equal(minor.lcd.confirmed, false);
  assert.match(minor.flags.join(" "), /only minor marks/);
  // A stored snapshot without severities is never confirmed.
  const legacy = mapCamera(snap({}, {}, { displayCheck: { verdict: "fail", confidence: 0.9, findings: [{ label: "line" }], patterns: ["white"], requested: ["white"], missing: [] } }), FINAL);
  assert.deepEqual(legacy.faults, []);
  const unknown = mapCamera(snap({}, {}, { displayCheck: { verdict: "unknown", confidence: 0, reason: "the phone stayed folded", requested: ["white"], missing: ["white"] } }), FINAL);
  assert.equal(unknown.lcd.cameraChecked, false);
  assert.match(unknown.flags.join(" "), /LCD not camera-checked: the phone stayed folded/);
  const none = mapCamera(snap({}, {}, { displayCheck: undefined }), FINAL);
  assert.equal(none.lcd.cameraChecked, false);
  assert.match(none.flags.join(" "), /LCD not camera-checked/);
});

test("lcd: a staff override means the LCD was NOT camera-checked, whatever the sweep says", () => {
  const m = mapCamera(snap(), FINAL, { lcdOverride: { by: "Asha", reason: "touch dead, can't open Check", at: AT } });
  assert.equal(m.lcd.cameraChecked, false);
  assert.match(m.lcd.reason!, /Asha.*touch dead/);
});

/* ─────────────────────────── identity ─────────────────────────── */

test("identity: either check saying mismatch is a mismatch; only GradeIQ's match is a match; missing is unverified", () => {
  assert.equal(identityOf(null).verdict, "unverified");
  assert.equal(identityOf(snap()).verdict, "unverified");
  assert.equal(identityOf(snap({ identity: { verdict: "match", flags: [] } })).verdict, "match");
  const camera = identityOf(snap({ identity: { verdict: "match", flags: [] } }, { device: { make: "Apple", model: "iPhone 13", match: "mismatch", reason: "Notch and Apple logo" } }));
  assert.equal(camera.verdict, "mismatch");
  assert.match(camera.reasons[0], /iPhone 13/);
  assert.equal(identityOf(snap({ identity: { verdict: "mismatch", flags: ["IMEI says Samsung, the photos show Apple"] } })).verdict, "mismatch");
});

/* ─────────────────────────── the shared display key ─────────────────────────── */

test("display: the worse of the self-test and the camera sweep, fail > pass > skip", () => {
  assert.equal(worseDisplay("pass", "fail"), "fail");
  assert.equal(worseDisplay("fail", "pass"), "fail");
  assert.equal(worseDisplay("pass", "unknown"), "pass", "an inconclusive sweep never erases a pass");
  assert.equal(worseDisplay("skip", "pass"), "pass");
  assert.equal(worseDisplay("unsupported", null), "skip");
  assert.equal(worseDisplay(null, "fail"), "fail");
  assert.equal(worseDisplay(undefined, null), null);
});

test("functional map: the FULL map, unsupported → skip, detail stays home, stable order", () => {
  const results: TestResults = {
    touch: { outcome: "pass", detail: { taps: 9 }, at: AT },
    nfc: { outcome: "unsupported", detail: null, at: AT },
    display: { outcome: "pass", detail: null, at: AT },
    camera: { outcome: "fail", detail: { side: "rear" }, at: AT },
    flash: { outcome: "skip", detail: null, at: AT },
  };
  const m = gradeiqFunctionalMap(results, null);
  assert.deepEqual(m, { camera: "fail", display: "pass", flash: "skip", nfc: "skip", touch: "pass" });
  assert.deepEqual(Object.keys(m), ["camera", "display", "flash", "nfc", "touch"]);
  assert.equal(gradeiqFunctionalMap(results, "fail").display, "fail");
  assert.equal(gradeiqFunctionalMap({}, "pass").display, "pass");
  assert.deepEqual(gradeiqFunctionalMap({}, null), {});
  assert.equal(JSON.stringify(gradeiqFunctionalMap(results)), JSON.stringify(gradeiqFunctionalMap({ ...results })), "same results → same body");
});

/* ─────────────────────────── condition, overrides, sources ─────────────────────────── */

const COND: ConditionAnswers = { powersOn: true, calls: true, screen: "flawless", body: "scuffed", issues: [], accessories: { charger: true, box: true, bill: false }, age: "3to11m" };

test("floor: the camera only ever makes the condition worse", () => {
  assert.deepEqual(applyCameraFloor(COND, { screen: "scratched", body: "flawless" }), { ...COND, screen: "scratched", body: "scuffed" });
  assert.deepEqual(applyCameraFloor({ ...COND, screen: "cracked" }, { screen: "scratched", body: "dented" }), { ...COND, screen: "cracked", body: "dented" });
});

test("overrides: recording better than the camera confirmed needs a reason; worse is always fine", () => {
  const cam = { floor: { screen: "cracked" as const, body: "dented" as const }, faults: [{ id: "screen_cracked" as const, because: "x", photoIndex: 0 }] };
  assert.deepEqual(cameraOverrideProblems({ ...COND, screen: "cracked", body: "bent" }, ["screen_cracked", "speaker"], cam), []);
  const p = cameraOverrideProblems({ ...COND, screen: "scratched" }, [], cam);
  assert.deepEqual(p.map((x) => x.key), ["fault:screen_cracked", "screen:cracked", "body:dented"]);
  assert.match(p[0].why, /photo 1/);
  assert.deepEqual(cameraOverrideProblems(COND, [], null), []);
});

test("fault sources: several per fault, removed faults lose theirs, unsourced faults were the advisor's", () => {
  let s = addFaultSources({}, [
    { id: "screen_cracked", source: "declared" },
    { id: "screen_cracked", source: "camera_ai" },
    { id: "speaker", source: "tested" },
  ]);
  assert.deepEqual(s, { screen_cracked: ["declared", "camera_ai"], speaker: ["tested"] });
  s = reconcileFaultSources(s, ["screen_cracked", "battery_drain"]);
  assert.deepEqual(s, { screen_cracked: ["declared", "camera_ai"], battery_drain: ["advisor"] });
});

test("apply: the camera never downgrades what the customer declared", () => {
  // Customer says cracked; the camera saw a clean front. The case stays cracked.
  const declared: Declared = { screenCracked: true, backCracked: false, liquid: false, imei: null };
  const s = snap();
  const m = mapCamera(s, finality(s));
  const faults = unionFaults(["screen_cracked"], m.faults.map((f) => f.id));
  const cond = applyCameraFloor(mergeCondition(COND, faults), m.floor);
  assert.equal(cond.screen, "cracked");
  const d = disagreements(declared, {}, s, m, finality(s));
  assert.equal(d.length, 1);
  assert.equal(d[0].final, "cracked");
  assert.match(d[0].message, /customer's answer stands/);
});

/* ─────────────────────────── disagreements ─────────────────────────── */

test("disagreements: customer 'not cracked', camera confirmed → the worse answer, with the photo", () => {
  const s = snap({ cosmetic_grade: "D" }, { specialists: [comp("front", "D", [{ type: "crack", severity: "severe", confidence: 0.86, photoIndex: 0 }])] });
  const m = mapCamera(s, finality(s));
  const d = disagreements({ screenCracked: false, backCracked: false, liquid: false, imei: null }, {}, s, m, finality(s));
  assert.equal(d.length, 1);
  assert.equal(d[0].topic, "screen");
  assert.equal(d[0].message, "Customer: not cracked · Camera: cracked (86%, photo 1). The worse answer is recorded.");
  assert.deepEqual(d[0].box, BOX);
});

test("disagreements: self-test and camera sweep disagree on the display → both shown, lines_or_spots", () => {
  const s = snap({}, {}, { displayCheck: { verdict: "fail", confidence: 0.9, findings: [{ label: "Green line", severity: "moderate" }], patterns: ["white"], requested: ["white"], missing: [] } });
  const m = mapCamera(s, finality(s));
  const d = disagreements(null, { display: { outcome: "pass", detail: null, at: AT } }, s, m, finality(s));
  assert.equal(d.length, 1);
  assert.equal(d[0].topic, "display");
  assert.equal(d[0].tested, "self-test passed");
  assert.match(d[0].camera, /failed/);
  assert.equal(d[0].final, "Lines, spots or dead pixels");
});

test("disagreements: a low-confidence sweep failure is shown, but never claimed as recorded", () => {
  const s = snap({}, {}, { displayCheck: { verdict: "fail", confidence: 0.5, patterns: ["white"], requested: ["white"], missing: [] } });
  const m = mapCamera(s, finality(s));
  assert.deepEqual(m.faults, [], "below the bar: no display_lines");
  const d = disagreements(null, { display: { outcome: "pass", detail: null, at: AT } }, s, m, finality(s));
  assert.equal(d.length, 1);
  assert.equal(d[0].final, "not recorded");
  assert.doesNotMatch(d[0].message, /Recorded as/);
  // a self-test failure is recorded whatever the camera says
  const pass = snap();
  const d2 = disagreements(null, { display: { outcome: "fail", detail: null, at: AT } }, pass, mapCamera(pass, finality(pass)), finality(pass));
  assert.equal(d2[0].final, "Lines, spots or dead pixels");
});

test("map: gaps — back minor chip is a flag; a severe frame crack is 'bent' with frame_damage suggested", () => {
  const chip = mapCamera(snap({}, { specialists: [comp("back", "B", [{ type: "chip", severity: "minor" }])] }), FINAL);
  assert.deepEqual(chip.faults, []);
  assert.equal(chip.floor.body, "flawless");
  assert.match(chip.flags.join(" "), /may have seen a chip on the back/);
  const crack = mapCamera(snap({}, { specialists: [comp("frame", "D", [{ type: "crack", severity: "severe" }])] }), FINAL);
  assert.equal(crack.floor.body, "bent");
  assert.deepEqual(crack.faults, []);
  assert.deepEqual(ids(crack.suggested), ["frame_damage"]);
});

test("finality: a grade without a named model tier is provisional, never final", () => {
  const f = finality(snap({}, { tierUsed: undefined }));
  assert.equal(f.status, "provisional");
  assert.match(f.reasons.join(" "), /did not say which model/);
});

test("display: an inconclusive sweep never erases a self-test failure", () => {
  assert.equal(worseDisplay("fail", "unknown"), "fail");
  assert.equal(worseDisplay("fail", "pass"), "fail");
});

test("disagreements: an identity mismatch blocks the quote", () => {
  const s = snap({}, { device: { make: "Samsung", model: "Galaxy A14", match: "mismatch", reason: "Different camera layout" } });
  const m = mapCamera(s, finality(s));
  const d = disagreements(null, {}, s, m, finality(s));
  assert.equal(d[0].topic, "identity");
  assert.equal(d[0].final, "quote blocked");
});

test("staff view: grade, range and review flags travel with the letter; nothing priced", () => {
  const s = snap({}, { conclusive: false, gradeRange: { best: "A", worst: "B" } });
  const fin = finality(s);
  const v = assessmentView(s, fin, mapCamera(s, fin));
  assert.equal(v.grade, "A");
  assert.equal(v.final, true);
  assert.deepEqual(v.gradeRange, { best: "A", worst: "B" });
  assert.equal(v.components.length, 5);
  assert.ok(!JSON.stringify(v).includes("12345"));
  const none = assessmentView(null, finality(null), mapCamera(null, finality(null)));
  assert.equal(none.grade, null, "no grade is no grade — never a letter");
  assert.equal(none.identity.verdict, "unverified");
});
