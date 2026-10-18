/**
 * THE GRADING REPORT — what was tested and why the phone got its grade, as one
 * JSON body: `swapup.grading-report/v1` (spec §4.2).
 *
 * The body is PUBLIC-SAFE: anyone with the report link reads it, and the
 * partner keeps the version frozen at hand-over as evidence at pickup and
 * clearance. So what it never carries is the point of this module:
 *   - no money of any kind (the grade never moves a price, and the report says so);
 *   - no customer name, phone number or ID;
 *   - no full IMEI (maskImei);
 *   - no GradeIQ letter, id or URL — GradeIQ's upload file names start with its
 *     session UUID, which is that session's write key;
 *   - no raw photo URL: a photo is a number `n`, and its URL goes only into
 *     `photoSources`, which the server keeps and proxies (/api/r/<token>/photo/<n>);
 *   - no DeviceFax JSON (it holds the GradeIQ session id) — only its passport id.
 *
 * Both scales are shown: the SwapUp grade and its letter (A = Superb, B = Good,
 * C = Fair, D = Best Value), with one plain line that says the letter is the
 * same grade and not a CTIA certification.
 *
 * As rich as the store camera's own report (owner, 2026-10-17): every exterior
 * photo with its angle and, from a FINAL grade, each mark boxed; the condition
 * part by part (in words — never the camera's letter or score); the screen
 * colour test with its frames; identity, OS and colour; battery cycles; parts;
 * the locks; why the camera didn't grade, in one fixed sentence; and what the
 * advisor certified by eye, by name. Every addition is optional, so a version
 * issued before it still renders. Never on it: the AI vendor, its errors,
 * GradeIQ's name, letters, score, tier or instructions to staff.
 *
 * `canonicalJson` sorts keys recursively so the sha256 the server takes of it is
 * the same for the same body, whatever order the keys were built in. The hash is
 * an integrity fingerprint, not a signature.
 *
 * Pure functions only — no database, no network, no clock (the hashing itself
 * is lib/server/gradingReport.ts).
 */
import {
  type ConditionAnswers,
  type FaultId,
  BODY_LABEL,
  FAULTS,
  FAULT_BY_ID,
  ISSUE_LABEL,
  PART_LABEL,
  SCREEN_LABEL,
} from "./condition.ts";
import { BATTERY_HEALTH_PASS_PCT } from "./diagnostics.ts";
import { reconcileFaultSources, type CaseCameraCheck, type FaultSource, type FaultSources, type GiqBox, type GiqComponentId, type GiqDisplayCheck, type MappedFinding } from "./gradeiqMap.ts";
import { CERT_ROWS, certSentence, type Certification, type CertRow } from "./certify.ts";
import { LETTER_NOTE, gradeWithLetter, type BatteryReading, type Grading, type GradeLetter, type Reason, type TestLine } from "./grading.ts";
import type { MarketGrade } from "./marketSell.ts";
import type { PcRecord } from "./phonecheck.ts";
import { maskImei, readImei } from "./imei.ts";

export const REPORT_SCHEMA = "swapup.grading-report/v1";
export const REPORT_SCALE = "Superb > Good > Fair > Best Value · tested at the store, not by the buyer";

/** Words for where a fault came from, as the report prints them. */
export const FAULT_SOURCE_LABEL: Readonly<Record<FaultSource, string>> = {
  tested: "SwapUp Check",
  phonecheck: "Phonecheck",
  declared: "Customer said",
  camera_ai: "Store camera",
  advisor: "Advisor",
};

/* ─────────────────────────── the body ─────────────────────────── */

export type ReportBody = {
  schema: typeof REPORT_SCHEMA;
  ruleset: string;
  case: { ref: string; store: string; storeCode: string | null };
  phone: {
    label: string | null;
    variant: string | null;
    variantSource: string | null;
    modelMatch: string | null;
    imei: string | null;
    imei2: string | null;
    imeiCheckDigit: "valid" | "invalid" | null;
    /** The government IMEI register check — null before lock. */
    kym: { status: string; label: string; at: string | null } | null;
    /** "Android 14" — what the phone reported. Optional (absent before 2026-10-17). */
    os?: string | null;
    /** The body colour: Phonecheck's, else as the store camera photographed it. Optional. */
    colour?: string | null;
    /** Is the photographed phone the one on the case — the store camera's identity check. Optional. */
    identity?: { verdict: "match" | "mismatch" | "unverified"; acceptedBy: string | null } | null;
  };
  grade: {
    status: Grading["status"];
    label: string;
    grade: MarketGrade | null;
    letter: GradeLetter | null;
    final: boolean;
    cosmetic: MarketGrade | null;
    ceiling: MarketGrade | null;
    afterRepair: MarketGrade | null;
    /** "Superb (A)" — both scales, ready to print. */
    ceilingLabel: string | null;
    afterRepairLabel: string | null;
    reasons: Reason[];
    provisional: Reason[];
    disclosures: Reason[];
    scale: string;
    letterScale: string;
  };
  tests: TestLine[];
  otherTests: Grading["otherTests"];
  battery: { healthPct: number | null; passLine: number; readings: BatteryReading[]; /** Phonecheck's charge-cycle count. Optional. */ cycles?: number | null };
  condition: { screen: string; body: string; issues: string[]; powersOn: boolean; calls: boolean } | null;
  camera: {
    checked: boolean;
    status: CaseCameraCheck["status"] | null;
    final: boolean;
    lcd: "passed" | "failed" | "not_checked" | "unsure";
    /**
     * Confirmed findings only (a FINAL grade). `photo` = index into the version's server-side photo list;
     * `box` = where on that photo, [ymin, xmin, ymax, xmax] in 0..1 (optional).
     */
    findings: { part: string; what: string; severity: string; photo: number | null; box?: GiqBox | null }[];
    /** DeviceFax passport id ("DFX-…"), or null. */
    reference: string | null;
    /** Every exterior photo the store camera took, in order, with the angle — whatever the grade's finality. Optional. */
    photos?: { n: number; label: string }[];
    /** Part by part, from a FINAL grade only: the camera's word in SwapUp's language — never its letter or score. Optional. */
    parts?: { part: string; word: string; note: string | null }[];
    /** Why the store camera didn't grade it, one fixed sentence (null when it did). Optional. */
    why?: string | null;
    /** Who applied the test at the counter. Optional. */
    checkedBy?: string | null;
  };
  /**
   * The screen colour test: each colour the store camera asked the phone to show, with its frame when
   * one was taken; the marks the reader found (with their boxes); and, when it couldn't check, why —
   * one fixed sentence. Optional (absent before 2026-10-17).
   */
  screen?: {
    colours: { pattern: string; photo: number | null }[];
    missing: string[];
    marks: { pattern: string | null; what: string; severity: string | null; photo: number | null; box: GiqBox | null }[];
    why: string | null;
  };
  /** What the advisor certified by eye, by name (lib/domain/certify.ts). Optional. */
  certification?: Partial<Record<CertRow, { value: string; label: string; by: string; at: string; withColours: boolean; line: string }>>;
  /** Phonecheck's lock checks (the government register is phone.kym). Optional. */
  locks?: { activation: "on" | "off" | null; rooted: "on" | "off" | null; mdm: "on" | "off" | null } | null;
  /** Original parts: Phonecheck's word and the store camera's (a FINAL grade's), with the camera's evidence. Optional. */
  parts?: { phonecheck: "genuine" | "not_genuine" | "unknown" | null; camera: "no_sign" | "suspect" | "unsure" | null; evidence: string[] } | null;
  /** certifiedBy: the advisor whose certification put it on the case (optional). */
  faults: { id: FaultId; label: string; sources: string[]; certifiedBy?: string | null }[];
  repairs: { parts: string[]; inspection: string[] };
  phonecheck: {
    testedAt: string | null;
    station: string | null;
    reportNo: string | null;
    working: PcRecord["working"];
    /** As the tester chose it in Phonecheck's dropdown — never used for the grade. */
    testerGrade: string | null;
    erased: boolean | null;
    parts: PcRecord["parts"];
    deviceLock: PcRecord["deviceLock"];
    uploaded: boolean;
    aiRead: boolean;
  } | null;
  checkedAt: { swapupCheck: string | null; camera: string | null; phonecheck: string | null };
  sessions: { app: "native" | "browser" | null; appVersion: string | null; earlierSessions: number };
};

export type ReportInput = {
  grading: Grading;
  case: { ref: string; store: string; storeCode: string | null };
  phone: {
    label: string | null;
    variant: string | null;
    variantSource: string | null;
    modelMatch: string | null;
    /** Full IMEIs — masked here, never copied. */
    imei: string | null;
    imei2: string | null;
    /** After lock only; the caller passes KYM_LABEL[status] (lib/server/cases.ts). */
    kym: { status: string; label: string; at: string | null } | null;
    os?: string | null;
    colour?: string | null;
  };
  condition: ConditionAnswers | null;
  camera: {
    check: (Pick<CaseCameraCheck, "state" | "status" | "final" | "lcd"> & Partial<Pick<CaseCameraCheck, "by" | "identity" | "identityOverride" | "lcdOverride">>) | null;
    /** mapCamera(...).findings for the case's session. Only confirmed fault / condition / suggested ones are kept. */
    findings: (Pick<MappedFinding, "componentLabel" | "type" | "label" | "meaning" | "severity" | "effect" | "confirmed" | "photoUrl"> & Partial<Pick<MappedFinding, "box" | "component">>)[];
    /** test_sessions.gradeiq_devicefax → passportId. Anything not shaped "DFX-…" is dropped. */
    passportId: string | null;
    /** Every exterior photo of the applied session, in order, with GradeIQ's angle label when it stored one. */
    photos?: { url: string; label: string | null }[];
    /** A FINAL grade's parts: assessed (it graded the part) and the specialist's one-line note. */
    parts?: { id: GiqComponentId; label: string; assessed: boolean; note: string }[] | null;
    /** What stopped the grade: the reader off, a case on the phone, photos rejected, too little visible. */
    signals?: { stub: boolean; obstruction: boolean; retake: boolean; lowCoverage: boolean } | null;
    /** The screen sweep as stored with the applied session's snapshot. */
    display?: GiqDisplayCheck | null;
    /** The body colour as photographed, and the OEM check — a FINAL grade's only. */
    colour?: string | null;
    oem?: { verdict: string; evidence: string[] } | null;
  };
  certification?: Certification | null;
  faults: FaultId[];
  faultSources: FaultSources;
  /** The attached Phonecheck record and how it reached SwapUp. */
  phonecheck: { record: PcRecord; source: "pull" | "webhook" | "upload" } | null;
  checkedAt: { swapupCheck: string | null; camera: string | null; phonecheck: string | null };
  sessions: { app: "native" | "browser" | null; appVersion: string | null; earlierSessions: number };
};

const PASSPORT = /^DFX-[A-Za-z0-9-]{1,60}$/;

/** GradeIQ's capture order (DEFAULT_CAPTURE_STEPS) — the angle when a snapshot stored no labels. */
export const DEFAULT_ANGLES = ["Front glass", "Back", "Left side", "Right side", "Top edge", "Bottom / ports"] as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Reasons carry free text staff typed (an override's reason). Whatever was
 * pasted into it, the public body gets no full IMEI (14+ digits → maskImei), no
 * phone number (10–13 digits → last two only) and no UUID.
 */
export function scrubText(s: string): string {
  return s
    .replace(UUID, "[id]")
    .replace(/\d{10,}/g, (d) => (d.length >= 14 ? maskImei(d) : `${"•".repeat(d.length - 2)}${d.slice(-2)}`));
}
const scrubReasons = (rs: Reason[]): Reason[] => rs.map((r) => ({ code: r.code, text: scrubText(r.text) }));

/** The AI's own sentence about a part, with any grade letter it named taken out (the camera's letters are staff-only). */
export function plainNote(s: string | null | undefined): string | null {
  const t = scrubText(String(s ?? ""))
    .replace(/\b[Gg]rade[sd]?\s*[:=]?\s*(?:[Pp]remium|[A-D][+-]?)(?![A-Za-z])/g, "")
    .replace(/\b(?:[Pp]remium|[A-D][+-]?)[\s-]*[Gg]rade\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .trim();
  return t ? t.slice(0, 200) : null;
}

/**
 * Why the store camera didn't grade the photos — one fixed sentence, never
 * GradeIQ's own text (which holds instructions to staff). null when it graded them.
 */
export function cameraWhy(status: CaseCameraCheck["status"] | null, final: boolean, signals: ReportInput["camera"]["signals"], photos: number): string | null {
  if (final) return null;
  if (signals?.obstruction) return "A case or cover was on the phone.";
  if (signals?.stub) return "The automatic grader is off.";
  if (signals?.retake) return "The photos weren't clear enough to grade.";
  if (signals?.lowCoverage) return "Too little of the phone was in the photos.";
  if (status === "failed") return "The store camera couldn't grade the photos.";
  if (status === "grading" || status === "provisional") return "The store camera's grade wasn't final.";
  return photos ? "The store camera's photos weren't graded." : "The store camera didn't photograph this phone.";
}

/**
 * Why the store camera didn't check the screen's colours — one fixed sentence,
 * never GradeIQ's text. null when the sweep checked it.
 */
export function lcdWhy(lcd: CaseCameraCheck["lcd"] | null | undefined, override: CaseCameraCheck["lcdOverride"] | null | undefined, swept: boolean): string | null {
  if (lcd?.cameraChecked) return null;
  if (lcd?.aiOff) return "Colours photographed; the automatic reader is off.";
  const r = (lcd?.reason ?? "").toLowerCase();
  if (r.includes("never got a clear view")) return "The store camera couldn't see the lit screen.";
  if (r.includes("never confirmed")) return "The customer's phone didn't show the colours.";
  if (!swept && override) return `The camera was started before the customer's phone was ready (${override.by}).`;
  if (r.startsWith("not captured")) return "Not every colour was photographed.";
  if (!swept) return "The store camera's colour check didn't run.";
  return "The store camera couldn't judge the screen.";
}

const OEM_WORD: Readonly<Record<string, "no_sign" | "suspect" | "unsure">> = { likely_oem: "no_sign", suspect_aftermarket: "suspect", inconclusive: "unsure" };

/** A part in SwapUp's words, from the findings about it (and their effect) — never the camera's letter. */
function partWord(p: { label: string; assessed: boolean }, findings: ReportInput["camera"]["findings"]): string {
  if (!p.assessed) return "Not seen by the camera";
  const mine = findings.filter((f) => f.componentLabel === p.label && f.confirmed);
  const damage = mine.filter((f) => f.effect === "fault" || f.effect === "suggested");
  if (damage.length) return `Damage: ${[...new Set(damage.map((f) => (f.meaning ?? f.label ?? f.type).toLowerCase()))].join(", ")}`;
  const wear = mine.filter((f) => f.effect === "condition");
  if (wear.length) return "Wear";
  const marks = mine.length;
  if (marks) return `${marks} light mark${marks === 1 ? "" : "s"}`;
  return "No marks";
}
const FAULT_ORDER = FAULTS.map((f) => f.id);

function lcdWord(lcd: CaseCameraCheck["lcd"] | null | undefined): ReportBody["camera"]["lcd"] {
  if (!lcd || !lcd.cameraChecked) return "not_checked";
  if (lcd.verdict === "pass") return "passed";
  if (lcd.verdict === "fail" && lcd.confirmed === true) return "failed";
  return "unsure";
}

/**
 * Everything the report says, and the photo URLs it may proxy (server-side
 * only, by index). Deterministic: the same input gives the same body.
 */
export function buildReportBody(input: ReportInput): { body: ReportBody; photoSources: string[] } {
  const g = input.grading;
  const photoSources: string[] = [];
  const photoIndex = (url: string | null): number | null => {
    if (!url) return null;
    const at = photoSources.indexOf(url);
    if (at >= 0) return at;
    photoSources.push(url);
    return photoSources.length - 1;
  };

  const imeiRead = input.phone.imei ? readImei(input.phone.imei) : null;
  // Every exterior photo first, in the camera's order — except the front glass. The phone's
  // screen faces the camera for it and may still show its scan code, whose GradeIQ session id
  // opens that session: the public report never carries that photo (nor a finding's copy of it).
  const labelled = (input.camera.photos ?? []).map((p, i) => ({ url: p.url, label: (p.label ?? "").trim() || DEFAULT_ANGLES[i] || `Photo ${i + 1}` }));
  const frontUrls = new Set(labelled.filter((p) => /^front\b/i.test(p.label)).map((p) => p.url));
  const photos = labelled.filter((p) => !frontUrls.has(p.url)).map((p) => ({ n: photoIndex(p.url)!, label: p.label }));
  const findings = input.camera.findings
    .filter((f) => f.confirmed && (f.effect === "fault" || f.effect === "condition" || f.effect === "suggested"))
    .map((f) => ({ part: f.componentLabel, what: f.meaning ?? (f.label || f.type), severity: f.severity, photo: f.photoUrl && frontUrls.has(f.photoUrl) ? null : photoIndex(f.photoUrl), box: f.box ?? null }));

  const faults = [...new Set(input.faults)].filter((f) => f in FAULT_BY_ID).sort((a, b) => FAULT_ORDER.indexOf(a) - FAULT_ORDER.indexOf(b));
  const sources = reconcileFaultSources(input.faultSources, faults);
  const cam = input.camera.check;
  const pc = input.phonecheck;
  const cert = input.certification ?? null;
  const certifiedBy = (f: FaultId): string | null => {
    for (const row of CERT_ROWS) if (cert?.[row]?.added.includes(f)) return cert[row]!.by;
    return null;
  };

  // The screen colour test, from the sweep stored with the applied session.
  const dc = input.camera.display ?? null;
  const frameOf = new Map<string, number | null>();
  for (const c of dc?.captures ?? []) if (!frameOf.has(c.pattern)) frameOf.set(c.pattern, photoIndex(c.photo));
  const asked = dc ? (dc.requested.length ? dc.requested : dc.captures.map((c) => c.pattern)) : [];
  // Only where the store camera could have checked it — a SwapUp Check session — or the advisor did.
  const screen: ReportBody["screen"] = !cam && !dc && !cert?.screen ? undefined : {
    colours: [...new Set(asked)].map((pattern) => ({ pattern, photo: frameOf.get(pattern) ?? null })),
    missing: dc ? [...dc.missing] : [],
    // What the reader marked — only when it really read the frames.
    marks:
      dc && dc.source !== "stub"
        ? dc.findings.map((f) => ({ pattern: f.pattern, what: plainNote(f.label || f.type) ?? "a mark", severity: f.severity, photo: f.pattern ? (frameOf.get(f.pattern) ?? null) : null, box: f.box ?? null }))
        : [],
    why: lcdWhy(cam?.lcd, cam?.lcdOverride ?? null, !!dc),
  };

  const certification: ReportBody["certification"] = {};
  for (const row of CERT_ROWS) {
    const c = cert?.[row];
    if (c) certification[row] = { value: c.value, label: c.label, by: c.by, at: c.at, withColours: c.withColours, line: certSentence(row, c) };
  }

  const cameraFinal = !!cam && cam.state === "ready" && cam.final;
  const parts = cameraFinal && input.camera.parts?.length ? input.camera.parts.map((p) => ({ part: p.label, word: partWord(p, input.camera.findings), note: plainNote(p.note) })) : undefined;
  const oem = cameraFinal ? (input.camera.oem ?? null) : null;

  const body: ReportBody = {
    schema: REPORT_SCHEMA,
    ruleset: g.ruleset,
    case: { ref: input.case.ref, store: input.case.store, storeCode: input.case.storeCode },
    phone: {
      label: input.phone.label,
      variant: input.phone.variant,
      variantSource: input.phone.variantSource,
      modelMatch: input.phone.modelMatch,
      imei: input.phone.imei ? maskImei(input.phone.imei) : null,
      imei2: input.phone.imei2 ? maskImei(input.phone.imei2) : null,
      imeiCheckDigit: imeiRead && imeiRead.ok ? imeiRead.checkDigit : null,
      kym: input.phone.kym ? { status: input.phone.kym.status, label: input.phone.kym.label, at: input.phone.kym.at } : null,
      os: input.phone.os ?? null,
      colour: pc?.record.colour ?? (cameraFinal ? (input.camera.colour ?? null) : null),
      identity: cam?.identity ? { verdict: cam.identity.verdict, acceptedBy: cam.identityOverride?.by ?? null } : null,
    },
    grade: {
      status: g.status,
      label: g.label,
      grade: g.grade,
      letter: g.letter,
      final: g.final,
      cosmetic: g.cosmetic,
      ceiling: g.ceiling,
      afterRepair: g.afterRepair,
      ceilingLabel: gradeWithLetter(g.ceiling),
      // As sure as the grade it rests on: the grade's own provisional reasons carry over.
      afterRepairLabel: g.afterRepair ? `${gradeWithLetter(g.afterRepair)}${g.provisional.length ? " · provisional" : ""}` : null,
      reasons: scrubReasons(g.reasons),
      provisional: scrubReasons(g.provisional),
      disclosures: scrubReasons(g.disclosures),
      scale: REPORT_SCALE,
      letterScale: LETTER_NOTE,
    },
    tests: g.tests,
    otherTests: g.otherTests,
    battery: { healthPct: g.battery.pct, passLine: BATTERY_HEALTH_PASS_PCT, readings: g.battery.readings, cycles: pc?.record.batteryCycles ?? null },
    condition: input.condition
      ? {
          screen: SCREEN_LABEL[input.condition.screen],
          body: BODY_LABEL[input.condition.body],
          issues: [...input.condition.issues].sort().map((i) => ISSUE_LABEL[i]),
          powersOn: input.condition.powersOn,
          calls: input.condition.calls,
        }
      : null,
    camera: {
      checked: !!cam && cam.status !== "none",
      status: cam ? cam.status : null,
      final: !!cam && cam.state === "ready" && cam.final,
      lcd: lcdWord(cam?.lcd),
      findings,
      reference: input.camera.passportId && PASSPORT.test(input.camera.passportId) ? input.camera.passportId : null,
      photos,
      ...(parts ? { parts } : {}),
      why: cameraWhy(cam?.status ?? null, cameraFinal, input.camera.signals ?? null, photos.length),
      checkedBy: cam?.by ?? null,
    },
    screen,
    certification,
    locks: pc ? { activation: pc.record.deviceLock, rooted: pc.record.rooted, mdm: pc.record.mdm } : null,
    parts:
      pc?.record.parts || oem
        ? { phonecheck: pc?.record.parts ?? null, camera: oem ? (OEM_WORD[oem.verdict] ?? null) : null, evidence: oem ? oem.evidence.map((e) => plainNote(e)).filter((e): e is string => !!e).slice(0, 4) : [] }
        : null,
    faults: faults.map((id) => ({ id, label: FAULT_BY_ID[id].label, sources: (sources[id] ?? ["advisor"]).map((s) => FAULT_SOURCE_LABEL[s]), certifiedBy: certifiedBy(id) })),
    repairs: { parts: g.repairs.parts.map((p) => PART_LABEL[p]), inspection: g.repairs.inspection.map((f) => FAULT_BY_ID[f].label) },
    phonecheck: pc
      ? {
          testedAt: pc.record.testedAt,
          station: pc.record.station,
          reportNo: pc.record.reportId,
          working: pc.record.working,
          testerGrade: pc.record.testerGrade,
          erased: pc.record.erased,
          parts: pc.record.parts,
          deviceLock: pc.record.deviceLock,
          uploaded: pc.source === "upload",
          aiRead: pc.record.aiRead,
        }
      : null,
    checkedAt: { swapupCheck: input.checkedAt.swapupCheck, camera: input.checkedAt.camera, phonecheck: input.checkedAt.phonecheck },
    sessions: { app: input.sessions.app, appVersion: input.sessions.appVersion, earlierSessions: input.sessions.earlierSessions },
  };
  return { body, photoSources };
}

/* ─────────────────────────── canonical JSON (for the hash) ─────────────────────────── */

/**
 * JSON with every object's keys sorted, recursively — so the same body always
 * hashes the same. Follows JSON.stringify otherwise: undefined object values are
 * dropped, undefined in an array is null, a non-finite number is null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined && typeof o[k] !== "function")
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return "null";
}
