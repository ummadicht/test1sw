/**
 * WHAT THE STORE CAMERA SAW — GradeIQ's cosmetic grade in SwapUp's language.
 *
 * SwapUp is built on GradeIQ: every test session has a GradeIQ session behind
 * it, and the STORE device photographs the customer's phone with GradeIQ's
 * camera page while the customer's phone echoes the screen patterns. GradeIQ
 * answers with per-component grades and located findings (type, severity,
 * confidence, photo, box) plus an LCD sweep verdict. This module turns that
 * into what the counter works with: SwapUp faults, a condition floor, flags
 * for a person to look at, and the places where the customer, the phone's own
 * tests and the camera disagree. Contract: docs/GRADEIQ-INTEGRATION.md §3.
 *
 * The rules that carry the honesty of it:
 *   1. The camera may only make the phone WORSE. It never removes a fault and
 *      never improves a condition answer — and never downgrades what the
 *      customer declared.
 *   2. Only CONFIRMED damage changes the case: confidence ≥ 0.7, not
 *      `uncorroborated`, and located with a box (GradeIQ's own structural bar).
 *      Anything weaker is a flag for a person, never a fault.
 *   3. Only a FINAL grade feeds the case (§3.3). A provisional, obstructed,
 *      stubbed or missing grade is "not camera-graded" — never a letter, a fault
 *      or a condition. There is no fallback grade of any kind.
 *   4. The grade letter is shown to staff, never priced. The partner prices
 *      SwapUp's condition answers.
 *
 * Pure functions only — no database, no network, no clock (callers pass times).
 */
import {
  type FaultId,
  type ScreenState,
  type BodyState,
  type ConditionAnswers,
  FAULT_BY_ID,
  SCREEN_ORDER,
  BODY_ORDER,
  SCREEN_LABEL,
  BODY_LABEL,
} from "./condition.ts";
import type { Declared, TestOutcome, TestResults } from "./diagnostics.ts";

/* ─────────────────────────── GradeIQ's shapes (the slice SwapUp reads) ─────────────────────────── */

export type GiqSeverity = "minor" | "moderate" | "severe";
/** Normalised box on a photo: [ymin, xmin, ymax, xmax] in 0..1. */
export type GiqBox = [number, number, number, number];
export type GiqComponentId = "front" | "back" | "frame" | "cameras" | "display";

export type GiqFinding = {
  type: string;
  label: string;
  severity: GiqSeverity;
  confidence: number;
  photoIndex: number | null;
  box: GiqBox | null;
  location: string | null;
  uncorroborated: boolean;
};

export type GiqComponent = { id: GiqComponentId; name: string; grade: string; confidence: number | null; findings: GiqFinding[] };

export type GiqCapture = { verdict: string; code: string | null; reasons: string[]; attempt: number };

export type GiqDisplayCheck = {
  verdict: "pass" | "fail" | "unknown";
  confidence: number | null;
  note: string;
  findings: { type: string; label: string; confidence: number | null; pattern: string | null }[];
  patterns: string[];
  captures: { pattern: string; photo: string }[];
  requested: string[];
  missing: string[];
  reason: string | null;
};

export type IdentityVerdict = "match" | "mismatch" | "unverified";

/** GradeIQ's light /screen poll, read defensively. */
export type GiqScreen = {
  pattern: string;
  shown: string | null;
  cosmeticDone: boolean;
  handoffDone: boolean;
  capture: GiqCapture | null;
  connectedAt: string | null;
};

/**
 * What SwapUp keeps of one GradeIQ session (§3.3). A whitelist: GradeIQ's
 * `offer` (a price SwapUp never uses) and `staged` (base64 copies of every
 * photo, megabytes) can never reach it, because nothing copies them.
 */
export type GradeiqSnapshot = {
  fetchedAt: string;
  client: string;
  cosmeticGrade: string;
  functionalGrade: string;
  overallGrade: string;
  tierUsed: "stub" | "flash" | "pro" | null;
  visionModel: string | null;
  refining: boolean;
  conclusive: boolean | null;
  gradeRange: { best: string; worst: string } | null;
  needsHumanReview: boolean;
  coverage: number | null;
  score: number | null;
  components: GiqComponent[];
  obstruction: { present: boolean; type: string; note: string } | null;
  oem: { verdict: string; confidence: number | null; evidence: string[] } | null;
  device: { make: string; model: string; match: string; reason: string } | null;
  capture: GiqCapture | null;
  displayCheck: GiqDisplayCheck | null;
  /** GradeIQ's identity check. Missing → "unverified", never a pass. */
  identity: { verdict: IdentityVerdict; flags: string[] };
  /** Public photo URLs (GRADEIQ_PUBLIC_URL), in GradeIQ's photo-index order. */
  photos: string[];
};

/* ─────────────────────────── reading GradeIQ defensively ─────────────────────────── */

type O = Record<string, unknown>;
const obj = (v: unknown): O => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const COMPONENT_IDS: GiqComponentId[] = ["front", "back", "frame", "cameras", "display"];
const SEVERITIES: GiqSeverity[] = ["minor", "moderate", "severe"];

function readBox(v: unknown): GiqBox | null {
  const a = arr(v);
  if (a.length !== 4 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return a as GiqBox;
}

export function readFinding(v: unknown): GiqFinding {
  const f = obj(v);
  const sev = text(f.severity, 20).toLowerCase() as GiqSeverity;
  return {
    type: text(f.type, 40).toLowerCase().trim(),
    label: text(f.label, 160),
    severity: SEVERITIES.includes(sev) ? sev : "minor",
    confidence: numOrNull(f.confidence) ?? 0,
    photoIndex: numOrNull(f.photoIndex),
    box: readBox(f.box),
    location: text(f.location, 160) || null,
    uncorroborated: f.uncorroborated === true,
  };
}

export function readCapture(v: unknown): GiqCapture | null {
  const c = obj(v);
  const verdict = text(c.verdict, 20);
  if (!verdict) return null;
  return { verdict, code: text(c.code, 40) || null, reasons: arr(c.reasons).map((r) => text(r, 200)).filter(Boolean).slice(0, 10), attempt: numOrNull(c.attempt) ?? 0 };
}

/**
 * A GradeIQ photo path → a URL a staff device can open. GradeIQ stores
 * `/api/uploads/<file>` and its export builds absolute URLs from whatever
 * origin the request came in on (127.0.0.1 on the VM), so everything is
 * re-rooted on GRADEIQ_PUBLIC_URL.
 */
export function publicPhotoUrl(path: unknown, publicUrl: string): string | null {
  const s = text(path, 500);
  if (!s) return null;
  const base = publicUrl.replace(/\/$/, "");
  const at = s.indexOf("/api/uploads/");
  if (at >= 0) return `${base}${s.slice(at)}`;
  if (s.startsWith("/")) return `${base}${s}`;
  return null;
}

export function readScreen(v: unknown): GiqScreen {
  const s = obj(v);
  return {
    pattern: text(s.pattern, 20) || "idle",
    shown: typeof s.shown === "string" ? s.shown.slice(0, 20) : null,
    cosmeticDone: s.cosmeticDone === true,
    handoffDone: s.handoffDone === true,
    capture: readCapture(s.capture),
    connectedAt: text(s.connectedAt, 40) || null,
  };
}

function readDisplayCheck(v: unknown, publicUrl: string): GiqDisplayCheck | null {
  const d = obj(v);
  const verdict = text(d.verdict, 10);
  if (!verdict) return null;
  const captures = arr(d.captures)
    .map((c) => ({ pattern: text(obj(c).pattern, 20), photo: publicPhotoUrl(obj(c).photo, publicUrl) ?? "" }))
    .filter((c) => c.photo);
  return {
    verdict: verdict === "pass" || verdict === "fail" ? verdict : "unknown",
    confidence: numOrNull(d.confidence),
    note: text(d.note, 300),
    findings: arr(d.findings)
      .slice(0, 20)
      .map((f) => ({ type: text(obj(f).type, 40), label: text(obj(f).label, 160), confidence: numOrNull(obj(f).confidence), pattern: text(obj(f).pattern, 20) || null })),
    patterns: arr(d.patterns).map((p) => text(p, 20)).filter(Boolean),
    captures,
    requested: arr(d.requested).map((p) => text(p, 20)).filter(Boolean),
    missing: arr(d.missing).map((p) => text(p, 20)).filter(Boolean),
    reason: text(d.reason, 200) || null,
  };
}

/**
 * GET /api/sessions/{id} → the snapshot SwapUp stores. The capture verdict is
 * derived the way GradeIQ's own /screen derives it (the `capture` column
 * first, then the copy mirrored into the screen blob).
 */
export function readSnapshot(raw: unknown, publicUrl: string, fetchedAt: string): GradeiqSnapshot {
  const s = obj(raw);
  const cos = obj(s.cosmetic);
  const screen = obj(s.screen);
  const ident = obj(s.identity);
  const tier = text(cos.tierUsed, 10);
  const range = obj(cos.gradeRange);
  const obstruction = obj(cos.obstruction);
  const oem = obj(cos.oem);
  const device = obj(cos.device);
  const identVerdict = text(ident.verdict, 12);
  return {
    fetchedAt,
    client: text(s.client_id, 40),
    cosmeticGrade: text(s.cosmetic_grade, 10),
    functionalGrade: text(s.functional_grade, 10),
    overallGrade: text(s.overall_grade, 30),
    tierUsed: tier === "stub" || tier === "flash" || tier === "pro" ? tier : null,
    visionModel: text(cos.visionModel, 80) || null,
    refining: cos.refining === true,
    conclusive: typeof cos.conclusive === "boolean" ? cos.conclusive : null,
    gradeRange: text(range.best, 10) && text(range.worst, 10) ? { best: text(range.best, 10), worst: text(range.worst, 10) } : null,
    needsHumanReview: cos.needsHumanReview === true,
    coverage: numOrNull(cos.coverage),
    score: numOrNull(cos.score),
    components: arr(cos.specialists)
      .map((x) => {
        const c = obj(x);
        const id = text(c.id, 12) as GiqComponentId;
        if (!COMPONENT_IDS.includes(id)) return null;
        return { id, name: text(c.name, 60), grade: text(c.grade, 10), confidence: numOrNull(c.confidence), findings: arr(c.findings).slice(0, 40).map(readFinding) };
      })
      .filter((c): c is GiqComponent => !!c),
    obstruction: Object.keys(obstruction).length ? { present: obstruction.present === true, type: text(obstruction.type, 40), note: text(obstruction.note, 200) } : null,
    oem: text(oem.verdict, 30) ? { verdict: text(oem.verdict, 30), confidence: numOrNull(oem.confidence), evidence: arr(oem.evidence).map((e) => text(e, 200)).filter(Boolean).slice(0, 8) } : null,
    device: text(device.match, 12) ? { make: text(device.make, 40), model: text(device.model, 80), match: text(device.match, 12), reason: text(device.reason, 300) } : null,
    capture: readCapture(obj(s.capture).verdict ? s.capture : screen.capture),
    displayCheck: readDisplayCheck(screen.displayCheck, publicUrl),
    identity: {
      verdict: identVerdict === "match" || identVerdict === "mismatch" ? identVerdict : "unverified",
      flags: arr(ident.flags).map((f) => text(f, 300)).filter(Boolean).slice(0, 10),
    },
    photos: arr(s.photos).map((p) => publicPhotoUrl(p, publicUrl)).filter((p): p is string => !!p),
  };
}

/* ─────────────────────────── finality (§3.3) ─────────────────────────── */

export type Finality = {
  status: "none" | "grading" | "provisional" | "final" | "failed";
  final: boolean;
  /** A grade exists but may not be used: shown as provisional, never applied. */
  provisional: boolean;
  /** Why it is not final (empty when final). Sentences for the advisor. */
  reasons: string[];
};

/**
 * A cosmetic grade is FINAL only when all of these hold: a grade letter, a real
 * model tier (not the offline stub), no refinement still running, the capture
 * gate said ok, and no case or cover on the phone. GradeIQ's `status` is
 * ignored: a cosmetic-only session still reads "open".
 *
 * `timedOut`: SwapUp stopped waiting (180 s after the photos were accepted).
 */
export function finality(s: GradeiqSnapshot | null, opts: { timedOut: boolean } = { timedOut: false }): Finality {
  const out = (status: Finality["status"], reasons: string[]): Finality => ({ status, final: status === "final", provisional: status === "provisional", reasons });
  if (!s) return out("none", ["Not camera-graded yet."]);
  if (s.tierUsed === "stub") return out("failed", ["Camera grading failed. Check condition by eye."]);
  const reasons: string[] = [];
  if (s.capture?.verdict === "retake") reasons.push(`The camera's photos were rejected${s.capture.reasons.length ? `: ${s.capture.reasons.join("; ")}` : ""}. Retake them.`);
  if (s.obstruction?.present) reasons.push(`A ${s.obstruction.type || "case or cover"} was on the phone. Remove it and retake — the grade is not used.`);
  if (!s.cosmeticGrade) {
    if (s.refining && !opts.timedOut) return out("grading", ["The camera grade is still being worked out."]);
    if (s.coverage !== null && s.coverage < 0.5 && s.tierUsed) return out("failed", ["Not enough of the phone was visible. Retake."]);
    if (opts.timedOut) return out("failed", ["No camera grade came back. Check condition by eye."]);
    return out(reasons.length ? "provisional" : "grading", reasons.length ? reasons : ["Waiting for the camera grade."]);
  }
  if (!s.tierUsed) reasons.push("GradeIQ did not say which model graded it, so the grade is not used.");
  if (s.refining) reasons.push(opts.timedOut ? "Provisional grade (final check did not finish). Confirm by eye." : "Provisional grade — the final check is still running.");
  if (s.capture?.verdict !== "ok" && s.capture?.verdict !== "retake") reasons.push("The camera's photos were not accepted yet.");
  return reasons.length ? out("provisional", reasons) : out("final", []);
}

/* ─────────────────────────── the confirmed bar ─────────────────────────── */

export const CONFIRMED_CONFIDENCE = 0.7;

/** GradeIQ's own structural bar: confident, corroborated and located. */
export function isConfirmed(f: Pick<GiqFinding, "confidence" | "uncorroborated" | "box">): boolean {
  return f.confidence >= CONFIRMED_CONFIDENCE && !f.uncorroborated && !!f.box;
}

const WEAR = new Set(["scratch", "scuff", "wear"]);
const BEND_WORDS = /\b(bent|bend|bowed|warp|warped|twist|twisted|deform)/i;
const pct = (c: number | null) => (c === null ? "?" : `${Math.round(c * 100)}%`);
const photoRef = (i: number | null) => (i === null ? "" : `, photo ${i + 1}`);

export const COMPONENT_LABEL: Record<GiqComponentId, string> = {
  front: "front glass",
  back: "back",
  frame: "frame",
  cameras: "rear cameras",
  display: "display (screen on)",
};

/* ─────────────────────────── mapping onto SwapUp (§3.4) ─────────────────────────── */

export type CameraFault = {
  id: FaultId;
  because: string;
  component: GiqComponentId | "display_check";
  confidence: number | null;
  photoIndex: number | null;
  box: GiqBox | null;
};

export type FindingEffect = "fault" | "condition" | "suggested" | "flag" | "none";

export type MappedFinding = {
  component: GiqComponentId;
  componentLabel: string;
  type: string;
  label: string;
  severity: GiqSeverity;
  confidence: number;
  confirmed: boolean;
  photoIndex: number | null;
  photoUrl: string | null;
  box: GiqBox | null;
  location: string | null;
  /** What it means in SwapUp's words, e.g. "Cracked glass". null = nothing SwapUp records. */
  meaning: string | null;
  effect: FindingEffect;
};

export type CameraFloor = { screen: ScreenState; body: BodyState };
export const NO_FLOOR: CameraFloor = { screen: "flawless", body: "flawless" };

export type LcdCheck = { cameraChecked: boolean; verdict: "pass" | "fail" | "unknown" | null; reason: string | null };

export type CameraMapping = {
  /** The cosmetic grade is final, so its confirmed findings feed the case. */
  usable: boolean;
  /** Condition the camera confirms — the advisor may record worse, never better. */
  floor: CameraFloor;
  /** Added to the case at Apply, tagged source "camera_ai". */
  faults: CameraFault[];
  /** Shown to the advisor, never added (no part, or the lens needs a look). */
  suggested: CameraFault[];
  /** For a person to look at. Never a fault, never a condition. */
  flags: string[];
  findings: MappedFinding[];
  lcd: LcdCheck;
  identity: { verdict: IdentityVerdict; reasons: string[] };
};

export type CameraOverrideInfo = { by: string; reason: string; at: string } | null;

/**
 * GradeIQ's result → what SwapUp records. `lcdOverride`: staff unlocked the
 * camera without the customer's phone echoing patterns, so whatever the sweep
 * says, the LCD was not checked by the camera in a closed loop.
 */
export function mapCamera(s: GradeiqSnapshot | null, fin: Finality, opts: { lcdOverride?: CameraOverrideInfo } = {}): CameraMapping {
  const faults: CameraFault[] = [];
  const suggested: CameraFault[] = [];
  const flags: string[] = [];
  const findings: MappedFinding[] = [];
  let floor: CameraFloor = { ...NO_FLOOR };
  const worseScreen = (x: ScreenState) => (floor = { ...floor, screen: SCREEN_ORDER.indexOf(x) > SCREEN_ORDER.indexOf(floor.screen) ? x : floor.screen });
  const worseBody = (x: BodyState) => (floor = { ...floor, body: BODY_ORDER.indexOf(x) > BODY_ORDER.indexOf(floor.body) ? x : floor.body });
  const addFault = (list: CameraFault[], f: CameraFault) => {
    if (!list.some((x) => x.id === f.id)) list.push(f);
  };

  if (s) {
    for (const c of s.components) {
      const label = COMPONENT_LABEL[c.id];
      // Without screen-on frames GradeIQ drops the display grade; a display
      // finding without a grade describes a screen nobody photographed lit.
      const assessed = !!c.grade;
      for (const f of c.findings) {
        const confirmed = isConfirmed(f);
        const seen = `${f.label || f.type} on the ${label} (${pct(f.confidence)}${photoRef(f.photoIndex)})`;
        let meaning: string | null = null;
        let effect: FindingEffect = "none";
        const flag = (why: string) => {
          effect = "flag";
          flags.push(why);
        };
        const fault = (id: FaultId, list: CameraFault[], kind: "fault" | "suggested") => {
          effect = kind;
          addFault(list, { id, because: `Camera saw ${seen}`, component: c.id, confidence: f.confidence, photoIndex: f.photoIndex, box: f.box });
        };
        const t = f.type;
        const notMinor = f.severity !== "minor";
        if (c.id === "front") {
          if (t === "crack" || t === "chip") {
            meaning = SCREEN_LABEL.cracked;
            if (confirmed && (t === "crack" || notMinor)) {
              fault("screen_cracked", faults, "fault");
              worseScreen("cracked");
            } else flag(`Camera may have seen a ${t} on the screen glass (${pct(f.confidence)}${photoRef(f.photoIndex)}). Look at the photo.`);
          } else if (WEAR.has(t)) {
            meaning = SCREEN_LABEL.scratched;
            // GradeIQ's A means faint micro-scratches: A and Premium stay flawless.
            if (confirmed && (notMinor || c.grade === "B" || c.grade === "C")) {
              effect = "condition";
              worseScreen("scratched");
            }
          }
        } else if (c.id === "display") {
          if (t === "deadpixel" || t === "discoloration") {
            meaning = SCREEN_LABEL.lines_or_spots;
            if (!assessed) effect = "none";
            else if (confirmed) {
              fault("display_lines", faults, "fault");
              worseScreen("lines_or_spots");
            } else flag(`Camera may have seen ${f.label || t} on the lit screen (${pct(f.confidence)}${photoRef(f.photoIndex)}). Check the display by eye.`);
          }
        } else if (c.id === "back") {
          if (t === "crack" || t === "chip") {
            meaning = BODY_LABEL.back_cracked;
            if (confirmed && (t === "crack" || notMinor)) {
              fault("back_cracked", faults, "fault");
              worseBody("back_cracked");
            } else flag(`Camera may have seen a ${t} on the back (${pct(f.confidence)}${photoRef(f.photoIndex)}). Look at the photo.`);
          } else if (WEAR.has(t)) {
            meaning = BODY_LABEL.scuffed;
            if (confirmed && notMinor) {
              effect = "condition";
              worseBody("scuffed");
            }
          }
        } else if (c.id === "frame") {
          const bend = f.severity === "severe" && (BEND_WORDS.test(f.label) || BEND_WORDS.test(f.location ?? ""));
          // GradeIQ's structural rule: frame damage counts only when severe —
          // a chipped corner of anodising is finish wear, a bent rail is not.
          if ((t === "crack" && f.severity === "severe") || (t === "dent" && bend)) {
            meaning = BODY_LABEL.bent;
            if (confirmed) {
              fault("frame_damage", suggested, "suggested");
              worseBody("bent");
            } else flag(`Camera may have seen a bent or broken frame (${pct(f.confidence)}${photoRef(f.photoIndex)}). Inspect the frame.`);
          } else if (t === "crack") {
            meaning = BODY_LABEL.bent;
            flag(`Camera saw a ${f.severity} crack on the frame (${pct(f.confidence)}${photoRef(f.photoIndex)}). Inspect it — only a severe one counts as a broken frame.`);
          } else if (t === "dent") {
            meaning = BODY_LABEL.dented;
            if (confirmed) {
              effect = "condition";
              worseBody("dented");
            } else flag(`Camera may have seen a dent on the frame (${pct(f.confidence)}${photoRef(f.photoIndex)}).`);
          } else if (WEAR.has(t)) {
            meaning = BODY_LABEL.scuffed;
            if (confirmed && notMinor) {
              effect = "condition";
              worseBody("scuffed");
            }
          }
        } else if (c.id === "cameras") {
          if (t === "crack" || t === "chip") {
            const side: FaultId = /\b(front|selfie)\b/i.test(`${f.label} ${f.location ?? ""}`) ? "front_camera" : "rear_camera";
            meaning = FAULT_BY_ID[side].label;
            if (confirmed) fault(side, suggested, "suggested");
            else flag(`Camera may have seen ${t === "crack" ? "a cracked" : "a chipped"} camera lens (${pct(f.confidence)}${photoRef(f.photoIndex)}). Look at the lens.`);
          }
        }
        findings.push({
          component: c.id,
          componentLabel: label,
          type: f.type,
          label: f.label,
          severity: f.severity,
          confidence: f.confidence,
          confirmed,
          photoIndex: f.photoIndex,
          photoUrl: f.photoIndex !== null ? (s.photos[f.photoIndex] ?? null) : null,
          box: f.box,
          location: f.location,
          meaning,
          effect,
        });
      }
      if (!assessed && s.cosmeticGrade) flags.push(`The camera did not see the ${label}.`);
    }

    if (s.cosmeticGrade) {
      if (s.conclusive === false) flags.push(`Camera grade ${s.gradeRange ? `${s.gradeRange.best}–${s.gradeRange.worst}` : s.cosmeticGrade}, not conclusive. Confirm by eye.`);
      if (s.needsHumanReview) flags.push("GradeIQ asks for a person to review this grade.");
      if (s.cosmeticGrade === "D" && !faults.length && !suggested.length) flags.push("Camera grade D with no confirmed crack or break. Needs a person to look.");
    }
    if (s.oem?.verdict === "suspect_aftermarket") flags.push(`Possible non-original part${s.oem.evidence.length ? `: ${s.oem.evidence[0]}` : ""}. SwapUp has no field for it — tell the partner.`);
  }

  // A provisional grade is shown, never applied: its faults and floor are
  // dropped, and what it would have added becomes a flag for a person.
  const usable = fin.final && !!s;
  const outFaults = usable ? faults : [];
  const outSuggested = usable ? suggested : [];
  if (!usable) {
    floor = { ...NO_FLOOR };
    for (const f of [...faults, ...suggested]) flags.push(`Not final, so not added: ${f.because}. Check it by eye.`);
  }

  // The LCD sweep is its own AI call on the lit screen — independent of the
  // cosmetic grade's finality.
  const dc = s?.displayCheck ?? null;
  let lcd: LcdCheck;
  if (!dc) {
    lcd = { cameraChecked: false, verdict: null, reason: "The camera's screen sweep has not run." };
  } else {
    const incomplete = dc.verdict === "unknown" || dc.missing.length > 0;
    lcd = {
      cameraChecked: !incomplete,
      verdict: dc.verdict,
      reason: incomplete ? dc.reason || (dc.missing.length ? `Not captured: ${dc.missing.join(", ")}.` : dc.note || "The sweep could not judge the screen.") : null,
    };
    if (dc.verdict === "fail") {
      if ((dc.confidence ?? 0) >= CONFIRMED_CONFIDENCE) {
        addFault(outFaults, {
          id: "display_lines",
          because: `Camera screen sweep failed (${pct(dc.confidence)})${dc.findings[0]?.label ? `: ${dc.findings[0].label}` : ""}`,
          component: "display_check",
          confidence: dc.confidence,
          photoIndex: null,
          box: null,
        });
        if (SCREEN_ORDER.indexOf("lines_or_spots") > SCREEN_ORDER.indexOf(floor.screen)) floor = { ...floor, screen: "lines_or_spots" };
      } else flags.push(`Camera screen sweep failed with low confidence (${pct(dc.confidence)}). Check the display by eye.`);
    }
  }
  if (opts.lcdOverride) {
    lcd = { cameraChecked: false, verdict: lcd.verdict, reason: `LCD not camera-checked — the camera was unlocked by ${opts.lcdOverride.by} before the customer's phone showed the patterns: ${opts.lcdOverride.reason}` };
  }
  if (!lcd.cameraChecked) flags.push(`LCD not camera-checked${lcd.reason ? `: ${lcd.reason}` : "."}`);

  return { usable, floor, faults: outFaults, suggested: outSuggested, flags: [...new Set(flags)], findings, lcd, identity: identityOf(s) };
}

/**
 * Is the photographed phone the phone on the case? Either GradeIQ check saying
 * "mismatch" is a mismatch; only GradeIQ's own "match" (with the camera not
 * disagreeing) is a match. Anything missing is "unverified" — never a pass.
 */
export function identityOf(s: GradeiqSnapshot | null): { verdict: IdentityVerdict; reasons: string[] } {
  if (!s) return { verdict: "unverified", reasons: ["Not camera-graded."] };
  const reasons: string[] = [];
  if (s.device?.match === "mismatch") reasons.push(`The camera says this is ${[s.device.make, s.device.model].filter(Boolean).join(" ") || "a different phone"}: ${s.device.reason}`.trim());
  if (s.identity.verdict === "mismatch") reasons.push(...(s.identity.flags.length ? s.identity.flags : ["GradeIQ's identity check says this is not the phone on the record."]));
  if (reasons.length) return { verdict: "mismatch", reasons };
  if (s.identity.verdict === "match") return { verdict: "match", reasons: [] };
  return { verdict: "unverified", reasons: s.identity.flags };
}

/* ─────────────────────────── the shared 'display' key (§3.2) ─────────────────────────── */

const DISPLAY_RANK: Record<"skip" | "pass" | "fail", number> = { skip: 0, pass: 1, fail: 2 };

/**
 * GradeIQ keeps ONE `display` result, and its camera sweep overwrites it. So
 * SwapUp always sends the worse of its own self-test and the camera's verdict,
 * with fail > pass > skip. An unknown camera verdict is a skip (GradeIQ's own
 * mapping), so it never erases a self-test pass.
 */
export function worseDisplay(selfTest: TestOutcome | null | undefined, camera: "pass" | "fail" | "unknown" | null | undefined): "pass" | "fail" | "skip" | null {
  const a = selfTest ? (selfTest === "unsupported" ? "skip" : selfTest) : null;
  const b = camera ? (camera === "unknown" ? "skip" : camera) : null;
  if (!a) return b;
  if (!b) return a;
  return DISPLAY_RANK[a] >= DISPLAY_RANK[b] ? a : b;
}

/**
 * SwapUp's results → the FULL map GradeIQ is sent every time (always with
 * merge:true). unsupported → skip: GradeIQ would store any string as-is and its
 * passport would render a state its type does not allow. `detail` stays in
 * SwapUp. Keys are sorted so the same results always hash the same.
 */
export function gradeiqFunctionalMap(results: TestResults, cameraDisplay: "pass" | "fail" | "unknown" | null = null): Record<string, "pass" | "fail" | "skip"> {
  const out: Record<string, "pass" | "fail" | "skip"> = {};
  for (const id of Object.keys(results).sort()) {
    const o = results[id].outcome;
    out[id] = o === "unsupported" ? "skip" : o;
  }
  const d = worseDisplay(results.display?.outcome, cameraDisplay);
  if (d) out.display = d;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/* ─────────────────────────── condition + overrides (§3.5) ─────────────────────────── */

/** Condition answers made no better than what the camera confirmed. */
export function applyCameraFloor(answers: ConditionAnswers, floor: CameraFloor): ConditionAnswers {
  return {
    ...answers,
    screen: SCREEN_ORDER.indexOf(floor.screen) > SCREEN_ORDER.indexOf(answers.screen) ? floor.screen : answers.screen,
    body: BODY_ORDER.indexOf(floor.body) > BODY_ORDER.indexOf(answers.body) ? floor.body : answers.body,
  };
}

/** What the camera put on a case at Apply — the part an advisor edit is checked against. */
export type CameraEvidence = { floor: CameraFloor; faults: { id: FaultId; because: string; photoIndex: number | null }[] };

/**
 * Where an edit records the phone as BETTER than the camera confirmed. Each
 * item is { key, why }: key identifies what is overridden (so one recorded
 * override covers it from then on), why is a sentence for the advisor.
 * Worse than the camera is always fine.
 */
export function cameraOverrideProblems(answers: ConditionAnswers | null, faults: FaultId[], camera: CameraEvidence | null): { key: string; why: string }[] {
  if (!camera) return [];
  const out: { key: string; why: string }[] = [];
  for (const f of camera.faults) {
    if (!faults.includes(f.id)) out.push({ key: `fault:${f.id}`, why: `The camera confirmed "${FAULT_BY_ID[f.id].label}"${photoRef(f.photoIndex)}. Removing it needs a reason.` });
  }
  if (answers) {
    if (SCREEN_ORDER.indexOf(answers.screen) < SCREEN_ORDER.indexOf(camera.floor.screen))
      out.push({ key: `screen:${camera.floor.screen}`, why: `The camera confirmed the screen as "${SCREEN_LABEL[camera.floor.screen]}". Recording "${SCREEN_LABEL[answers.screen]}" needs a reason.` });
    if (BODY_ORDER.indexOf(answers.body) < BODY_ORDER.indexOf(camera.floor.body))
      out.push({ key: `body:${camera.floor.body}`, why: `The camera confirmed the body as "${BODY_LABEL[camera.floor.body]}". Recording "${BODY_LABEL[answers.body]}" needs a reason.` });
  }
  return out;
}

/* ─────────────────────────── where each fault came from ─────────────────────────── */

export type FaultSource = "advisor" | "tested" | "declared" | "camera_ai";
export type FaultSources = Partial<Record<FaultId, FaultSource[]>>;
const SOURCE_ORDER: FaultSource[] = ["tested", "declared", "camera_ai", "advisor"];

/** Add sources; a fault may have several (the phone's test AND the camera). */
export function addFaultSources(prev: FaultSources, add: { id: FaultId; source: FaultSource }[]): FaultSources {
  const out: FaultSources = {};
  for (const [k, v] of Object.entries(prev)) out[k as FaultId] = [...(v ?? [])];
  for (const { id, source } of add) {
    const list = out[id] ?? [];
    if (!list.includes(source)) list.push(source);
    out[id] = list.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  }
  return out;
}

/** Sources for exactly the faults on the case: removed faults lose theirs; a fault with none was the advisor's. */
export function reconcileFaultSources(prev: FaultSources, faults: FaultId[]): FaultSources {
  const out: FaultSources = {};
  for (const f of faults) out[f] = prev[f]?.length ? [...prev[f]!] : ["advisor"];
  return out;
}

/* ─────────────────────────── disagreements (§3.5) ─────────────────────────── */

export type Disagreement = {
  topic: "screen" | "back" | "display" | "identity";
  customer: string | null;
  tested: string | null;
  camera: string;
  /** What the case records (the worse answer wins; the customer is never downgraded). */
  final: string;
  message: string;
  photoIndex: number | null;
  box: GiqBox | null;
};

/** Every place the customer, the phone's own tests and the camera disagree. Nothing is overwritten. */
export function disagreements(declared: Declared | null, results: TestResults, s: GradeiqSnapshot | null, m: CameraMapping, fin: Finality): Disagreement[] {
  const out: Disagreement[] = [];
  const glass = (topic: "screen" | "back", saidKey: "screenCracked" | "backCracked", fault: FaultId, comp: GiqComponentId, crackedWord: string) => {
    const said = declared?.[saidKey] ?? null;
    const cam = m.faults.find((f) => f.id === fault && f.component === comp);
    if (said === false && cam) {
      out.push({
        topic,
        customer: `not ${crackedWord}`,
        tested: null,
        camera: `${crackedWord} (${pct(cam.confidence)}${photoRef(cam.photoIndex)})`,
        final: crackedWord,
        message: `Customer: not ${crackedWord} · Camera: ${crackedWord} (${pct(cam.confidence)}${photoRef(cam.photoIndex)}). The worse answer is recorded.`,
        photoIndex: cam.photoIndex,
        box: cam.box,
      });
    }
    const component = s?.components.find((c) => c.id === comp);
    const sawAny = !!component?.findings.some((f) => f.type === "crack" || f.type === "chip");
    if (said === true && fin.final && component?.grade && !sawAny) {
      out.push({
        topic,
        customer: crackedWord,
        tested: null,
        camera: `no ${topic === "screen" ? "crack" : "crack on the back"} seen`,
        final: crackedWord,
        message: `Customer says ${crackedWord}; the camera did not see a crack. The customer's answer stands — check by eye.`,
        photoIndex: null,
        box: null,
      });
    }
  };
  glass("screen", "screenCracked", "screen_cracked", "front", "cracked");
  glass("back", "backCracked", "back_cracked", "back", "back cracked");

  const self = results.display?.outcome;
  const cam = s?.displayCheck?.verdict;
  if ((self === "pass" && cam === "fail") || (self === "fail" && cam === "pass")) {
    out.push({
      topic: "display",
      customer: null,
      tested: self === "pass" ? "self-test passed" : "self-test failed",
      camera: cam === "fail" ? `screen sweep failed (${pct(s?.displayCheck?.confidence ?? null)})` : "screen sweep passed",
      final: SCREEN_LABEL.lines_or_spots,
      message: `Phone's own display test ${self === "pass" ? "passed" : "failed"}; the camera's screen sweep ${cam === "fail" ? "failed" : "passed"}. Recorded as "${SCREEN_LABEL.lines_or_spots}" — check the screen by eye.`,
      photoIndex: null,
      box: null,
    });
  }

  if (m.identity.verdict === "mismatch") {
    out.push({
      topic: "identity",
      customer: null,
      tested: null,
      camera: m.identity.reasons[0] ?? "a different phone",
      final: "quote blocked",
      message: `The camera says this may not be the phone on the case. The trade-in can't be priced until it is resolved. ${m.identity.reasons.join(" ")}`.trim(),
      photoIndex: null,
      box: null,
    });
  }
  return out;
}

/* ─────────────────────────── what staff see ─────────────────────────── */

export type AssessmentView = {
  final: boolean;
  provisional: boolean;
  status: Finality["status"];
  reasons: string[];
  /** Shown, never priced. null = not camera-graded. */
  grade: string | null;
  conclusive: boolean | null;
  gradeRange: { best: string; worst: string } | null;
  needsHumanReview: boolean;
  coverage: number | null;
  score: number | null;
  tierUsed: string | null;
  visionModel: string | null;
  functionalGrade: string | null;
  components: { id: GiqComponentId; label: string; grade: string | null; confidence: number | null; findings: number }[];
  findings: MappedFinding[];
  faults: CameraFault[];
  suggested: CameraFault[];
  floor: CameraFloor;
  flags: string[];
  displayCheck: (Omit<GiqDisplayCheck, "captures"> & { captures: { pattern: string; photo: string }[] }) | null;
  lcd: LcdCheck;
  obstruction: GradeiqSnapshot["obstruction"];
  oem: GradeiqSnapshot["oem"];
  identity: { verdict: IdentityVerdict; reasons: string[]; device: GradeiqSnapshot["device"] };
  photos: string[];
  fetchedAt: string | null;
};

export function assessmentView(s: GradeiqSnapshot | null, fin: Finality, m: CameraMapping): AssessmentView {
  return {
    final: fin.final,
    provisional: fin.provisional,
    status: fin.status,
    reasons: fin.reasons,
    grade: s?.cosmeticGrade || null,
    conclusive: s?.conclusive ?? null,
    gradeRange: s?.gradeRange ?? null,
    needsHumanReview: s?.needsHumanReview ?? false,
    coverage: s?.coverage ?? null,
    score: s?.score ?? null,
    tierUsed: s?.tierUsed ?? null,
    visionModel: s?.visionModel ?? null,
    functionalGrade: s?.functionalGrade || null,
    components: (s?.components ?? []).map((c) => ({ id: c.id, label: COMPONENT_LABEL[c.id], grade: c.grade || null, confidence: c.confidence, findings: c.findings.length })),
    findings: m.findings,
    faults: m.faults,
    suggested: m.suggested,
    floor: m.floor,
    flags: m.flags,
    displayCheck: s?.displayCheck ?? null,
    lcd: m.lcd,
    obstruction: s?.obstruction ?? null,
    oem: s?.oem ?? null,
    identity: { ...m.identity, device: s?.device ?? null },
    photos: s?.photos ?? [],
    fetchedAt: s?.fetchedAt ?? null,
  };
}
