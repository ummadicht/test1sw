import { createHash, randomBytes } from "node:crypto";
import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { getStore } from "./scope";
import { getCase, KYM_LABEL, type Checks, type KymStatus } from "./cases";
import { cameraEvidence, type GiqRow } from "./gradeiqBridge";
import { gradeiqConfig } from "./gradeiq";
import { pullState } from "./phonecheck";
import { grade, gradeWithLetter, gradeLetter, type Grading, type GradingInput, type TestEvidence, type GradeLetter } from "../domain/grading";
import { buildReportBody, canonicalJson, REPORT_SCHEMA, type ReportBody, type ReportInput } from "../domain/gradingReport";
import { evidenceFromPhonecheck, pcDeviceReport, pcFacts, type PcRecord } from "../domain/phonecheck";
import { DEFAULT_PLAN, isBrowserReport, matchModel, type Declared, type DeviceReport, type PlanItem, type TestResults, type TradeModelRef } from "../domain/diagnostics";
import { disagreements, resultsWithCameraDisplay, COMPONENT_LABEL, type CaseCameraCheck, type Disagreement, type FaultSources, type RecordedOverride } from "../domain/gradeiqMap";
import { gradeAfterRefurb, type MarketGrade } from "../domain/marketSell";
import { readCertification } from "../domain/certify";
import type { ConditionAnswers, FaultId } from "../domain/condition";
import type { CaseStatus } from "../domain/lifecycle";

/**
 * THE GRADING REPORT, SERVED (docs/GRADING.md, spec §4).
 *
 * LIVE grading is worked out on every read from what the case holds now: its
 * condition, faults and camera record; the SwapUp Check session the camera
 * record names (`camera_check.testSessionId`, once Apply wrote it); the newest
 * Phonecheck record attached to it; the GradeIQ snapshot of that session for
 * the per-part grades and the OEM verdict. The pure engine is lib/domain/grading.ts.
 *
 * ISSUED versions are the report as it stood at a moment — a row in
 * `grading_reports` with the public-safe body (lib/domain/gradingReport.ts),
 * stored as canonical JSON, and the sha256 of exactly that text:
 *   issueIfChanged(case, reason)  hashes the live body; a new version only when
 *                                 the hash moved. Called at the end of every
 *                                 case edit (updateCase — so Apply and a
 *                                 Phonecheck attach too), markLcdOverride, and
 *                                 inside lockTradeIn's transaction (the FINAL,
 *                                 frozen version — the partner's evidence at
 *                                 pickup and clearance). After lock nothing
 *                                 re-issues. A case that was tested before this
 *                                 existed gets v1 ("backfill") on first read.
 *   No evidence at all (never tested, nothing from Phonecheck) → nothing is issued.
 *
 * Who sees what (spec §4.4): staff get the live grade, every version and the
 * staff extras (GradeIQ's letter and links, the full IMEI, Phonecheck's
 * links…). The partner gets the frozen lock version only — never the live
 * grade, never an earlier version. Anyone with the link gets the latest
 * version (or ?v=n), and never a list of versions.
 *
 * ⚑ The body carries no money, no customer and no full IMEI; photos go out
 *   only through /api/r/<token>/photo/<n>, by index, proxied — GradeIQ's photo
 *   file names start with its session UUID, which is that session's write key.
 * ⚑ The hash is an integrity fingerprint, not a signature: anyone can
 *   recompute it from /api/r/<token>?v=n; it is authentic because SwapUp serves it.
 * ⚑ No HTTP inside `tx()`: issuing reads only the database (the stored GradeIQ snapshot).
 */

export type ReportReason = "edited" | "swapup_check" | "phonecheck" | "certified" | "traded_in" | "backfill" | "wording";

type CaseRowLite = {
  id: string;
  ref: string;
  org_id: string;
  store_id: string;
  status: CaseStatus;
  model_id: string | null;
  variant: string | null;
  variant_source: string | null;
  imei: string | null;
  imei2: string | null;
  faults: string;
  condition: string | null;
  camera_check: string | null;
  fault_sources: string;
  checks: string | null;
  report_token: string | null;
  certification: string | null;
};

type SessionRow = GiqRow & {
  plan: string;
  joined_at: string | null;
  completed_at: string | null;
  applied_at: string | null;
  created_at: string;
};

type VersionRow = {
  id: string;
  case_id: string;
  version: number;
  reason: ReportReason;
  ruleset: string;
  status: string;
  label: string;
  final: number;
  body: string;
  sha256: string;
  photo_sources: string;
  issued_at: string;
  issued_by: string | null;
};

type PcRowLite = { id: string; source: "pull" | "webhook" | "upload"; record: string; received_at: string; attach_override: string | null };

const EDITABLE: CaseStatus[] = ["draft", "quoted"];
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function caseRow(id: string): CaseRowLite | null {
  return (db().prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as CaseRowLite | undefined) ?? null;
}

function tradeModels(): (TradeModelRef & { label: string })[] {
  return (db().prepare(`SELECT id, brand, model, variants, model_codes FROM trade_models`).all() as { id: string; brand: string; model: string; variants: string; model_codes: string }[]).map((r) => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    label: `${r.brand} ${r.model}`,
    variants: parseJson<string[]>(r.variants, []),
    modelCodes: parseJson<string[]>(r.model_codes, []),
  }));
}

/* ─────────────────────────── gathering the evidence ─────────────────────────── */

type Live = {
  grading: Grading;
  report: Omit<ReportInput, "grading">;
  /** Anything tested at all (a SwapUp Check session on the case, or an attached Phonecheck record). */
  evidence: boolean;
  /** For staff only. */
  session: SessionRow | null;
  camera: CaseCameraCheck | null;
  pc: { row: PcRowLite; record: PcRecord } | null;
  condition: ConditionAnswers | null;
  sessionExtras: { components: { id: string; label: string; grade: string }[]; score: number | null; disagreements: Disagreement[] } | null;
};

/**
 * The SwapUp Check session whose results are on the case: the one the camera
 * record names, once Apply wrote that record (`by` is set) or the session is
 * applied. A session still running — or one staff only unlocked the camera for
 * (markLcdOverride writes a blank record with no `by`) — is not evidence yet.
 */
function appliedSession(caseId: string, camera: CaseCameraCheck | null): SessionRow | null {
  if (!camera?.testSessionId) return null;
  const s = db().prepare(`SELECT * FROM test_sessions WHERE id = ? AND case_id = ?`).get(camera.testSessionId, caseId) as SessionRow | undefined;
  if (!s) return null;
  return s.status === "applied" || camera.by !== null ? s : null;
}

/** The Phonecheck record a case's grade reads: the newest one attached to it. */
function attachedPhonecheck(caseId: string): { row: PcRowLite; record: PcRecord } | null {
  const row = db()
    .prepare(`SELECT id, source, record, received_at, attach_override FROM phonecheck_records WHERE case_id = ? AND attached_at IS NOT NULL ORDER BY attached_at DESC, received_at DESC LIMIT 1`)
    .get(caseId) as PcRowLite | undefined;
  if (!row) return null;
  try {
    return { row, record: JSON.parse(row.record) as PcRecord };
  } catch {
    return null;
  }
}

/** "Android 14" / "iOS 17.5" — what the phone said about itself; null when it didn't. */
function osOf(d: DeviceReport | null): string | null {
  if (!d?.osVersion) return null;
  const apple = /apple|iphone|ipad|ios/i.test(`${d.manufacturer ?? d.brand ?? ""} ${d.modelName ?? ""}`);
  return `${apple ? "iOS" : "Android"} ${d.osVersion}`.slice(0, 40);
}

function passportIdOf(s: SessionRow | null): string | null {
  const fax = parseJson<{ devicefax?: { passportId?: unknown } } | null>(s?.gradeiq_devicefax, null);
  const id = fax?.devicefax?.passportId;
  return typeof id === "string" ? id : null;
}

function live(c: CaseRowLite): Live {
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  const models = tradeModels();
  const tm = c.model_id ? (models.find((m) => m.id === c.model_id) ?? null) : null;
  const store = getStore(c.store_id);

  const evidence: TestEvidence[] = [];
  const s = appliedSession(c.id, camera);
  let plan: readonly PlanItem[] = DEFAULT_PLAN;
  let device: DeviceReport | null = null;
  let findings: ReportInput["camera"]["findings"] = [];
  let cameraComponents: GradingInput["cameraComponents"] = null;
  let cameraOem: string | null = null;
  let sessionExtras: Live["sessionExtras"] = null;
  let camExtra: Pick<ReportInput["camera"], "photos" | "parts" | "signals" | "display" | "colour" | "oem"> = {};
  if (s) {
    plan = parseJson<PlanItem[]>(s.plan, [...DEFAULT_PLAN]);
    device = parseJson<DeviceReport | null>(s.device, null);
    const ce = cameraEvidence(s);
    // The case's own camera record (frozen at Apply, and marked when staff unlocked
    // the camera) folds the LCD sweep in — the same fold the session view makes — at a
    // stable time, so re-reading never moves the report's hash.
    const raw = parseJson<TestResults>(s.results, {});
    const results = resultsWithCameraDisplay(raw, camera?.lcd ?? ce.mapping.lcd, camera?.at ?? s.joined_at ?? s.created_at);
    evidence.push({ source: "swapup_check", results, at: s.completed_at ?? s.joined_at ?? null });
    // Per-part grades and findings only from a FINAL camera grade.
    const finalSnap = camera?.final && ce.snap ? ce.snap : null;
    if (finalSnap) {
      cameraComponents = finalSnap.components.map((x) => ({ id: x.id, grade: x.grade || null }));
      findings = ce.mapping.findings;
    }
    cameraOem = ce.snap?.oem?.verdict ?? null;
    // The rest of what the store camera's own report shows: every photo with its angle (any finality),
    // the screen sweep and its frames, and — from a FINAL grade only — each part in words, the colour, the parts evidence.
    const snap = ce.snap;
    camExtra = {
      photos: (snap?.photos ?? []).map((url, i) => ({ url, label: snap?.angleLabels?.[i] ?? null })),
      parts: finalSnap ? finalSnap.components.map((x) => ({ id: x.id, label: COMPONENT_LABEL[x.id], assessed: !!x.grade, note: x.note ?? "" })) : null,
      signals: snap
        ? {
            stub: snap.tierUsed === "stub",
            obstruction: !!snap.obstruction?.present,
            retake: snap.capture?.verdict === "retake",
            lowCoverage: !snap.cosmeticGrade && snap.coverage !== null && snap.coverage < 0.5,
          }
        : null,
      display: snap?.displayCheck ?? null,
      colour: finalSnap?.device?.colour ?? null,
      oem: finalSnap?.oem ? { verdict: finalSnap.oem.verdict, evidence: finalSnap.oem.evidence } : null,
    };
    sessionExtras = {
      components: (ce.snap?.components ?? []).map((x) => ({ id: x.id, label: COMPONENT_LABEL[x.id], grade: x.grade })),
      score: ce.snap?.score ?? null,
      disagreements: disagreements(parseJson<Declared | null>(s.declared, null), raw, ce.snap, ce.mapping, ce.fin),
    };
  }
  const pc = attachedPhonecheck(c.id);
  let pcModelMismatch: GradingInput["pcModelMismatch"] = null;
  if (pc) {
    evidence.push(evidenceFromPhonecheck(pc.record, pc.row.source === "upload" ? "phonecheck_upload" : "phonecheck", pc.row.received_at));
    // Phonecheck reads the phone as another model on file: a disclosure, the case is kept.
    const m = matchModel(pcDeviceReport(pc.record), models);
    if (m.modelId && c.model_id && m.modelId !== c.model_id) pcModelMismatch = { phonecheck: m.label ?? m.modelId, case: tm?.label ?? null };
  }

  const certification = readCertification(parseJson<unknown>(c.certification, null));
  const input: GradingInput = {
    plan,
    evidence,
    condition,
    faults,
    camera,
    certification,
    cameraComponents,
    cameraOem,
    physicalDevice: device ? device.isPhysicalDevice : null,
    browserRun: isBrowserReport(device),
    phonecheckImeiOverride: pc ? parseJson<RecordedOverride | null>(pc.row.attach_override, null) : null,
    pcFacts: pc ? pcFacts(pc.record) : null,
    pcModelMismatch,
  };
  const grading = grade(input);

  const checks = parseJson<Checks | null>(c.checks, null);
  const kymStatus = checks?.kym?.status as KymStatus | undefined;
  const locked = !EDITABLE.includes(c.status) && !!checks;
  const modelMatch = device ? matchModel(device, models).match : pc ? matchModel(pcDeviceReport(pc.record), models).match : null;
  const earlier = s
    ? (db().prepare(`SELECT COUNT(*) n FROM test_sessions WHERE case_id = ? AND status = 'applied' AND id != ?`).get(c.id, s.id) as { n: number }).n
    : (db().prepare(`SELECT COUNT(*) n FROM test_sessions WHERE case_id = ? AND status = 'applied'`).get(c.id) as { n: number }).n;
  const report: Omit<ReportInput, "grading"> = {
    case: { ref: c.ref, store: store?.name ?? "", storeCode: store?.code ?? null },
    phone: {
      label: tm?.label ?? null,
      variant: c.variant,
      variantSource: c.variant ? c.variant_source : null,
      modelMatch,
      imei: c.imei,
      imei2: c.imei2,
      kym: locked && kymStatus && kymStatus in KYM_LABEL ? { status: kymStatus, label: KYM_LABEL[kymStatus], at: checks!.at ?? null } : null,
      os: osOf(device),
    },
    condition,
    camera: { check: camera, findings, passportId: passportIdOf(s), ...camExtra },
    certification,
    faults,
    faultSources: parseJson<FaultSources>(c.fault_sources, {}),
    phonecheck: pc ? { record: pc.record, source: pc.row.source } : null,
    checkedAt: {
      swapupCheck: s ? (s.completed_at ?? s.joined_at ?? null) : null,
      camera: camera && camera.status !== "none" ? camera.at : null,
      phonecheck: pc?.record.testedAt ?? null,
    },
    sessions: { app: device ? (isBrowserReport(device) ? "browser" : "native") : null, appVersion: device?.appVersion ?? null, earlierSessions: earlier },
  };
  return { grading, report, evidence: evidence.length > 0, session: s, camera, pc, condition, sessionExtras };
}

function bodyOf(l: Live): { body: ReportBody; photoSources: string[]; text: string; sha: string } {
  const { body, photoSources } = buildReportBody({ grading: l.grading, ...l.report });
  const text = canonicalJson(body);
  return { body, photoSources, text, sha: sha256(text) };
}

/* ─────────────────────────── versions ─────────────────────────── */

export type ReportVersion = { version: number; sha256: string; issuedAt: string; reason: ReportReason; final: boolean };
export type ReportEnvelope = ReportVersion & { schema: typeof REPORT_SCHEMA; body: ReportBody };

const versionOf = (r: VersionRow): ReportVersion => ({ version: r.version, sha256: r.sha256, issuedAt: r.issued_at, reason: r.reason, final: !!r.final });
const envelopeOf = (r: VersionRow): ReportEnvelope => ({ schema: REPORT_SCHEMA, ...versionOf(r), body: JSON.parse(r.body) as ReportBody });

function latestRow(caseId: string): VersionRow | null {
  return (db().prepare(`SELECT * FROM grading_reports WHERE case_id = ? ORDER BY version DESC LIMIT 1`).get(caseId) as VersionRow | undefined) ?? null;
}

/** The version frozen at lock, if the case has one. */
function finalRow(caseId: string): VersionRow | null {
  return (db().prepare(`SELECT * FROM grading_reports WHERE case_id = ? AND final = 1 ORDER BY version DESC LIMIT 1`).get(caseId) as VersionRow | undefined) ?? null;
}

/** The version the buyback partner sees: the one frozen at lock, else (a case locked before reports existed) the latest backfill. */
function partnerRow(caseId: string): VersionRow | null {
  return (
    (db()
      .prepare(`SELECT * FROM grading_reports WHERE case_id = ? AND (final = 1 OR reason = 'backfill') ORDER BY final DESC, version DESC LIMIT 1`)
      .get(caseId) as VersionRow | undefined) ?? null
  );
}

/**
 * Issue a new version of the case's report if the body changed (spec §4.1).
 * `final` = the lock version (lockTradeIn's transaction): issued even when the
 * body is unchanged — versions are never edited. Returns the latest version, or
 * null when there is nothing to report (no evidence) or nothing may be issued
 * (past the counter, except the lock version and a first backfill).
 */
export function issueIfChanged(caseId: string, reason: ReportReason, userId: string | null, opts: { final?: boolean } = {}): ReportVersion | null {
  return tx(() => {
    const c = caseRow(caseId);
    if (!c) return null;
    const latest = latestRow(caseId);
    const editable = EDITABLE.includes(c.status);
    if (opts.final) {
      if (latest?.final) return versionOf(latest);
    } else if (!editable && !(reason === "backfill" && !latest)) {
      return latest ? versionOf(latest) : null;
    }
    const l = live(c);
    if (!l.evidence && !latest) return null;
    const b = bodyOf(l);
    if (latest && latest.sha256 === b.sha && !opts.final) return versionOf(latest);
    let token = c.report_token;
    if (!token) {
      token = randomBytes(16).toString("base64url");
      db().prepare(`UPDATE cases SET report_token = ? WHERE id = ? AND report_token IS NULL`).run(token, caseId);
    }
    const version = (latest?.version ?? 0) + 1;
    const at = nowIso();
    db()
      .prepare(
        `INSERT INTO grading_reports (id, case_id, version, reason, ruleset, status, label, final, body, sha256, photo_sources, issued_at, issued_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(newId("gr"), caseId, version, reason, l.grading.ruleset, l.grading.status, l.grading.label, opts.final ? 1 : 0, b.text, b.sha, JSON.stringify(b.photoSources), at, userId);
    audit({ userId, orgId: c.org_id, storeId: c.store_id, action: "grading.report", entity: "case", entityId: caseId, detail: { version, reason, label: l.grading.label, final: !!opts.final, sha256: b.sha } });
    return { version, sha256: b.sha, issuedAt: at, reason, final: !!opts.final };
  });
}

/** v1 for a case tested before reports existed — only when there is evidence (issueIfChanged checks). */
function ensureBackfill(caseId: string): void {
  if (!db().prepare(`SELECT 1 FROM grading_reports WHERE case_id = ? LIMIT 1`).get(caseId)) issueIfChanged(caseId, "backfill", null);
}

/** Never let the report break the counter: a failure to issue is logged, and the edit stands. */
export function issueQuietly(caseId: string, reason: ReportReason, userId: string | null, opts: { final?: boolean } = {}): void {
  try {
    issueIfChanged(caseId, reason, userId, opts);
  } catch (e) {
    console.error(`[swapup] grading report not issued for ${caseId} (${reason}):`, e);
  }
}

/* ─────────────────────────── on the case (CaseView.grading) ─────────────────────────── */

export type CaseGrading = {
  status: Grading["status"];
  /** Both scales, ready to show: "Good (B)", "Good (B) · provisional", "Needs repair". */
  label: string;
  grade: MarketGrade | null;
  letter: GradeLetter | null;
  final: boolean;
  /** The one-line why (reasons[0]). */
  why: string | null;
  report: { path: string; version: number; sha256: string; issuedAt: string; final: boolean } | null;
  /** Staff only (null for the partner): can "Phonecheck results" be pressed, and why not. */
  phonecheck: { canPull: boolean; why: string | null } | null;
};

const reportRef = (token: string | null, r: VersionRow | null, pinned: boolean): CaseGrading["report"] =>
  token && r ? { path: `/r/${token}${pinned ? `?v=${r.version}` : ""}`, version: r.version, sha256: r.sha256, issuedAt: r.issued_at, final: !!r.final } : null;

/**
 * The grade line on a case. Staff: the LIVE grade, the latest version and
 * whether a Phonecheck pull is possible — until the trade-in is locked; from
 * then on the grade IS the version frozen at lock (what the receipt, the pickup
 * and the partner show), linked to exactly that version. Partner: only what the
 * frozen version says — null when the case has none.
 */
export function caseGrading(caseId: string, viewer: "staff" | "partner"): CaseGrading | null {
  ensureBackfill(caseId);
  const c = caseRow(caseId);
  if (!c) return null;
  const frozen = viewer === "partner" ? partnerRow(caseId) : !EDITABLE.includes(c.status) ? finalRow(caseId) : null;
  if (viewer === "partner" && !frozen) return null;
  if (frozen) {
    const g = (JSON.parse(frozen.body) as ReportBody).grade;
    return {
      status: g.status,
      label: g.label,
      grade: g.grade,
      letter: g.letter,
      final: g.final,
      why: g.reasons[0]?.text ?? null,
      report: reportRef(c.report_token, frozen, true),
      phonecheck: viewer === "partner" ? null : pullState({ storeId: c.store_id, status: c.status, imei: c.imei, imei2: c.imei2 }),
    };
  }
  const l = live(c);
  const g = l.grading;
  return {
    status: g.status,
    label: g.label,
    grade: g.grade,
    letter: g.letter,
    final: g.final,
    why: g.reasons[0]?.text ?? null,
    report: reportRef(c.report_token, latestRow(caseId), false),
    phonecheck: pullState({ storeId: c.store_id, status: c.status, imei: c.imei, imei2: c.imei2 }),
  };
}

/** A pickup line's grade: the frozen version, linked to exactly that version. */
export function pickupGrading(caseId: string): { label: string; final: boolean; version: number; path: string } | null {
  ensureBackfill(caseId);
  const r = partnerRow(caseId);
  const token = (db().prepare(`SELECT report_token FROM cases WHERE id = ?`).get(caseId) as { report_token: string | null } | undefined)?.report_token ?? null;
  if (!r || !token) return null;
  return { label: r.label, final: !!r.final, version: r.version, path: `/r/${token}?v=${r.version}` };
}

/** The customer's link once their check is applied (GET /api/device/status). */
export function reportPathFor(caseId: string): string | null {
  const token = (db().prepare(`SELECT report_token FROM cases WHERE id = ?`).get(caseId) as { report_token: string | null } | undefined)?.report_token ?? null;
  return token ? `/r/${token}` : null;
}

/** What the customer's phone shows beside the link: the grade on both scales. No reasons, no money. */
export type CustomerGrading = { status: Grading["status"]; label: string; grade: MarketGrade | null; letter: GradeLetter | null; final: boolean };

/**
 * The grade the customer's link opens on (GET /api/device/status, once applied):
 * the LATEST ISSUED version — exactly what /r/<token> shows without ?v — never
 * the live grade, so the phone and the page it links to can't disagree.
 * null while nothing is issued.
 */
export function customerGradingFor(caseId: string): CustomerGrading | null {
  const r = latestRow(caseId);
  if (!r) return null;
  const g = (JSON.parse(r.body) as ReportBody).grade;
  return { status: g.status, label: g.label, grade: g.grade, letter: g.letter, final: g.final };
}

/* ─────────────────────────── GET /api/cases/<id>/grading-report ─────────────────────────── */

export type StaffExtras = {
  imei: string | null;
  imei2: string | null;
  camera: {
    /** GradeIQ's own letter (Premium–D) — staff only, never priced, never on the report. */
    gradeiqLetter: string | null;
    components: { id: string; label: string; grade: string }[];
    score: number | null;
    flags: string[];
    disagreements: Disagreement[];
    gradeiq: { report: string; devicefax: string } | null;
  } | null;
  phonecheck: { recordId: string; source: string; aiRead: boolean; links: PcRecord["links"]; testerGrade: string | null; imeiOverride: RecordedOverride | null } | null;
  /** The live grade has moved since the latest issued version (a camera or Phonecheck update no edit re-issued). */
  outOfDate: boolean;
  /** The after-refurb grade the store's sell price (PriceIQ) is looked up at — not the grade of the phone as tested. */
  afterRefurb: { grade: MarketGrade; letter: GradeLetter; label: string } | null;
};

/**
 * The report for one case, filtered by who asks (spec §4.4). Partner: the
 * frozen version only (404 before lock, as for the case itself), no live
 * grade, no versions list, no staff extras.
 */
export function gradingReportFor(u: SessionUser, caseId: string) {
  const v = getCase(u, caseId); // scope: out of scope → 404; the partner sees a case only once traded in
  ensureBackfill(caseId);
  const c = caseRow(caseId)!;
  if (u.role === "partner") {
    const r = partnerRow(caseId);
    return { live: null, issued: r ? envelopeOf(r) : null, versions: r ? [versionOf(r)] : [], path: reportRef(c.report_token, r, true)?.path ?? null, staff: null };
  }
  const l = live(c);
  const latest = latestRow(caseId);
  const rows = db().prepare(`SELECT version, sha256, issued_at, reason, final FROM grading_reports WHERE case_id = ? ORDER BY version`).all(caseId) as VersionRow[];
  const after = gradeAfterRefurb(l.condition);
  const cam = l.camera;
  const gid = cam?.gradeiqId ?? null;
  const pub = gradeiqConfig().publicUrl;
  const staff: StaffExtras = {
    imei: v.imei,
    imei2: v.imei2,
    camera: cam
      ? {
          gradeiqLetter: cam.grade,
          components: l.sessionExtras?.components ?? [],
          score: l.sessionExtras?.score ?? null,
          flags: cam.flags,
          disagreements: l.sessionExtras?.disagreements ?? [],
          gradeiq: gid && /^[0-9a-f-]{36}$/i.test(gid) ? { report: `${pub}/report/${gid}`, devicefax: `${pub}/api/report/${gid}/export` } : null,
        }
      : null,
    phonecheck: l.pc
      ? {
          recordId: l.pc.row.id,
          source: l.pc.row.source,
          aiRead: l.pc.record.aiRead === true,
          links: l.pc.record.links,
          testerGrade: l.pc.record.testerGrade,
          imeiOverride: parseJson<RecordedOverride | null>(l.pc.row.attach_override, null),
        }
      : null,
    outOfDate: !!latest && latest.sha256 !== bodyOf(l).sha,
    afterRefurb: after ? { grade: after, letter: gradeLetter(after)!, label: gradeWithLetter(after)! } : null,
  };
  return {
    live: l.grading,
    issued: latest ? envelopeOf(latest) : null,
    versions: rows.map(versionOf),
    path: c.report_token && latest ? `/r/${c.report_token}` : null,
    staff,
  };
}

/* ─────────────────────────── the public link ─────────────────────────── */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function versionByToken(token: string, v: string | null): { row: VersionRow; caseId: string } {
  const notFound = new HttpError(404, "Report not found.");
  if (!TOKEN_RE.test(token)) throw notFound;
  const c = db().prepare(`SELECT id FROM cases WHERE report_token = ?`).get(token) as { id: string } | undefined;
  if (!c) throw notFound;
  let row: VersionRow | undefined;
  if (v === null || v === "") row = latestRow(c.id) ?? undefined;
  else {
    if (!/^[1-9]\d{0,5}$/.test(v)) throw notFound;
    row = db().prepare(`SELECT * FROM grading_reports WHERE case_id = ? AND version = ?`).get(c.id, Number(v)) as VersionRow | undefined;
  }
  if (!row) throw notFound;
  return { row, caseId: c.id };
}

/** GET /api/r/<token>[?v=n] — anyone with the link. The latest version, or version n. Never a list of versions. */
export function publicReport(token: string, v: string | null): ReportEnvelope {
  return envelopeOf(versionByToken(token, v).row);
}

/** GradeIQ serves one flat folder: /api/uploads/<file>, file = [A-Za-z0-9._-]+ (its own traversal guard). */
const UPLOAD_PATH = /^\/api\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;
const PHOTO_TYPE = /^image\/(jpeg|png|webp|gif|heic|heif)\b/i;

/**
 * GET /api/r/<token>/photo/<n>[?v=] — photo n of that version, streamed from
 * GradeIQ server to server. Only a path listed in that version's photo_sources
 * under /api/uploads/; never a redirect (the URL carries GradeIQ's session id).
 */
export async function reportPhoto(token: string, n: string, v: string | null): Promise<Response> {
  const { row } = versionByToken(token, v);
  const notFound = new HttpError(404, "Photo not found.");
  if (!/^\d{1,3}$/.test(n)) throw notFound;
  const sources = parseJson<string[]>(row.photo_sources, []);
  const src = sources[Number(n)];
  if (typeof src !== "string") throw notFound;
  const at = src.indexOf("/api/uploads/");
  const path = at >= 0 ? src.slice(at).split(/[?#]/)[0] : "";
  if (!UPLOAD_PATH.test(path) || path.includes("..")) throw notFound;
  const cfg = gradeiqConfig();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, { signal: ctl.signal, redirect: "manual", cache: "no-store" });
  } catch {
    clearTimeout(timer);
    throw new HttpError(502, "The photo store can't be reached right now.");
  }
  clearTimeout(timer);
  if (res.status === 404) throw notFound;
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !PHOTO_TYPE.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, "The photo store did not send a photo.");
  }
  return new Response(res.body, { status: 200, headers: { "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
}
