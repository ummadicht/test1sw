/**
 * THE GRADE — one grade for a tested phone, from every phone check SwapUp has.
 *
 * Two sources of test evidence feed this one engine: SwapUp Check (the
 * customer's own phone testing itself, lib/domain/diagnostics.ts) and a
 * Phonecheck station (cable-connected, lib/domain/phonecheck.ts). Both arrive as
 * SwapUp test ids, merged worse-of. With the case's condition, faults and the
 * store camera's word, the engine says one of:
 *
 *   graded        a SwapUp grade — Superb > Good > Fair > Best Value
 *   incomplete    a key test has no result; `ceiling` is the best it can be
 *   needs_repair  a defect: no SwapUp grade takes it ("No Functional Defects")
 *   cannot_grade  the evidence can't be trusted (emulator, no condition, wrong phone)
 *   not_tested    no evidence at all
 *
 * Every rule that fires leaves a Reason {code, text}; reasons[0] is the one-line
 * "why". `provisional` reasons keep a grade from being final; `disclosures` are
 * facts a buyer must hear that don't change the grade.
 *
 * The SwapUp grade uses the refurbished market's words because the buyback
 * partner buys the phone and PriceIQ's sell price is keyed by those grades. The
 * engine can only agree with `gradeAfterRefurb` (test G43). The LETTER (owner,
 * 2026-10-17: "both scales") is a strict one-to-one translation of that grade —
 * A = Superb, B = Good, C = Fair, D = Best Value — and nothing else: never
 * derived from anything but the SwapUp grade, never a CTIA grade (SwapUp
 * measures no scratch sizes, light level or inspection time), and never
 * GradeIQ's camera letter, which stays staff-only.
 *
 * THE GRADE NEVER MOVES A PRICE. Prices read the condition answers — the partner's
 * rate card (lib/domain/ratecard.ts), and PriceIQ's trade-in, which prices the same
 * look by the same rule G1 (marketSell.ts cosmeticGrade) but never this engine's
 * verdict: nothing that prices may import this module (G49).
 *
 * Pure functions only — no database, no network, no clock.
 */
import { MARKET_GRADES, MARKET_GRADE_LETTER, cosmeticGrade, gradeAfterRefurb, type MarketGrade, type MarketGradeLetter } from "./marketSell.ts";
import {
  type ConditionAnswers,
  type FaultId,
  type PartId,
  type ScreenState,
  type BodyState,
  FAULTS,
  FAULT_BY_ID,
  ISSUE_LABEL,
  SCREEN_LABEL,
  SCREEN_ORDER,
  BODY_LABEL,
  BODY_ORDER,
  conditionFromFaults,
  partsForFaults,
} from "./condition.ts";
import {
  BATTERY_HEALTH_ID,
  BATTERY_HEALTH_PASS_PCT,
  BROWSER_NOTE,
  DEFAULT_PLAN,
  FAIL_FAULT,
  NOTE_ONLY,
  cameraSide,
  type CameraSide,
  type PlanItem,
  type TestOutcome,
  type TestResult,
  type TestResults,
} from "./diagnostics.ts";
import { COMPONENT_LABEL, standingFloor, type CaseCameraCheck, type GiqComponentId, type RecordedOverride } from "./gradeiqMap.ts";
import type { PcOther } from "./phonecheck.ts";
import { certChoice, type Certification, type CertRow } from "./certify.ts";

/* ─────────────────────────── the contract (spec §2.2) ─────────────────────────── */

export const GRADING_RULESET_VERSION = "2026-10-17.2";

/**
 * "advisor": the advisor's certification of the screen (lib/domain/certify.ts),
 * read as the display test — added only beside a real test, never instead of one.
 */
export type EvidenceSource = "swapup_check" | "phonecheck" | "phonecheck_upload" | "advisor";
export type TestEvidence = {
  source: EvidenceSource;
  results: TestResults;
  at: string | null;
  /** Phonecheck only: tests SwapUp has no id for, failed cosmetic checks, and Working = No with no failure named. */
  pc?: { other: PcOther[]; cosmeticFails: string[]; workingNo: boolean; /** Read from an uploaded PDF / photo by AI. */ aiRead?: boolean };
};
export type BatteryReading = { pct: number; source: "screenshot" | "phonecheck" | "phonecheck_upload"; at: string | null };

export type GradingCamera = Pick<
  CaseCameraCheck,
  "state" | "status" | "final" | "gradeRange" | "conclusive" | "needsHumanReview" | "suggested" | "lcd" | "overrides" | "identity" | "identityOverride"
> &
  Partial<Pick<CaseCameraCheck, "floor" | "faults">>;

export type GradingInput = {
  /** The session's plan, else DEFAULT_PLAN (an empty plan reads as DEFAULT_PLAN). */
  plan: readonly PlanItem[];
  /** [] = not tested. */
  evidence: TestEvidence[];
  /** The case's condition — what the partner prices. */
  condition: ConditionAnswers | null;
  faults: FaultId[];
  camera: GradingCamera | null;
  /** Per-component camera grades, ONLY from a final snapshot. */
  cameraComponents: { id: GiqComponentId; grade: string | null }[] | null;
  /** snapshot.oem.verdict */
  cameraOem: string | null;
  /** DeviceReport.isPhysicalDevice */
  physicalDevice: boolean | null;
  browserRun: boolean;
  /** A store manager attached a Phonecheck record whose IMEI differs from the case. */
  phonecheckImeiOverride: RecordedOverride | null;
  pcFacts: { parts: "genuine" | "not_genuine" | "unknown" | null; deviceLock: "on" | "off" | null } | null;
  /** Phonecheck's model where it disagrees with the case's (the case is never written over). Optional. */
  pcModelMismatch?: { phonecheck: string; case: string | null } | null;
  /** What the advisor certified by eye where the camera couldn't decide (cases.certification). Optional. */
  certification?: Certification | null;
};

export type Reason = { code: string; text: string };
export type GradingStatus = "not_tested" | "cannot_grade" | "needs_repair" | "incomplete" | "graded";
/** The letters live beside the grade's words (marketSell.ts), so the answer names them without importing this engine. */
export type GradeLetter = MarketGradeLetter;

export type TestLine = {
  id: string;
  name: string;
  key: boolean;
  result: "passed" | "failed" | "not_tested" | "not_on_phone";
  sources: {
    source: EvidenceSource;
    outcome: TestOutcome | "pending";
    manual?: boolean;
    names?: string[];
    at: string | null;
    /** The person, for an advisor's check by eye. */
    by?: string;
    /** The advisor looked while the customer's phone showed the test colours. */
    colours?: boolean;
    /** How SwapUp Check's display result was reached: the store camera's colour check alone, or with the phone's own test. */
    via?: "store_camera" | "self_test_and_store_camera";
  }[];
};

export type Grading = {
  ruleset: string;
  status: GradingStatus;
  /** Only when status === "graded". */
  grade: MarketGrade | null;
  /** The same grade as a letter — A = Superb, B = Good, C = Fair, D = Best Value. null whenever `grade` is. */
  letter: GradeLetter | null;
  /** graded && no provisional reason. */
  final: boolean;
  label: string;
  /** Rule G1, when the screen and body are on the grade ladder. */
  cosmetic: MarketGrade | null;
  /** incomplete: the best it can be if the untested key tests pass. */
  ceiling: MarketGrade | null;
  /** needs_repair: gradeAfterRefurb(condition), when every repair has a part. */
  afterRepair: MarketGrade | null;
  repairs: { faults: FaultId[]; parts: PartId[]; inspection: FaultId[] };
  reasons: Reason[];
  provisional: Reason[];
  disclosures: Reason[];
  tests: TestLine[];
  /** Phonecheck tests SwapUp has no id for, verbatim. */
  otherTests: { name: string; result: PcOther["result"]; source: EvidenceSource; manual: boolean }[];
  battery: { pct: number | null; pass: boolean | null; readings: BatteryReading[] };
};

/* ─────────────────────────── the two scales ─────────────────────────── */

/** One-to-one, and nothing else: the letter IS the SwapUp grade. */
export const GRADE_LETTER: Readonly<Record<MarketGrade, GradeLetter>> = MARKET_GRADE_LETTER;

/** The one line every place that shows the letter carries. */
export const LETTER_NOTE = "A = Superb, B = Good, C = Fair, D = Best Value — not CTIA.";
export const SCALE_NOTE = "SwapUp grade, as tested at the store — not the buyer's own inspection.";

export function gradeLetter(g: MarketGrade | null | undefined): GradeLetter | null {
  return g ? GRADE_LETTER[g] : null;
}

/** "Good (B)" — both scales; null for no grade. */
export function gradeWithLetter(g: MarketGrade | null | undefined): string | null {
  return g ? `${g} (${GRADE_LETTER[g]})` : null;
}

/** Status → the label clients render as-is (spec §2.5, with the letter). */
export function gradingLabel(status: GradingStatus, grade: MarketGrade | null, final: boolean): string {
  if (status === "graded" && grade) return `${gradeWithLetter(grade)}${final ? "" : " · provisional"}`;
  if (status === "needs_repair") return "Needs repair";
  if (status === "incomplete") return "Not fully tested";
  if (status === "cannot_grade") return "Can't grade";
  return "Not tested";
}

export const EVIDENCE_SOURCE_LABEL: Readonly<Record<EvidenceSource, string>> = {
  swapup_check: "SwapUp Check",
  phonecheck: "Phonecheck",
  phonecheck_upload: "Phonecheck (uploaded)",
  advisor: "Advisor",
};

/* ─────────────────────────── merging evidence (§2.3) ─────────────────────────── */

const SIDE_WORDS: Record<CameraSide, string> = { front: "front camera", rear: "rear camera", both: "front and rear cameras" };

function unionSide(sides: (CameraSide | null)[]): CameraSide | null {
  let front = false;
  let rear = false;
  for (const s of sides) {
    if (s === "front" || s === "both") front = true;
    if (s === "rear" || s === "both") rear = true;
  }
  return front && rear ? "both" : front ? "front" : rear ? "rear" : null;
}

const isPending = (r: TestResult) => r.outcome === "skip" && r.detail?.pending === true;

/**
 * Every source's result per plan id → one result, never better than any source:
 * any fail → failed; else any pass → passed; else every source unsupported →
 * not on this phone; else not tested. Skip and unsupported never count as a pass.
 * A failed camera's side is the union of the sides that failed.
 */
export function mergeEvidence(plan: readonly PlanItem[], evidence: readonly TestEvidence[]): { results: TestResults; lines: TestLine[] } {
  const results: TestResults = {};
  const lines: TestLine[] = [];
  for (const p of plan) {
    const got: { source: EvidenceSource; r: TestResult }[] = [];
    for (const e of evidence) {
      const r = e.results[p.id];
      if (r) got.push({ source: e.source, r });
    }
    const sources: TestLine["sources"] = got.map(({ source, r }) => {
      const s: TestLine["sources"][number] = { source, outcome: isPending(r) ? "pending" : r.outcome, at: r.at ?? null };
      if (r.detail?.manual === true) s.manual = true;
      if (Array.isArray(r.detail?.names)) s.names = (r.detail!.names as unknown[]).filter((n): n is string => typeof n === "string");
      if (typeof r.detail?.by === "string" && r.detail.by) s.by = r.detail.by;
      if (r.detail?.colours === true) s.colours = true;
      // The store camera's LCD sweep folded into SwapUp Check's display (resultsWithCameraDisplay).
      if (p.id === "display" && source === "swapup_check" && (r.detail?.camera === "pass" || r.detail?.camera === "fail") && r.detail?.confirmed === true)
        s.via = r.detail?.selfTest ? "self_test_and_store_camera" : "store_camera";
      return s;
    });
    const fails = got.filter((g) => g.r.outcome === "fail");
    const passes = got.filter((g) => g.r.outcome === "pass");
    let result: TestLine["result"];
    if (fails.length) {
      result = "failed";
      const first = fails[0].r;
      const side = p.id === "camera" ? unionSide(fails.map((f) => cameraSide(f.r.detail))) : null;
      results[p.id] = { outcome: "fail", detail: side ? { ...(first.detail ?? {}), side } : first.detail, at: first.at };
    } else if (passes.length) {
      result = "passed";
      results[p.id] = passes[0].r;
    } else if (got.length && got.every((g) => g.r.outcome === "unsupported")) {
      result = "not_on_phone";
      results[p.id] = got[0].r;
    } else {
      result = "not_tested";
      // A non-pending skip first: its reason ("check the display by eye") says more than "pending".
      const skip = got.find((g) => g.r.outcome === "skip" && !isPending(g.r)) ?? got[0];
      if (skip) results[p.id] = skip.r;
    }
    lines.push({ id: p.id, name: p.name, key: p.critical, result, sources });
  }
  return { results, lines };
}

/** Every battery-health %, from a screenshot (SwapUp Check) or Phonecheck. */
function batteryReadings(evidence: readonly TestEvidence[]): BatteryReading[] {
  const out: BatteryReading[] = [];
  for (const e of evidence) {
    if (e.source === "advisor") continue;
    const r = e.results[BATTERY_HEALTH_ID];
    if (!r) continue;
    const source = e.source === "swapup_check" ? "screenshot" : e.source;
    const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 100;
    const pct = r.detail?.healthPct;
    if (ok(pct)) out.push({ pct: Math.round(pct), source, at: r.at ?? e.at ?? null });
    // Every earlier screenshot of this check counts too: the grade takes the lowest of them all.
    const earlier = Array.isArray(r.detail?.earlier) ? (r.detail!.earlier as unknown[]) : [];
    for (const x of earlier) if (ok(x)) out.push({ pct: Math.round(x), source, at: null });
  }
  return out;
}

/* ─────────────────────────── the rules (§2.4) ─────────────────────────── */

const FAULT_ORDER = FAULTS.map((f) => f.id);
const OFF_LADDER_SCREEN: ScreenState[] = ["lines_or_spots", "cracked", "not_working"];
// Rule G1 (the worse of the screen's and the body's grade; null when either is off the grade ladder)
// lives beside the grade's words in marketSell.ts, so the PriceIQ trade-in can price the same look
// without importing this engine (G49). Re-exported here, where the rules are listed.
export { cosmeticGrade };

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Which of the case's damage answers a failed Phonecheck cosmetic check is about. */
function cosmeticMatched(name: string, condition: ConditionAnswers | null, faults: FaultId[]): boolean {
  const screenHit = !!condition && condition.screen !== "flawless";
  const bodyHit = !!condition && condition.body !== "flawless";
  const n = name.toLowerCase();
  if (n === "glass condition" || n === "secondary glass cracked") return screenHit || faults.includes("screen_cracked");
  if (n === "back glass condition") return bodyHit || faults.includes("back_cracked");
  if (n === "frame condition") return bodyHit || faults.includes("frame_damage");
  if (n === "camera lens condition")
    return faults.includes("rear_camera") || faults.includes("front_camera") || !!condition?.issues.some((i) => i === "rear_camera" || i === "front_camera");
  return screenHit || bodyHit; // "Cosmetics"
}

/** The faults a failed test means (DS6). Camera by side; a battery fault of either kind covers the battery. */
function faultsForFailedTest(id: string, detail: TestResult["detail"]): FaultId[][] {
  if (id === "camera") {
    const side = cameraSide(detail);
    if (side === "front") return [["front_camera"]];
    if (side === "rear") return [["rear_camera"]];
    if (side === "both") return [["front_camera"], ["rear_camera"]];
    return [["front_camera", "rear_camera"]];
  }
  const f = FAIL_FAULT[id];
  if (!f) return [];
  if (f === "battery_drain") return [["battery_drain", "battery_swollen"]];
  return [[f]];
}

/** The advisor's screen certification as the display test: OK / Scratches pass, Lines or spots fail, Cracked says nothing. */
function certifiedDisplay(cert: Certification | null | undefined): TestEvidence | null {
  const c = cert?.screen;
  const outcome = c ? certChoice("screen", c.value)?.display : undefined;
  if (!c || !outcome) return null;
  return { source: "advisor", results: { display: { outcome, detail: { manual: true, by: c.by, colours: c.withColours, method: "advisor, by eye" }, at: c.at } }, at: c.at };
}

export function grade(input: GradingInput): Grading {
  const plan = input.plan.length ? input.plan : DEFAULT_PLAN;
  const { condition, camera } = input;
  const cert = input.certification ?? null;
  const certified = (row: CertRow) => !!cert?.[row];
  // A certification adds to a test; it never stands in for one.
  const advisor = input.evidence.length ? certifiedDisplay(cert) : null;
  const evidence = advisor ? [...input.evidence, advisor] : input.evidence;
  const faults = [...new Set(input.faults)].filter((f) => Object.prototype.hasOwnProperty.call(FAULT_BY_ID, f)).sort((a, b) => FAULT_ORDER.indexOf(a) - FAULT_ORDER.indexOf(b));
  const merged = mergeEvidence(plan, evidence);
  const lineOf = new Map(merged.lines.map((l) => [l.id, l]));
  const readings = batteryReadings(evidence);
  const pct = readings.length ? Math.min(...readings.map((r) => r.pct)) : null;
  const battery = { pct, pass: pct === null ? null : pct >= BATTERY_HEALTH_PASS_PCT, readings };
  const pcSources = evidence.filter((e) => e.source === "phonecheck" || e.source === "phonecheck_upload");

  const nt: Reason[] = [];
  const cg: Reason[] = [];
  const nr: Reason[] = [];
  const ic: Reason[] = [];
  const g: Reason[] = [];
  const provisional: Reason[] = [];
  const disclosures: Reason[] = [];

  /* — not tested / can't grade — */
  if (input.evidence.length === 0) nt.push({ code: "NT1", text: "Not tested yet." });
  if (input.physicalDevice === false) cg.push({ code: "CG1", text: "Tested on an emulator, not a real phone." });
  if (condition === null) cg.push({ code: "CG2", text: "The phone's condition isn't recorded." });
  if (camera?.identity.verdict === "mismatch" && !camera.identityOverride) cg.push({ code: "CG3", text: "The camera says this may not be the phone on the case." });
  if (pcSources.some((e) => e.pc?.workingNo)) cg.push({ code: "CG4", text: "Phonecheck says not working, no test named — find the fault." });

  /* — needs repair — */
  const failedBy = (id: string): string => {
    const words: string[] = [];
    for (const e of evidence) {
      const r = e.results[id];
      if (r?.outcome !== "fail") continue;
      const camOnly = id === "display" && e.source === "swapup_check" && r.detail?.camera === "fail" && r.detail?.selfTest !== "fail";
      const w = camOnly
        ? "the store camera's screen sweep"
        : e.source === "phonecheck_upload"
          ? "a Phonecheck upload"
          : e.source === "advisor"
            ? `${typeof r.detail?.by === "string" ? r.detail.by : "the advisor"}'s check by eye`
            : EVIDENCE_SOURCE_LABEL[e.source];
      if (!words.includes(w)) words.push(w);
    }
    return words.length ? ` on ${join(words)}` : "";
  };
  const failedLines = merged.lines.filter((l) => l.result === "failed");
  for (const l of failedLines.filter((l) => l.key)) {
    const side = l.id === "camera" ? cameraSide(merged.results.camera?.detail) : null;
    nr.push({ code: "NR1", text: `${side ? cap(SIDE_WORDS[side]) : l.name} failed${failedBy(l.id)}.` });
  }
  const repairFaults = faults.filter((f) => f !== "frame_damage");
  if (repairFaults.length)
    nr.push({ code: "NR2", text: `Recorded fault${repairFaults.length > 1 ? "s" : ""}: ${repairFaults.map((f) => FAULT_BY_ID[f].label).join(", ")}.` });
  if (condition?.powersOn === false) nr.push({ code: "NR3", text: "Does not switch on." });
  if (condition?.calls === false) nr.push({ code: "NR3", text: "Calls don't work." });
  if (condition && OFF_LADDER_SCREEN.includes(condition.screen))
    nr.push({ code: "NR4", text: `Screen: ${lower(SCREEN_LABEL[condition.screen])} — repair before grading.` });
  if (condition?.body === "back_cracked") nr.push({ code: "NR4", text: `Body: ${lower(BODY_LABEL.back_cracked)} — repair before grading.` });
  if (condition && condition.issues.length)
    nr.push({ code: "NR5", text: `Condition: ${[...condition.issues].sort().map((i) => lower(ISSUE_LABEL[i])).join(", ")}.` });
  if (battery.pct !== null && battery.pct < BATTERY_HEALTH_PASS_PCT) {
    nr.push({ code: "NR6", text: `Battery health ${battery.pct} % — under ${BATTERY_HEALTH_PASS_PCT} %.` });
  }
  for (const l of failedLines.filter((l) => !l.key && FAIL_FAULT[l.id])) {
    // battery_health is NR6's, from the readings — unless a fail came with no figure at all.
    if (l.id === BATTERY_HEALTH_ID && battery.pct !== null) continue;
    nr.push({ code: "NR7", text: `${l.name} failed${failedBy(l.id)}.` });
  }
  if (faults.includes("battery_swollen")) {
    nr.push({ code: "NR8", text: "Swollen battery." });
    disclosures.push({ code: "DS1", text: "Swollen battery — do not charge; safety." });
  }

  /* — incomplete — */
  const untestedKey = merged.lines.filter((l) => l.key && (l.result === "not_tested" || l.result === "not_on_phone"));
  if (input.evidence.length && untestedKey.length) {
    const onlyPc = pcSources.length === input.evidence.length;
    const parts = untestedKey.map((l) => {
      const extra: string[] = [];
      if (l.result === "not_on_phone") extra.push("can't run on this phone");
      else if (!l.sources.length && onlyPc) extra.push(l.id === "charging" ? "Phonecheck doesn't test the charging port" : "Phonecheck didn't report it");
      else {
        const reason = merged.results[l.id]?.detail?.reason;
        if (typeof reason === "string" && reason.trim()) extra.push(reason.trim().slice(0, 160));
        else if (l.sources.some((s) => s.outcome === "pending")) extra.push("pending on Phonecheck");
      }
      return { name: l.name, why: extra.join("; ") };
    });
    // The one-line why stays short (it is the answer's and the report headline's line): the names,
    // at most three. Each test's own reason is its own line behind "Show details" (IC2).
    const names = parts.map((p) => p.name);
    const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
    ic.push({ code: "IC1", text: `Not tested: ${join(shown)}.` });
    for (const p of parts) if (p.why) ic.push({ code: "IC2", text: `${p.name}: ${p.why}.` });
  }

  /* — status — */
  const status: GradingStatus = nt.length ? "not_tested" : cg.length ? "cannot_grade" : nr.length ? "needs_repair" : ic.length ? "incomplete" : "graded";
  // The screen and body as recorded, never better than the case's own faults
  // imply (a frame_damage fault on a body recorded "flawless" still grades bent).
  const floor = condition ? conditionFromFaults(faults, condition) : null;
  const seen =
    condition && floor
      ? {
          screen: SCREEN_ORDER.indexOf(floor.screen) > SCREEN_ORDER.indexOf(condition.screen) ? floor.screen : condition.screen,
          body: BODY_ORDER.indexOf(floor.body) > BODY_ORDER.indexOf(condition.body) ? floor.body : condition.body,
        }
      : null;
  const cosmetic = cosmeticGrade(seen);

  /* — provisional — */
  // The camera didn't grade it: each of the screen and the body needs the advisor's certification instead.
  const cameraFinal = !!camera && camera.state === "ready" && camera.final;
  const bothCertified = certified("screen") && certified("body");
  if (!cameraFinal) {
    const open = (["screen", "body"] as const).filter((r) => !certified(r));
    const st = camera?.state === "failed" ? "failed" : camera?.status ?? "none";
    if (open.length === 2) {
      const text =
        st === "failed"
          ? "Camera grading failed — recorded by eye."
          : st === "grading" || st === "provisional" || st === "final"
            ? "Camera grade not final."
            : "Not camera-graded — recorded by eye.";
      provisional.push({ code: "PV1", text });
    } else if (open.length === 1) provisional.push({ code: "PV1", text: `${cap(open[0])} not camera-graded or certified.` });
  }
  // The camera's own letters (GradeIQ's Premium–D) never appear here: they would
  // read as the A–D above, which is the SwapUp grade.
  if (camera && camera.conclusive === false && !bothCertified) provisional.push({ code: "PV2", text: "Camera grade not conclusive — check by eye." });
  if (camera?.needsHumanReview && !bothCertified) provisional.push({ code: "PV3", text: "Camera grade needs a review." });
  for (const s of camera?.suggested ?? []) {
    if (faults.includes(s.id)) continue;
    // A bent frame or a cracked back is what the advisor looks at for the body; a lens still needs its own look.
    if ((s.id === "frame_damage" || s.id === "back_cracked") && certified("body")) continue;
    provisional.push({ code: "PV4", text: `Camera saw ${lower(FAULT_BY_ID[s.id].label)} — not on the case; check by eye.` });
  }
  if (battery.pct === null) provisional.push({ code: "PV5", text: "Battery health not read." });
  let pv6 = 0;
  for (const l of failedLines) {
    if (l.id === "camera" || FAIL_FAULT[l.id]) continue;
    const issue = NOTE_ONLY[l.id];
    if (issue && condition?.issues.includes(issue)) continue;
    provisional.push({ code: "PV6", text: `${l.name} failed — not a SwapUp fault; confirm by hand.` });
    pv6++;
  }
  for (const e of pcSources)
    for (const o of e.pc?.other ?? [])
      if (o.result === "failed") {
        provisional.push({ code: "PV6", text: `${o.name} failed on Phonecheck — not a SwapUp fault; confirm by hand.` });
        pv6++;
      }
  if (evidence.some((e) => e.source === "phonecheck_upload")) provisional.push({ code: "PV7", text: "Phonecheck results uploaded by staff, not fetched." });
  if (pcSources.some((e) => e.pc?.aiRead)) provisional.push({ code: "PV12", text: "Phonecheck report read by AI — check the figures." });
  if (input.phonecheckImeiOverride)
    provisional.push({ code: "PV8", text: `Phonecheck IMEI differs — attached by ${input.phonecheckImeiOverride.by}: ${input.phonecheckImeiOverride.reason}` });
  const cosmeticFails = [...new Set(pcSources.flatMap((e) => e.pc?.cosmeticFails ?? []))];
  for (const name of cosmeticFails)
    if (!cosmeticMatched(name, condition, faults)) provisional.push({ code: "PV9", text: `Phonecheck failed "${name}"; no damage on the case — check by eye.` });
  if (camera?.final && (cosmetic === "Superb" || cosmetic === "Good")) {
    for (const c of input.cameraComponents ?? []) {
      if ((c.id === "front" || c.id === "back" || c.id === "frame") && (c.grade === "C" || c.grade === "D") && !certified(c.id === "front" ? "screen" : "body"))
        provisional.push({ code: "PV10", text: `Camera rated the ${COMPONENT_LABEL[c.id]} low — check by eye.` });
    }
  }
  if (camera?.lcd.verdict === "fail" && camera.lcd.confirmed !== true && lineOf.get("display")?.result === "passed" && !certified("screen")) {
    const doubt = camera.lcd.doubt ?? "the screen sweep wasn't sure";
    provisional.push({ code: "PV11", text: `${cap(doubt)}; display test passed — check by eye.` });
  }
  // PV13 is retired (review 0.9.4): since SUP-260 nothing shows the test colours after the tests, so a
  // screen certified without them can never be made otherwise — it is the advisor's look the owner chose,
  // disclosed below (DS11), never a provisional grade nobody can clear.

  /* — disclosures — */
  if (input.pcFacts?.parts === "not_genuine") disclosures.push({ code: "DS2", text: "Phonecheck reports a part that isn't original." });
  if (input.cameraOem === "suspect_aftermarket") disclosures.push({ code: "DS2", text: "Camera suspects a part that isn't original." });
  if (input.pcFacts?.deviceLock === "on") disclosures.push({ code: "DS3", text: "Activation lock on — the customer signs out before hand-over." });
  for (const o of camera?.overrides ?? []) disclosures.push({ code: "DS4", text: `Recorded better than the camera saw, by ${o.by}: ${o.reason}` });
  if (camera?.identityOverride)
    disclosures.push({ code: "DS5", text: `Camera doubted the phone; ${camera.identityOverride.by} checked it: ${camera.identityOverride.reason}` });
  let ds6 = 0;
  for (const l of failedLines) {
    const missing = faultsForFailedTest(l.id, merged.results[l.id]?.detail ?? null).filter((any) => !any.some((f) => faults.includes(f)));
    for (const m of missing) {
      disclosures.push({ code: "DS6", text: `${l.name} failed; fault not on the case (${lower(FAULT_BY_ID[m[0]].label)}).` });
      ds6++;
    }
  }
  if (input.browserRun) disclosures.push({ code: "DS7", text: BROWSER_NOTE });
  if (cert?.liquid?.value === "cant_see") disclosures.push({ code: "DS9", text: `Liquid indicator not checked — ${cert.liquid.by} couldn't see it.` });
  // A clean screen whose display rests on the advisor's look alone (no camera sweep checked every colour,
  // no test colours shown): said, by name — it is how the screen was checked, not a doubt about the grade.
  if (advisor && cert?.screen && !cert.screen.withColours && advisor.results.display.outcome === "pass" && camera?.lcd.cameraChecked !== true)
    disclosures.push({ code: "DS11", text: `${cert.screen.by} checked the screen by eye.` });
  // The advisor recorded better than the camera CONFIRMED: the camera's finding stands (certifyRow kept the floor) —
  // unless a recorded reason overruled it (DS4 says so), when the advisor's look is what was priced.
  const floor0 = camera?.floor ? standingFloor({ floor: camera.floor, overrides: camera.overrides }) : undefined;
  if (cameraFinal && floor0) {
    const sc = cert?.screen ? certChoice("screen", cert.screen.value)?.screen : undefined;
    if (cert?.screen && sc && SCREEN_ORDER.indexOf(sc) < SCREEN_ORDER.indexOf(floor0.screen))
      disclosures.push({ code: "DS10", text: `Camera found ${lower(SCREEN_LABEL[floor0.screen])}; ${cert.screen.by} certified "${cert.screen.label}" — camera stands.` });
    const bd = cert?.body ? certChoice("body", cert.body.value)?.body : undefined;
    if (cert?.body && bd && BODY_ORDER.indexOf(bd) < BODY_ORDER.indexOf(floor0.body))
      disclosures.push({ code: "DS10", text: `Camera found ${lower(BODY_LABEL[floor0.body])}; ${cert.body.by} certified "${cert.body.label}" — camera stands.` });
    for (const sg of camera?.suggested ?? [])
      if ((sg.id === "frame_damage" || sg.id === "back_cracked") && cert?.body && !faults.includes(sg.id))
        disclosures.push({ code: "DS10", text: `Camera saw ${lower(FAULT_BY_ID[sg.id].label)}; ${cert.body.by} recorded the body "${cert.body.label}".` });
  }
  if (input.pcModelMismatch)
    disclosures.push({
      code: "DS8",
      text: `Phonecheck says ${input.pcModelMismatch.phonecheck}; case says ${input.pcModelMismatch.case ?? "no model"} — case kept.`,
    });

  /* — the grade itself — */
  const gradeOut = status === "graded" ? cosmetic : null;
  const final = status === "graded" && gradeOut !== null && provisional.length === 0;
  const ceiling = status === "incomplete" ? cosmetic : null;
  if (seen && cosmetic) {
    const what = `Screen ${lower(SCREEN_LABEL[seen.screen])}, body ${lower(BODY_LABEL[seen.body])}`;
    if (status === "graded") g.push({ code: "G1", text: `${what}.` });
    else if (status === "incomplete") g.push({ code: "G1", text: `${what} — at best ${gradeWithLetter(cosmetic)}.` });
  }

  /* — repairs, and the grade after them — */
  const p = partsForFaults(repairFaults);
  const repairs = { faults: repairFaults, parts: p.parts, inspection: p.inspectionFaults };
  let afterRepair: MarketGrade | null = null;
  // Never while a key test has no result (IC1): nobody can say what an untested phone grades after repair.
  if (status === "needs_repair" && condition && !untestedKey.length && !repairs.inspection.length && !pv6 && !ds6) {
    // Every reason it needs repair must be a recorded fault with a part — otherwise
    // nobody can say what it grades after the repair.
    const repaired = conditionFromFaults(repairFaults, condition);
    const explained =
      condition.issues.every((i) => repaired.issues.includes(i)) &&
      (!OFF_LADDER_SCREEN.includes(condition.screen) || OFF_LADDER_SCREEN.includes(repaired.screen)) &&
      (condition.body !== "back_cracked" || repairFaults.includes("back_cracked")) &&
      condition.powersOn &&
      condition.calls &&
      (battery.pct === null || battery.pct >= BATTERY_HEALTH_PASS_PCT || repairFaults.includes("battery_drain") || repairFaults.includes("battery_swollen"));
    if (explained) afterRepair = gradeAfterRefurb(condition);
  }

  return {
    ruleset: GRADING_RULESET_VERSION,
    status,
    grade: gradeOut,
    letter: gradeLetter(gradeOut),
    final,
    label: gradingLabel(status, gradeOut, final),
    cosmetic,
    ceiling,
    afterRepair,
    repairs,
    reasons: [...nt, ...cg, ...nr, ...ic, ...g],
    provisional,
    disclosures,
    tests: merged.lines,
    otherTests: pcSources.flatMap((e) => (e.pc?.other ?? []).map((o) => ({ name: o.name, result: o.result, source: e.source, manual: o.manual }))),
    battery,
  };
}
