import { createHash, randomBytes, randomInt } from "node:crypto";
import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { getStore, getOrg, canSeeStore, ownStore, storeInScope, type StoreRow } from "./scope";
import { createCase, getCase, updateCase, recordCameraCheck, markLcdOverride, certifyBlock, deviceAnswer, type CertifyBlock } from "./cases";
import { customerGradingFor, issueQuietly, reportPathFor } from "./gradingReport";
import {
  initialGradeiqState,
  kickCreate,
  retryCreate,
  abandon,
  scheduleSync,
  refreshGrading,
  gradingView,
  deviceScreen,
  deviceScreenShown,
  DeviceScreenUnavailable,
  recordOverride,
  evidenceForApply,
  type GiqRow,
  type GradingView,
  type DeviceScreen,
  cameraEvidence,
  cameraGradePending,
  deviceCameraLink,
} from "./gradeiqBridge";
import { GradeiqError, gradeiqConfig, readBatteryHealth } from "./gradeiq";
import { assertNotBlacklisted } from "./imeiResolve";
import { readCertification, withCertification } from "../domain/certify";
import { applyCameraFloor, addFaultSources, blankCameraCheck, resultsWithCameraDisplay, type CaseCameraCheck } from "../domain/gradeiqMap";
import {
  DEFAULT_PLAN,
  CODE_ALPHABET,
  BATTERY_HEALTH_ID,
  normaliseCode,
  readDevice,
  readResults,
  mergeResults,
  mergeCondition,
  withIssues,
  readDeclared,
  summarise,
  progressOf,
  unionFaults,
  readWifi,
  wifiQr,
  matchModel,
  storageVariant,
  batteryHealthResult,
  browserVerdict,
  type PlanItem,
  type TestResults,
  type Declared,
  type DeviceReport,
  type DiagnosticSummary,
  type TradeModelRef,
  type ModelMatch,
  type StoreWifi,
} from "../domain/diagnostics";
import { autoApplyState, type AutoApplyView } from "../domain/autoApply";
import {
  scanFirstApp,
  planForApp,
  readPhase,
  identityForJoin,
  imeiAgreement,
  phoneMayPost,
  nextBatteryHealth,
  storageFromTest,
  storageModelId,
  type PhonePhase,
  type ImeiAgreement,
} from "../domain/phoneLed";

/**
 * SWAPUP CHECK SESSIONS — the customer tests their own phone; the store watches.
 *
 * A session belongs to one case at one store. The store app shows a QR with a
 * 6-character code; the customer's phone exchanges the code for a ticket
 * (join), then posts its damage answers, its test results and "complete".
 *
 *   waiting → opened → joined → testing → complete → applied
 *                                   ↘ expired / cancelled (any time before applied)
 *
 * Security rules:
 *   • the code is short, so join attempts are rate-limited per IP and the code
 *     only works until the session is joined by ONE install (installId);
 *   • the ticket is 32 random bytes and only its sha256 is stored;
 *   • GET /j/<code> marks "opened" but never binds or consumes anything, so a
 *     link preview or a curious tap cannot steal the session;
 *   • staff reads are scoped like cases (out of scope → 404).
 *
 * GradeIQ is the grading engine underneath (lib/server/gradeiqBridge.ts): every
 * session gets a GradeIQ session in the background; the customer's phone shows
 * the screen patterns through /api/device/screen while the STORE device
 * photographs it with GradeIQ's camera page. The GradeIQ id and the camera URL
 * reach staff — and, for SwapUp Check ≥ 0.6.0 only, the customer's own phone
 * through GET /api/device/camera-link, which it shows as its scan code the way
 * GradeIQ v2 does (owner's decision, docs/PHONE-LED-FLOW.md). Never a QR SwapUp
 * prints, a public page, or an older app.
 *
 * Two kinds of code join a phone: a session's own code (made by the store
 * tablet, one session), and a STANDING code — the demo programme's test code
 * and each store's permanent counter code — where every new phone gets a new
 * session (and case) at that store.
 */

export type SessionStatus = "waiting" | "opened" | "joined" | "testing" | "complete" | "applied" | "expired" | "cancelled";

const UNJOINED_TTL_MS = 30 * 60_000;
const JOINED_TTL_MS = 2 * 60 * 60_000;
const OPEN_STATUSES: SessionStatus[] = ["waiting", "opened", "joined", "testing", "complete"];

type Row = GiqRow & {
  id: string;
  code: string;
  case_id: string;
  store_id: string;
  org_id: string;
  created_by: string;
  status: SessionStatus;
  plan: string;
  install_id: string | null;
  ticket_hash: string | null;
  device: string | null;
  declared: string | null;
  results: string;
  created_at: string;
  expires_at: string;
  opened_at: string | null;
  joined_at: string | null;
  completed_at: string | null;
  applied_at: string | null;
  updated_at: string;
  phone_phase: string | null;
  phone_phase_at: string | null;
  /** 'counter' (the customer started it from the store's counter code), 'demo' (the standing test code), NULL (staff). */
  started_via: string | null;
  /** The advisor let the phone go on from Scan without the camera ({by, userId, at}). */
  scan_release: string | null;
};

/** "Check the phone" — the same block as the CaseView's (lib/server/cases.ts certifyBlock). */
export type { CertifyBlock };

export type TestSessionView = {
  id: string;
  code: string;
  caseId: string;
  caseRef: string;
  storeName: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  joinedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  device: DeviceReport | null;
  plan: PlanItem[];
  results: TestResults;
  declared: Declared | null;
  progress: { done: number; total: number };
  summary: DiagnosticSummary | null;
  /** Camera grading (GradeIQ). Staff responses only — null anywhere the customer's phone could read it. */
  grading: GradingView | null;
  /** SwapUp Check ≥ 0.6.0: Identify › Scan › Test › Result, the phone leading (docs/PHONE-LED-FLOW.md). */
  scanFirst: boolean;
  /** Where the customer's phone says it is (POST /api/device/phase); null until it says. */
  phonePhase: PhonePhase | null;
  phonePhaseAt: string | null;
  /** The customer started this trade-in alone, from the store's counter code. */
  customerStarted: boolean;
  /** The IMEI(s) the phone gave against the case's. Staff responses only (null elsewhere). */
  imeiAgreement: ImeiAgreement | null;
  /** "Check the phone": what the advisor certifies by eye. Staff responses only (null elsewhere). */
  certify: CertifyBlock | null;
  /**
   * The answer by itself (lib/domain/autoApply.ts): what the results are waiting for before
   * they go on the case with no "Apply to case" tap, or why Apply refused. Staff only.
   */
  autoApply: AutoApplyView | null;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The origin the links point at: SWAPUP_PUBLIC_URL when set (production), else
 * the origin the request came in on (`base`, from publicOrigin(req)) — so a dev
 * server reached through the web-app proxy (:4620) or a LAN IP hands out links
 * that phone can open — else localhost:4500.
 */
function publicBase(base?: string | null): string {
  return (process.env.SWAPUP_PUBLIC_URL || base || "http://localhost:4500").replace(/\/$/, "");
}

/** Links for a code. The deep link carries the server so a dev build can point anywhere. */
export function linksFor(code: string, base: string = publicBase()) {
  return {
    joinUrl: `${base}/j/${code}`,
    deepLink: `swapupcheck://join?code=${code}&server=${encodeURIComponent(base)}`,
    downloadUrl: `${base}/downloads/swapup-check.apk`,
  };
}

function tradeModelRefs(): TradeModelRef[] {
  return (db().prepare(`SELECT id, brand, model, variants, model_codes FROM trade_models`).all() as {
    id: string;
    brand: string;
    model: string;
    variants: string;
    model_codes: string;
  }[]).map((r) => ({ id: r.id, brand: r.brand, model: r.model, variants: parseJson<string[]>(r.variants, []), modelCodes: parseJson<string[]>(r.model_codes, []) }));
}

/** Expire lazily: a session past its time is expired whenever anyone looks at it. */
function expireIfDue(r: Row): Row {
  if (OPEN_STATUSES.includes(r.status) && r.status !== "complete" && Date.parse(r.expires_at) < Date.now()) {
    db().prepare(`UPDATE test_sessions SET status = 'expired', ticket_hash = NULL, updated_at = ? WHERE id = ? AND status = ?`).run(nowIso(), r.id, r.status);
    return { ...r, status: "expired", ticket_hash: null };
  }
  return r;
}

function rowById(id: string): Row | null {
  const r = db().prepare(`SELECT * FROM test_sessions WHERE id = ?`).get(id) as Row | undefined;
  return r ? expireIfDue(r) : null;
}

/**
 * What "Check the phone" needs for this session, and whether the customer's
 * phone should show the test colours (lib/server/cases.ts certifyBlock).
 */
function certifyFor(r: Row, ce: ReturnType<typeof cameraEvidence>): { block: CertifyBlock; coloursWanted: boolean } {
  const c = db().prepare(`SELECT status, camera_check, certification, faults FROM cases WHERE id = ?`).get(r.case_id) as
    | { status: string; camera_check: string | null; certification: string | null; faults: string | null }
    | undefined;
  return certifyBlock(c ?? { status: "closed", camera_check: null, certification: null, faults: null }, r, ce);
}

/** `staff`: include the grading block (camera URL, GradeIQ result). Never for a device response. */
function view(r: Row, opts: { staff?: boolean } = {}): TestSessionView {
  const plan = parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]);
  const results = parseJson<TestResults>(r.results, {});
  const device = parseJson<DeviceReport | null>(r.device, null);
  const declared = parseJson<Declared | null>(r.declared, null);
  const c = db().prepare(`SELECT ref, imei, imei2 FROM cases WHERE id = ?`).get(r.case_id) as { ref: string; imei: string | null; imei2: string | null } | undefined;
  const store = getStore(r.store_id);
  const hasAnything = !!device || Object.keys(results).length > 0 || !!declared;
  // The store camera's LCD sweep is the native run's display test — fold it in
  // so a fully tested phone isn't reported "incomplete".
  const ce = cameraEvidence(r);
  const effective = resultsWithCameraDisplay(results, ce.mapping.lcd, r.updated_at);
  const cert = opts.staff ? certifyFor(r, ce) : null;
  return {
    id: r.id,
    code: r.code,
    caseId: r.case_id,
    caseRef: c?.ref ?? "",
    storeName: store?.name ?? "",
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    openedAt: r.opened_at,
    joinedAt: r.joined_at,
    completedAt: r.completed_at,
    appliedAt: r.applied_at,
    device,
    plan,
    results: effective,
    declared,
    progress: progressOf(plan, effective),
    summary: hasAnything ? summarise(plan, effective, declared, device, tradeModelRefs()) : null,
    grading: opts.staff ? gradingView(r) : null,
    scanFirst: scanFirstApp(device),
    phonePhase: readPhase(r.phone_phase),
    phonePhaseAt: r.phone_phase_at ?? null,
    customerStarted: r.started_via === "counter",
    imeiAgreement: opts.staff && c ? imeiAgreement(declared, { imei: c.imei, imei2: c.imei2 }) : null,
    certify: cert?.block ?? null,
    autoApply: opts.staff ? autoApplyFor(r, cert?.block ?? null) : null,
  };
}

function inScope(u: SessionUser, id: string): { r: Row; store: StoreRow } {
  const r = rowById(id);
  if (!r) throw new HttpError(404, "Test session not found.");
  const store = getStore(r.store_id);
  if (!store || !canSeeStore(u, store) || u.role === "partner") throw new HttpError(404, "Test session not found.");
  return { r, store };
}

function requireCounter(u: SessionUser): void {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff run customer tests.");
}

/**
 * STANDING CODES — codes that never expire, so a phone can join without a store
 * tablet first making a code. Every NEW phone (installId) that joins one gets
 * its own fresh test session and case at that store; a phone that re-joins gets
 * its own open session back.
 *
 *   demo     DEMO_CODE — demo programmes only. Owner, 2026-10-17: "make a
 *            standard code for test, AAAAAA", so anyone can try SwapUp Check.
 *            Refused outright when no demo programme exists; a real
 *            programme's store never receives these sessions.
 *   counter  each store's permanent counter code (docs/PHONE-LED-FLOW.md): the
 *            customer starts a trade-in alone from the QR on the counter, and
 *            it lands on the store's Home like any other session.
 */
export const DEMO_CODE = normaliseCode(process.env.SWAPUP_DEMO_CODE || "AAAAAA") ?? "AAAAAA";

type StandingTarget = { kind: "demo" | "counter"; code: string; store: StoreRow; staff: SessionUser };

const OPEN_SQL = `status IN ('waiting','opened','joined','testing','complete') AND expires_at > ?`;

/** The staff member a standing code's sessions are opened under (the case's advisor). */
function standingStaff(store: StoreRow, prefer: "advisor" | "store_manager"): SessionUser | null {
  const u = db()
    .prepare(
      `SELECT id, username, name, role, org_id, store_id FROM users
       WHERE store_id = ? AND active = 1 AND role IN ('advisor','store_manager')
       ORDER BY CASE role WHEN ? THEN 0 ELSE 1 END, created_at LIMIT 1`
    )
    .get(store.id, prefer) as { id: string; username: string; name: string; role: SessionUser["role"]; org_id: string; store_id: string | null } | undefined;
  return u ? { id: u.id, username: u.username, name: u.name, role: u.role, orgId: u.org_id, storeId: u.store_id, exp: Date.now() + 60_000 } : null;
}

/** The demo programme's counter (Andheri when it exists) and the staff member its test sessions are opened under. */
function demoTarget(): StandingTarget | null {
  const store = db()
    .prepare(
      `SELECT s.* FROM stores s JOIN orgs o ON o.id = s.org_id
       WHERE o.demo = 1 AND s.active = 1 AND COALESCE(s.status, 'active') = 'active'
       ORDER BY CASE WHEN s.code = 'AND' THEN 0 ELSE 1 END, s.created_at LIMIT 1`
    )
    .get() as StoreRow | undefined;
  if (!store) return null;
  const staff = standingStaff(store, "advisor");
  return staff ? { kind: "demo", code: DEMO_CODE, store, staff } : null;
}

/**
 * Is this a standing code, and where do its sessions go? `standing` is true for
 * the demo code and for any store's counter code even when it can't be used
 * now (no demo programme, a closed store, nobody on its staff) — such a code
 * must never fall through to an ordinary session that happens to share it.
 * Counter sessions are opened under a store manager (an advisor when the store
 * has no manager yet). A store waiting for approval may run tests, as its cases may.
 */
function standingFor(code: string): { standing: boolean; target: StandingTarget | null } {
  if (code === DEMO_CODE) return { standing: true, target: demoTarget() };
  const store = db().prepare(`SELECT * FROM stores WHERE counter_code = ?`).get(code) as StoreRow | undefined;
  if (!store) return { standing: false, target: null };
  if (!store.active || store.status === "rejected") return { standing: true, target: null };
  const staff = standingStaff(store, "store_manager");
  return { standing: true, target: staff ? { kind: "counter", code, store, staff } : null };
}

/**
 * A phone that re-opens SwapUp Check re-joins with the code it stored. After the
 * store has applied its results that session is closed, so a counter code would
 * quietly open a SECOND trade-in (a new case at the store) for the same phone.
 * For this long after an Apply, the same phone is told its check is finished;
 * the app then reads its old ticket's status and shows "the store has your results".
 */
const COUNTER_REJOIN_AFTER_APPLY_MS = 12 * 60 * 60_000;

/** New sessions a counter code may open per store in 10 minutes: the QR is on show to anyone at the counter. */
const COUNTER_NEW_PER_10_MIN = 20;
/**
 * …and per network address. Customers in a store share its Wi‑Fi's one public IP,
 * so this can't be tiny — but one person can no longer use up the whole store's
 * budget (or fill its case list) on their own.
 */
const COUNTER_NEW_PER_IP_PER_10_MIN = 6;
const counterCreates = new Map<string, number[]>();

function noteCounterCreate(storeId: string, ip: string): void {
  const now = Date.now();
  const fresh = (k: string) => (counterCreates.get(k) ?? []).filter((t) => now - t < 10 * 60_000);
  const byStore = fresh(`store:${storeId}`);
  const byIp = fresh(`ip:${ip}`);
  if (byIp.length >= COUNTER_NEW_PER_IP_PER_10_MIN) throw new HttpError(429, "Too many new checks — ask the advisor for a code.");
  if (byStore.length >= COUNTER_NEW_PER_10_MIN) throw new HttpError(429, "Too many new checks — ask the advisor for a code.");
  counterCreates.set(`store:${storeId}`, [...byStore, now]);
  counterCreates.set(`ip:${ip}`, [...byIp, now]);
}

/** The standing-code session this install should join: its own open one, else an unclaimed one, else a new one. */
function standingSessionFor(t: StandingTarget, installId: string, ip: string, resume: boolean, origin?: string | null): string {
  const now = nowIso();
  const mine = db()
    .prepare(`SELECT id FROM test_sessions WHERE code = ? AND store_id = ? AND install_id = ? AND ${OPEN_SQL} ORDER BY created_at DESC LIMIT 1`)
    .get(t.code, t.store.id, installId, now) as { id: string } | undefined;
  if (mine) return mine.id;
  // The app re-joining by itself (on resume, or after a 401) may only get its OWN
  // open check back — never a new trade-in. A cancelled, expired or finished check
  // ends here; starting another takes a deliberate scan of the counter QR.
  if (resume) throw new HttpError(410, "This check has ended — scan the store's QR to start again.");
  if (t.kind === "counter") {
    const last = db()
      .prepare(`SELECT status, applied_at FROM test_sessions WHERE code = ? AND store_id = ? AND install_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(t.code, t.store.id, installId) as { status: string; applied_at: string | null } | undefined;
    if (last?.status === "applied" && last.applied_at && Date.now() - Date.parse(last.applied_at) < COUNTER_REJOIN_AFTER_APPLY_MS)
      throw new HttpError(409, `Check done at ${t.store.name} — ask the advisor for another.`);
  }
  const free = db()
    .prepare(`SELECT id FROM test_sessions WHERE code = ? AND store_id = ? AND install_id IS NULL AND ${OPEN_SQL} ORDER BY created_at DESC LIMIT 1`)
    .get(t.code, t.store.id, now) as { id: string } | undefined;
  if (free) return free.id;
  if (t.kind === "counter") noteCounterCreate(t.store.id, ip);
  return createTestSession(t.staff, t.kind === "demo" ? { customerName: `Test phone (code ${DEMO_CODE})` } : {}, origin, { fixedCode: t.code, via: t.kind }).session.id;
}

function randomCode(): string {
  let code = "";
  for (let k = 0; k < 6; k++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Taken: the demo code, any store's counter code, or the code of a session still open. */
function codeTaken(code: string): boolean {
  if (code === DEMO_CODE) return true;
  if (db().prepare(`SELECT 1 FROM stores WHERE counter_code = ?`).get(code)) return true;
  return !!db().prepare(`SELECT 1 FROM test_sessions WHERE code = ? AND ${OPEN_SQL}`).get(code, nowIso());
}

function freshCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    if (!codeTaken(code)) return code;
  }
  throw new HttpError(503, "Could not make a fresh code — try again.");
}

/* ─────────────────────────── staff side ─────────────────────────── */

export function createTestSession(
  u: SessionUser,
  input: { caseId?: string | null; customerName?: string; customerPhone?: string },
  origin?: string | null,
  internal: { fixedCode?: string; via?: "demo" | "counter" } = {}
) {
  requireCounter(u);
  const store = ownStore(u);
  let caseId = input.caseId || null;
  if (caseId) {
    const c = getCase(u, caseId); // scope check
    if (!["draft", "quoted"].includes(c.status)) throw new HttpError(409, "That case is past the counter — start a new one.");
    // The IMEI came first (contract I3): a phone reported lost or stolen is not tested at all.
    assertNotBlacklisted(caseId);
  } else {
    caseId = createCase(u, { customerName: input.customerName, customerPhone: input.customerPhone, via: internal.via }).id;
  }
  const now = nowIso();
  const id = newId("ts");
  const code = internal.fixedCode ?? freshCode();
  db()
    .prepare(
      `INSERT INTO test_sessions (id, code, case_id, store_id, org_id, created_by, status, plan, results, created_at, expires_at, updated_at, gradeiq_state, started_via)
       VALUES (?,?,?,?,?,?,'waiting',?,'{}',?,?,?,?,?)`
    )
    .run(id, code, caseId, store.id, store.org_id, u.id, JSON.stringify(DEFAULT_PLAN), now, new Date(Date.now() + UNJOINED_TTL_MS).toISOString(), now, initialGradeiqState(), internal.via ?? null);
  const via = internal.via === "counter" ? "counter code" : internal.via === "demo" ? "standing demo code" : null;
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "test_session.create", entity: "test_session", entityId: id, detail: { caseId, ...(via ? { via } : {}) } });
  // The GradeIQ session is created in the background once this commits — a
  // slow GradeIQ never holds up the counter.
  kickCreate(id);
  return withLinks(view(rowById(id)!, { staff: true }), store, origin);
}

function withLinks(session: TestSessionView, store: StoreRow, origin?: string | null) {
  const wifi = storeWifi(store);
  return { session, ...linksFor(session.code, publicBase(origin)), wifi: wifi ? { ssid: wifi.ssid, qr: wifiQr(wifi) } : null };
}

/** The staff read the store app polls. Pulls what GradeIQ has (throttled) before answering. */
export async function getTestSession(u: SessionUser, id: string, origin?: string | null) {
  const { r, store } = inScope(u, id);
  await refreshGrading(r.id);
  // Tests in, camera in: the results go on the case now, and this answer already says "applied".
  if (r.status === "complete") await Promise.race([autoApply(r.id, u), new Promise((res) => setTimeout(res, AUTO_POLL_WAIT_MS))]);
  return withLinks(view(rowById(r.id) ?? r, { staff: true }), store, origin);
}

export function listOpenSessions(u: SessionUser): TestSessionView[] {
  requireCounter(u);
  const store = ownStore(u);
  const rows = db()
    .prepare(`SELECT * FROM test_sessions WHERE store_id = ? AND status IN ('waiting','opened','joined','testing','complete') ORDER BY created_at DESC LIMIT 50`)
    .all(store.id) as Row[];
  return rows
    .map(expireIfDue)
    .filter((r) => r.status !== "expired")
    .map((r) => view(r, { staff: true }));
}

/** Apply's answer while the store camera's grade can still change — a wait, not a refusal (the answer opens by itself after it). */
export const GRADE_WAIT = "Camera grade coming — apply again in a moment.";

/**
 * Put the phone's results on the case. `auto`: the server did it by itself, the moment the
 * tests and the camera grade were in (autoApply below) — the same gates, the same record.
 */
export async function applyTestSession(u: SessionUser, id: string, opts: { auto?: boolean } = {}) {
  requireCounter(u);
  const { r } = inScope(u, id);
  if (r.status === "applied") throw new HttpError(409, "These results are already on the case.");
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "There are no results to apply yet.");
  if (!view(r).summary) throw new HttpError(409, "There are no results to apply yet.");
  if (!["draft", "quoted"].includes(getCase(u, r.case_id).status)) throw new HttpError(409, "The case is past the counter.");

  // What the store camera saw (GradeIQ) — one last pull and the DeviceFax
  // snapshot, outside any transaction. Only a FINAL grade's confirmed damage
  // counts; anything weaker stays a flag for the advisor.
  const cam = await evidenceForApply(r.id);
  if (cam.pending) throw new HttpError(409, GRADE_WAIT);
  const now = nowIso();

  // Those were up to two GradeIQ round trips: read the session and the case
  // again, so results that arrived and edits the advisor saved meanwhile are
  // not overwritten with what was read before.
  const fresh = rowById(r.id);
  if (!fresh || fresh.status === "applied") throw new HttpError(409, "These results are already on the case.");
  if (!["joined", "testing", "complete"].includes(fresh.status)) throw new HttpError(409, "This test session is closed.");
  const v = view(fresh);
  const s = v.summary;
  if (!s) throw new HttpError(409, "There are no results to apply yet.");
  // Photos are the phone's last step, so "complete" can arrive seconds before the
  // camera grade. Apply is one-shot: wait for the grade (≤ 180 s) rather than
  // turning confirmed damage into "not final" flags.
  if (cameraGradePending(fresh)) throw new HttpError(409, GRADE_WAIT);
  const c = getCase(u, r.case_id);
  if (!["draft", "quoted"].includes(c.status)) throw new HttpError(409, "The case is past the counter.");

  const patch: Parameters<typeof updateCase>[2] = {};
  // What the advisor reads at the top of the case's camera record: things the
  // customer's phone SAID that the case does not simply take.
  const identityFlags: string[] = [];
  const refs = tradeModelRefs();
  const pick = v.declared?.picked ?? null;
  const picked = pick ? (refs.find((m) => m.id === pick.modelId) ?? null) : null;
  // The IMEI named the case's model first (lib/server/imeiResolve.ts): a phone code that names
  // ANOTHER model is a flag for the advisor, never a silent overwrite — and its match is then not
  // used for the storage either (it would be the other model's sizes).
  const byImei = c.modelSource === "imei" && c.device ? c.device : null;
  const disagrees = !!s.model.modelId && !!byImei && s.model.modelId !== byImei.modelId;
  const match: typeof s.model = disagrees ? { ...s.model, modelId: null, label: null, variant: null, match: "none" } : s.model;
  if (disagrees) {
    identityFlags.push(`Model: phone code says ${s.model.label ?? "another model"}; the IMEI says ${byImei!.brand} ${byImei!.model} — check Settings › About phone.`);
  } else if (s.model.modelId) {
    patch.modelId = s.model.modelId;
    // The phone's code matched, but the customer picked another model (or said "No"
    // and picked nothing): record it — the match stands, the advisor checks. Saying
    // "No" and then picking the SAME model is agreement, not a dispute.
    if ((picked && picked.id !== s.model.modelId) || (v.declared?.identityConfirmed === false && !picked)) {
      identityFlags.push(
        `Model: phone says ${s.model.label ?? "a known model"}; customer disagreed${picked ? `, picked ${picked.brand} ${picked.model}` : ""} — check Settings.`
      );
    }
  } else if (picked && (!c.device || c.device.modelId === picked.id)) {
    // The phone's model code isn't one SwapUp knows: the customer's own pick fills
    // the case's model — as a CLAIM the advisor checks, never a match. A case that
    // already has that model keeps it; the pick can still settle the storage.
    patch.modelId = picked.id;
    if (!c.device)
      identityFlags.push(
        `Model: customer picked ${picked.brand} ${picked.model}; code unknown — check before pricing.`
      );
  }
  // Storage (lib/domain/phoneLed.ts storageFromTest): the phone's measurement, else
  // the model's only size, else the customer's own pick — a claim, flagged here and
  // ticked in Settings › About phone before the trade-in is locked. Never a guess:
  // nothing found leaves it to one row of priced chips on the answer screen. A size
  // the phone measured that isn't on the model's list is kept on the case too, so the
  // answer says so instead of "couldn't measure" — and no pick is used against it.
  // A re-test that can't measure (the browser) keeps an earlier reading of the SAME model:
  // a pick on the second test must not undo what the phone measured on the first.
  const measuredNow = storageVariant(v.device?.totalDiskBytes);
  const claim = picked && pick ? { modelId: picked.id, variant: pick.variant ?? null } : null;
  // The join told the phone the IMEI's model (caseModelForJoin) because its own code named
  // nothing, and nobody picked: the phone's reading settles THAT model's storage.
  const caseModel = { caseModelId: c.device?.modelId ?? null, caseVariant: c.device?.variant ?? null, caseModelJoined: !s.model.modelId && !claim && !!byImei };
  const sizesOf = storageModelId({ match, picked: claim, ...caseModel });
  const earlier = sizesOf && sizesOf === caseModel.caseModelId ? c.measuredStorage : null;
  const measured = measuredNow ?? earlier;
  const storage = storageFromTest({
    match,
    picked: claim,
    variants: refs.find((m) => m.id === sizesOf)?.variants ?? [],
    ...caseModel,
    measured,
    caseSource: c.variantSource,
  });
  if (storage.variant) patch.variant = storage.variant;
  else if (storage.clear) patch.variant = null;
  if (storage.flag) identityFlags.push(storage.flag);
  const testedFaults = s.faults.map((f) => f.id);
  const cameraFaults = cam.mapping.faults.map((f) => f.id);
  patch.faults = unionFaults(unionFaults(c.faults, testedFaults), cameraFaults);
  // Never better than what the advisor recorded, the faults allow, or the camera confirmed — and what the
  // advisor certified by eye on "Check the phone" (before Apply too) is the screen and body, on that floor.
  patch.condition = withCertification(
    // A failed Wi-Fi / Bluetooth, fingerprint or vibration test puts its priced issue on the condition.
    applyCameraFloor(withIssues(mergeCondition(c.condition, patch.faults as typeof c.faults), s.issues), cam.mapping.floor),
    c.certification,
    patch.faults as typeof c.faults,
    cam.mapping.floor
  );
  // The IMEI(s) the customer's phone gave (*#06#). An IMEI the case already has
  // is never replaced by one typed on the customer's phone: when they share no
  // number, the case keeps its own and the advisor is told — the copy of
  // GradeIQ's identity.imei_mismatch (record, don't reconcile).
  const said = v.declared;
  const agreement = imeiAgreement(said, { imei: c.imei, imei2: c.imei2 });
  if (agreement === "differs") {
    identityFlags.push(
      `IMEI differs: phone gave ${[said?.imei, said?.imei2].filter(Boolean).join(" / ")}, case has ${[c.imei, c.imei2].filter(Boolean).join(" / ")} — check *#06#.`
    );
  } else {
    if (said?.imei && !c.imei) patch.imei = said.imei;
    const first = patch.imei ?? c.imei;
    // The phone's other number fills the second IMEI, whichever order it was typed in.
    const other = [said?.imei, said?.imei2].find((x) => !!x && x !== first) ?? null;
    if (other && !c.imei2 && first) patch.imei2 = other;
  }
  // A customer who started the trade-in alone typed their own name and number.
  // They fill the case only where it is empty — never over what the advisor has.
  const name = !c.customer?.name?.trim() ? said?.customerName || null : null;
  const phone = !c.customer?.phone ? said?.customerPhone || null : null;
  if (name || phone) patch.customer = { ...(name ? { name } : {}), ...(phone ? { phone } : {}) };

  // Where each fault came from, and the camera's word on the case — written
  // BEFORE updateCase so its re-price already knows about an identity mismatch.
  const sources = addFaultSources(c.faultSources, [
    ...s.faults.flatMap((f) => f.sources.map((source) => ({ id: f.id, source }))),
    ...cam.mapping.faults.map((f) => ({ id: f.id, source: "camera_ai" as const })),
  ]);
  const prevCheck = c.camera;
  const check: CaseCameraCheck = {
    ...blankCameraCheck(now),
    testSessionId: r.id,
    gradeiqId: cam.gradeiqId,
    state: cam.state,
    by: u.name,
    grade: cam.snap?.cosmeticGrade || null,
    // Nothing graded by Apply is "not camera-graded", not "waiting".
    status: cam.snap?.cosmeticGrade || cam.fin.status === "failed" ? cam.fin.status : "none",
    final: cam.fin.final,
    gradeRange: cam.snap?.gradeRange ?? null,
    conclusive: cam.snap?.conclusive ?? null,
    needsHumanReview: cam.snap?.needsHumanReview ?? false,
    floor: cam.mapping.floor,
    faults: cam.mapping.faults.map((f) => ({ id: f.id, because: f.because, photoIndex: f.photoIndex, confidence: f.confidence })),
    suggested: cam.mapping.suggested.map((f) => ({ id: f.id, because: f.because, photoIndex: f.photoIndex, confidence: f.confidence })),
    flags: [
      ...identityFlags,
      ...(cam.state !== "ready"
        ? ["Not camera-graded — the condition is the advisor's."]
        : cam.fin.final
          ? []
          : cam.snap?.cosmeticGrade || cam.fin.status === "failed"
            ? cam.fin.reasons
            : ["No camera grade by Apply — condition is the advisor's."]),
      ...cam.mapping.flags,
      ...cam.notes,
    ],
    lcd: cam.mapping.lcd,
    lcdOverride: cam.override,
    identity: cam.mapping.identity,
    // A manager's identity decision and earlier overrides survive a re-test only if the camera says the same thing again.
    identityOverride: prevCheck?.identity.verdict === "mismatch" && cam.mapping.identity.verdict === "mismatch" ? prevCheck.identityOverride : null,
    overrides: prevCheck?.overrides ?? [],
    devicefax: cam.devicefax,
  };
  recordCameraCheck(r.case_id, check, sources);

  // updateCase re-prices (partner quote, repair estimate, decision) outside any
  // transaction, and suggests the new phone unless staff already chose one.
  // It also issues the grading report's next version ("swapup_check"): the case's
  // camera record names this session now, so its results are the report's evidence.
  const after = await updateCase(u, r.case_id, patch, {
    variantSource: storage.source ?? undefined,
    ...(patch.modelId ? { modelSource: s.model.modelId && !disagrees ? ("phone" as const) : ("customer" as const) } : {}),
    autoUpgrade: true,
    measuredStorage: measuredNow ?? (earlier ? undefined : null),
    reportReason: "swapup_check",
  });
  // The ticket stays valid for STATUS reads only (byTicket refuses writes once
  // applied), so the customer's phone can show "the store has your results".
  db().prepare(`UPDATE test_sessions SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
  // A no-op when updateCase already issued it (same body, same hash) — here so the
  // report is never missing once the session reads "applied".
  issueQuietly(r.case_id, "swapup_check", u.id);
  audit({
    userId: u.id,
    orgId: r.org_id,
    storeId: r.store_id,
    action: "test_session.apply",
    entity: "test_session",
    entityId: r.id,
    detail: {
      ...(opts.auto ? { auto: true } : {}),
      faults: patch.faults,
      model: s.model,
      ...(patch.modelId && !s.model.modelId ? { modelSource: "customer picked" } : {}),
      storage: { variant: after.device?.variant ?? null, source: after.variantSource, measured },
      upgrade: after.upgrade?.suggested ? after.upgrade.deviceId : null,
      imei: agreement,
      camera: { state: cam.state, grade: check.grade, final: check.final, faults: cameraFaults, identity: check.identity.verdict, lcdChecked: check.lcd.cameraChecked },
    },
  });
  autoRefused.delete(r.id);
  return { session: view(rowById(r.id)!, { staff: true }), caseId: r.case_id };
}

/* ─────────────────────────── the answer by itself ─────────────────────────── */

/**
 * When the customer's phone has finished and the camera's grade is in (and, where the camera
 * couldn't decide, the advisor has tapped every row of "Check the phone"), the results go on
 * the case with no "Apply to case" tap — lib/domain/autoApply.ts decides when. It is tried from
 * the store's poll of the session (as the advisor watching it), when the phone says it has
 * finished, and from the phone's own status poll (as the advisor who started the trade-in), so
 * the answer is ready even when nobody is on the Session screen. Apply keeps all its gates; a
 * refusal is kept with the session's version and shown with a Retry (a manual Apply), and is
 * not tried again until something changes. One attempt at a time per session.
 */
const autoInFlight = new Map<string, Promise<void>>();
const autoRefused = new Map<string, { reason: string; key: string }>();
/** Not an answer from Apply (a database or GradeIQ hiccup): try again after this. */
const autoBackoff = new Map<string, number>();
const AUTO_BACKOFF_MS = 10_000;
/** How long the store's poll waits for an attempt in progress before answering anyway. */
const AUTO_POLL_WAIT_MS = 4_000;

/** The session's version for a kept refusal: the session or its case changing is worth one more try. */
function autoKey(r: Row): string {
  const c = db().prepare(`SELECT updated_at FROM cases WHERE id = ?`).get(r.case_id) as { updated_at: string } | undefined;
  return `${r.updated_at}|${c?.updated_at ?? ""}`;
}

function autoApplyFor(r: Row, certify: CertifyBlock | null): AutoApplyView {
  const refused = autoRefused.get(r.id) ?? null;
  return autoApplyState({
    status: r.status,
    gradePending: r.status === "complete" && cameraGradePending(r),
    certify,
    refused,
    key: refused ? autoKey(r) : "",
  });
}

/**
 * Who an automatic Apply is recorded as: the advisor or manager polling the session when it is
 * one of this store's counter staff, else the advisor who started the trade-in, else (gone since,
 * or a counter-code session) the store's first advisor.
 */
function sessionActor(r: Row, polling: SessionUser | null): SessionUser | null {
  if (polling && (polling.role === "advisor" || polling.role === "store_manager") && polling.storeId === r.store_id) return polling;
  const staff = (id: string | null | undefined): SessionUser | null => {
    if (!id) return null;
    const u = db()
      .prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ? AND active = 1 AND role IN ('advisor','store_manager') AND store_id = ?`)
      .get(id, r.store_id) as { id: string; username: string; name: string; role: SessionUser["role"]; org_id: string; store_id: string | null } | undefined;
    return u ? { id: u.id, username: u.username, name: u.name, role: u.role, orgId: u.org_id, storeId: u.store_id, exp: Date.now() + 60_000 } : null;
  };
  // Whoever looked at the phone — the last "Check the phone" tap, else the one who released its
  // Scan step — before whoever only started the trade-in, and a stand-in advisor last of all.
  const certRow = db().prepare(`SELECT certification FROM cases WHERE id = ?`).get(r.case_id) as { certification: string | null } | undefined;
  const lastCert = Object.values(readCertification(parseJson<unknown>(certRow?.certification ?? null, null)))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const released = parseJson<{ userId?: string } | null>(r.scan_release, null);
  const u = staff(lastCert?.userId) ?? staff(released?.userId) ?? staff(r.created_by);
  if (u) return u;
  const store = getStore(r.store_id);
  return store ? standingStaff(store, "advisor") : null;
}

/** Put the results on the case if everything is in. Never throws: what happened is on the session's view. */
export function autoApply(id: string, polling: SessionUser | null = null): Promise<void> {
  const running = autoInFlight.get(id);
  if (running) return running;
  const p = (async () => {
    const r0 = rowById(id);
    if (!r0 || r0.status !== "complete" || (autoBackoff.get(id) ?? 0) > Date.now()) return;
    // The camera's latest word first (throttled inside): a grade that just landed lifts the wait.
    if (cameraGradePending(r0)) await refreshGrading(id).catch(() => {});
    const r = rowById(id);
    if (!r || r.status !== "complete") return;
    if (autoApplyFor(r, certifyFor(r, cameraEvidence(r)).block).state !== "ready") return;
    const u = sessionActor(r, polling);
    if (!u) return;
    try {
      await applyTestSession(u, id, { auto: true });
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) {
        // The grade turned out to be still coming (Apply's last pull): a wait, not a refusal.
        if (e.message === GRADE_WAIT) return;
        const fresh = rowById(id);
        if (fresh && fresh.status !== "applied") autoRefused.set(id, { reason: e.message, key: autoKey(fresh) });
        return;
      }
      autoBackoff.set(id, Date.now() + AUTO_BACKOFF_MS);
      console.error(`[swapup] automatic apply of ${id} failed:`, e instanceof Error ? e.message : e);
    }
  })().finally(() => autoInFlight.delete(id));
  autoInFlight.set(id, p);
  return p;
}

/**
 * The storage a case already has for this model — a size on the case, or the phone's own
 * reading from an earlier test — or null. The join uses it so a re-test doesn't ask the
 * customer a question whose answer Apply would set aside (lib/domain/phoneLed.ts storageFromTest).
 */
function settledOnCase(caseId: string, modelId: string | null): string | null {
  if (!modelId) return null;
  const c = db().prepare(`SELECT model_id, variant, measured_storage FROM cases WHERE id = ?`).get(caseId) as
    | { model_id: string | null; variant: string | null; measured_storage: string | null }
    | undefined;
  if (!c || c.model_id !== modelId) return null;
  return c.variant ?? c.measured_storage ?? null;
}

export function cancelTestSession(u: SessionUser, id: string) {
  requireCounter(u);
  const { r, store } = inScope(u, id);
  if (["applied", "cancelled"].includes(r.status)) throw new HttpError(409, "This session is already closed.");
  db().prepare(`UPDATE test_sessions SET status = 'cancelled', ticket_hash = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), r.id);
  abandon(r.id, "test session cancelled");
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.cancel", entity: "test_session", entityId: r.id });
  return withLinks(view(rowById(r.id)!, { staff: true }), store);
}

/** A new code for the SAME case — the old one stops working. Results so far are kept only if joined. */
export function reissueTestSession(u: SessionUser, id: string, origin?: string | null) {
  requireCounter(u);
  const { r } = inScope(u, id);
  if (r.status === "applied") throw new HttpError(409, "These results are already on the case.");
  const out = tx(() => {
    db().prepare(`UPDATE test_sessions SET status = 'cancelled', ticket_hash = NULL, updated_at = ? WHERE id = ? AND status != 'applied'`).run(nowIso(), r.id);
    return createTestSession(u, { caseId: r.case_id }, origin);
  });
  // A new code is a new GradeIQ session: the photos belong to the phone that joins it.
  abandon(r.id, "test session reissued");
  return out;
}

/** Staff pressed Retry after "Camera grading unavailable". */
export function retryGrading(u: SessionUser, id: string) {
  requireCounter(u);
  const { r, store } = inScope(u, id);
  if (!["waiting", "opened", "joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "This session is closed.");
  if (r.gradeiq_id) throw new HttpError(409, "Camera grading is already set up for this session.");
  try {
    retryCreate(r.id);
  } catch (e) {
    if (e instanceof GradeiqError) throw new HttpError(409, e.message);
    throw e;
  }
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.gradeiq_retry", entity: "test_session", entityId: r.id });
  return withLinks(view(rowById(r.id)!, { staff: true }), store);
}

/**
 * Unlock the camera page without the customer's phone echoing patterns (it
 * can't run SwapUp Check, or SwapUp can't read GradeIQ's pairing state). Fail
 * closed: this needs a name and a reason, and the case is marked "LCD not
 * camera-checked" — the photos still grade the glass, but the screen sweep is
 * not a closed loop any more.
 */
export async function cameraOverride(u: SessionUser, id: string, raw: { reason?: unknown }, origin?: string | null) {
  requireCounter(u);
  const { r, store } = inScope(u, id);
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "The customer's phone has to join the session first.");
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id) throw new HttpError(409, "No camera grading for this session.");
  const reason = typeof raw?.reason === "string" ? raw.reason.trim().slice(0, 300) : "";
  if (reason.length < 8) throw new HttpError(400, "Say why the camera starts without the phone's colours.");
  const info = { by: u.name, reason, at: nowIso() };
  recordOverride(r.id, info);
  markLcdOverride(r.case_id, { ...info, userId: u.id, testSessionId: r.id });
  // Going on without the phone's colours lets the phone go on from its Scan step too — the one way an
  // older SwapUp Store (no "release" button) can let a SwapUp Check ≥ 0.8.0 phone past Scan.
  db().prepare(`UPDATE test_sessions SET scan_release = ? WHERE id = ? AND scan_release IS NULL`).run(JSON.stringify({ by: u.name, userId: u.id, at: info.at }), r.id);
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.camera_override", entity: "test_session", entityId: r.id, detail: { reason } });
  return getTestSession(u, r.id, origin);
}

/**
 * Let the customer's phone go on from its Scan step without the camera — by
 * name, in SwapUp Store. The customer is never asked to skip it: the phone stays
 * on Scan (showing the patterns the camera asks for) until the camera finishes,
 * or until the advisor releases it here; GET /api/device/screen then says
 * `released`. The screen is certified by eye afterwards ("Check the phone").
 */
export function releaseScan(u: SessionUser, id: string, origin?: string | null) {
  requireCounter(u);
  const { r, store } = inScope(u, id);
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "The customer's phone has to join the session first.");
  if (r.scan_release) return withLinks(view(r, { staff: true }), store, origin);
  const info = { by: u.name, userId: u.id, at: nowIso() };
  db().prepare(`UPDATE test_sessions SET scan_release = ?, updated_at = ? WHERE id = ? AND scan_release IS NULL`).run(JSON.stringify(info), info.at, r.id);
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.scan_release", entity: "test_session", entityId: r.id, detail: { phase: r.phone_phase } });
  return withLinks(view(rowById(r.id)!, { staff: true }), store, origin);
}

/* ─────────────────────────── store Wi-Fi ─────────────────────────── */

function storeWifi(store: StoreRow & { settings?: string }): StoreWifi | null {
  const row = db().prepare(`SELECT settings FROM stores WHERE id = ?`).get(store.id) as { settings: string } | undefined;
  return parseJson<{ wifi?: StoreWifi | null }>(row?.settings, {}).wifi ?? null;
}

export function getStoreWifi(u: SessionUser, storeId: string) {
  const store = storeInScope(u, storeId);
  if (u.role === "partner") throw new HttpError(404, "Store not found.");
  const wifi = storeWifi(store);
  return { wifi, qr: wifi ? wifiQr(wifi) : null };
}

export function setStoreWifi(u: SessionUser, storeId: string, raw: unknown) {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only the store manager can change the store Wi-Fi.");
  const store = storeInScope(u, storeId);
  const r = readWifi(raw);
  if (!r.ok) throw new HttpError(400, r.reason);
  const row = db().prepare(`SELECT settings FROM stores WHERE id = ?`).get(store.id) as { settings: string };
  const settings = { ...parseJson<Record<string, unknown>>(row.settings, {}), wifi: r.wifi };
  db().prepare(`UPDATE stores SET settings = ? WHERE id = ?`).run(JSON.stringify(settings), store.id);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store.wifi", entity: "store", entityId: store.id, detail: { ssid: r.wifi?.ssid ?? null } });
  return { wifi: r.wifi, qr: r.wifi ? wifiQr(r.wifi) : null };
}

/* ─────────────────────────── the store's counter code ─────────────────────────── */

/**
 * Each store's permanent counter code (docs/PHONE-LED-FLOW.md): printed as a QR
 * on the counter, so a customer can start a trade-in alone — their phone opens
 * /j/<code>, joins, and the session (with a new case) lands on the store's Home.
 * Made the first time anyone at the store asks for it. A new one replaces it at
 * once; phones already mid-check on the old one carry on.
 */
function storeCounterCode(storeId: string): string | null {
  return (db().prepare(`SELECT counter_code FROM stores WHERE id = ?`).get(storeId) as { counter_code: string | null } | undefined)?.counter_code ?? null;
}

/** Give the store a fresh code — only if its code is still `prev` (two first reads race to one code). */
function issueCounterCode(store: StoreRow, prev: string | null): string {
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    if (code === prev || codeTaken(code)) continue;
    try {
      db().prepare(`UPDATE stores SET counter_code = ? WHERE id = ? AND counter_code IS ?`).run(code, store.id, prev);
    } catch (e) {
      if (String((e as Error)?.message).includes("UNIQUE")) continue; // another store took it meanwhile
      throw e;
    }
    break;
  }
  const now = storeCounterCode(store.id);
  if (!now || now === prev) throw new HttpError(503, "Could not make a counter code — try again.");
  return now;
}

function counterReply(code: string, origin?: string | null) {
  return { code, joinUrl: linksFor(code, publicBase(origin)).joinUrl };
}

/** GET /api/stores/counter-code — the caller's own store's code (made on first read). Advisor or store manager. */
export function getCounterCode(u: SessionUser, origin?: string | null) {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only a store's own staff can show its counter code.");
  const store = ownStore(u);
  const existing = storeCounterCode(store.id);
  if (existing) return counterReply(existing, origin);
  const code = issueCounterCode(store, null);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store.counter_code", entity: "store", entityId: store.id, detail: { code, first: true } });
  return counterReply(code, origin);
}

/** POST /api/stores/counter-code/regenerate — a new code; the old one stops starting new checks at once. Store manager only. */
export function regenerateCounterCode(u: SessionUser, origin?: string | null) {
  if (u.role !== "store_manager") throw new HttpError(403, "Only the store manager can make a new counter code.");
  const store = ownStore(u);
  const prev = storeCounterCode(store.id);
  const code = issueCounterCode(store, prev);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store.counter_code", entity: "store", entityId: store.id, detail: { code, replaced: prev } });
  return counterReply(code, origin);
}

/* ─────────────────────────── the public page ─────────────────────────── */

/**
 * What /j/<code> may show. Marks the session opened; never binds or consumes it.
 * A standing code (the demo code, a store's counter code) has no session until a
 * phone joins, so it shows the store and no case: `caseRef` is null.
 */
export function openByCode(
  raw: string
): { ok: true; code: string; kind: "session" | "demo" | "counter"; storeName: string; caseRef: string | null; status: SessionStatus } | { ok: false } {
  const code = normaliseCode(raw);
  if (!code) return { ok: false };
  const st = standingFor(code);
  if (st.standing) {
    // Nothing is created by opening the link — only by a phone joining.
    const t = st.target;
    if (!t) return { ok: false };
    return { ok: true, code, kind: t.kind, storeName: t.store.name, caseRef: t.kind === "demo" ? `${DEMO_CODE} (test)` : null, status: "opened" };
  }
  const r0 = db()
    .prepare(`SELECT * FROM test_sessions WHERE code = ? ORDER BY created_at DESC LIMIT 1`)
    .get(code) as Row | undefined;
  if (!r0) return { ok: false };
  const r = expireIfDue(r0);
  if (!OPEN_STATUSES.includes(r.status)) return { ok: false };
  if (r.status === "waiting") {
    const now = nowIso();
    db().prepare(`UPDATE test_sessions SET status = 'opened', opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ? AND status = 'waiting'`).run(now, now, r.id);
  }
  const v = view(r);
  return { ok: true, code, kind: "session", storeName: v.storeName, caseRef: v.caseRef, status: r.status === "waiting" ? "opened" : r.status };
}

/* ─────────────────────────── device side ─────────────────────────── */

const joinAttempts = new Map<string, { n: number; until: number }>();

/**
 * What this stops is guessing codes, so only REFUSED joins count. A phone
 * re-joining its own session (the app does on every resume; the browser check
 * on every return to its tab) is not a guess — and every customer in a store
 * shares the store Wi‑Fi's one public IP, so counting those would lock the
 * next customer out of a perfectly good code.
 */
function checkJoinRate(ip: string): void {
  const cur = joinAttempts.get(ip);
  if (cur && cur.until > Date.now() && cur.n >= 20) throw new HttpError(429, "Too many tries — wait, then scan the QR again.");
}

function noteRefusedJoin(ip: string): void {
  const now = Date.now();
  const cur = joinAttempts.get(ip);
  if (cur && cur.until > now) cur.n += 1;
  else joinAttempts.set(ip, { n: 1, until: now + 10 * 60_000 });
}

export function joinByCode(input: { code?: unknown; device?: unknown; appVersion?: unknown; installId?: unknown }, ip: string, origin?: string | null) {
  checkJoinRate(ip);
  try {
    return joinByCodeChecked(input, ip, origin);
  } catch (e) {
    // Not a guess: a resume finding its check ended (410), or a busy store (429).
    if (e instanceof HttpError && e.status < 500 && e.status !== 410 && e.status !== 429) noteRefusedJoin(ip);
    throw e;
  }
}

function joinByCodeChecked(input: { code?: unknown; device?: unknown; appVersion?: unknown; installId?: unknown }, ip: string, origin?: string | null) {
  const out = joinTx(input, ip, origin);
  // Forward the device report to GradeIQ (call 2) once the join has committed.
  scheduleSync(out.session.id);
  return out;
}

function joinTx(input: { code?: unknown; device?: unknown; appVersion?: unknown; installId?: unknown }, ip: string, origin?: string | null) {
  const code = normaliseCode(input.code);
  const installId = typeof input.installId === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(input.installId) ? input.installId : null;
  if (!installId) throw new HttpError(400, "The app did not send its install id — update SwapUp Check.");
  const invalid = new HttpError(404, "That code has expired — ask the store for a new one.");
  if (!code) throw invalid;
  const st = standingFor(code);
  if (st.standing && !st.target) throw invalid;
  const resume = (input as { resume?: unknown }).resume === true;
  const standingId = st.target ? standingSessionFor(st.target, installId, ip, resume, origin) : null;
  return tx(() => {
    // A session code: this phone's own open session first — after a store
    // regenerates its counter code, the phones mid-check on the old one still
    // re-join their own sessions, which share that code.
    const r0 = (
      standingId
        ? db().prepare(`SELECT * FROM test_sessions WHERE id = ?`).get(standingId)
        : (db().prepare(`SELECT * FROM test_sessions WHERE code = ? AND install_id = ? AND ${OPEN_SQL} ORDER BY created_at DESC LIMIT 1`).get(code, installId, nowIso()) ??
          db().prepare(`SELECT * FROM test_sessions WHERE code = ? ORDER BY created_at DESC LIMIT 1`).get(code))
    ) as Row | undefined;
    if (!r0) throw invalid;
    const r = expireIfDue(r0);
    if (!["waiting", "opened", "joined", "testing", "complete"].includes(r.status)) throw invalid;
    if (r.install_id && r.install_id !== installId) throw new HttpError(409, "This code is in use on another phone — ask for a new one.");
    const ticket = randomBytes(32).toString("base64url");
    const now = nowIso();
    const device = readDevice(input.device, input.appVersion);
    const firstJoin = !r.install_id;
    // The plan this app can run: battery_health only for SwapUp Check ≥ 0.6.0, and only when the
    // case has no battery-health % from another source (an attached Phonecheck report).
    const plan = planForApp(parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]), scanFirstApp(device), batteryKnown(r.case_id));
    db()
      .prepare(
        `UPDATE test_sessions SET install_id = ?, ticket_hash = ?, device = ?, plan = ?, status = CASE WHEN status IN ('waiting','opened') THEN 'joined' ELSE status END,
           joined_at = COALESCE(joined_at, ?), opened_at = COALESCE(opened_at, ?), expires_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(installId, sha(ticket), JSON.stringify(device), JSON.stringify(plan), now, now, firstJoin ? new Date(Date.now() + JOINED_TTL_MS).toISOString() : r.expires_at, now, r.id);
    audit({ orgId: r.org_id, storeId: r.store_id, action: firstJoin ? "test_session.join" : "test_session.rejoin", entity: "test_session", entityId: r.id, detail: { model: device.modelName, ip } });
    const v = view(rowById(r.id)!);
    const refs = tradeModelRefs();
    const match = caseModelForJoin(v.summary?.model ?? matchModel(device, refs), r.case_id, refs, storageVariant(device.totalDiskBytes));
    return {
      ticket,
      session: {
        id: v.id,
        caseRef: v.caseRef,
        storeName: v.storeName,
        plan: v.plan,
        server: publicBase(origin),
        status: v.status,
        results: v.results,
        declared: v.declared,
        // The Identify card: SwapUp's model match on the phone's own model code — never a price.
        // `variants`: that model's sizes, so the confirm card can ask "How much storage?" when the
        // phone couldn't measure it — none when it measured, even a size that isn't on file, and
        // none when the case already settled this model's storage (a browser re-test): Apply
        // would not use the answer, so the customer isn't asked for it.
        identity: identityForJoin(match, refs.find((m) => m.id === match.modelId)?.variants ?? [], storageVariant(device.totalDiskBytes) ?? settledOnCase(r.case_id, match.modelId)),
        // Started from the store's counter code: the phone also asks for the customer's name and number.
        customerStarted: v.customerStarted,
      },
    };
  });
}

/**
 * The model the join tells the phone (owner, 2026-10-19: "IMEI first"). The case's own model when its
 * IMEI named it — so an iPhone or a browser (which can't name themselves) skips the customer's picker —
 * reported as a match; Apply then settles that model's storage from the phone's reading
 * (storageModelId, caseModelJoined). The phone's own code still wins when it matched the same model;
 * a code naming another model is shown the IMEI's, and Apply flags it. Any other case — no IMEI, or a
 * model staff, the phone or the customer named — joins exactly as 0.8.0: the phone's own answer.
 */
function caseModelForJoin(phone: ModelMatch, caseId: string, refs: TradeModelRef[], measured: string | null): ModelMatch {
  const row = db().prepare(`SELECT model_id, variant, model_source FROM cases WHERE id = ?`).get(caseId) as
    | { model_id: string | null; variant: string | null; model_source: string | null }
    | undefined;
  if (!row?.model_id || row.model_source !== "imei") return phone;
  if (phone.modelId === row.model_id) return phone;
  const m = refs.find((x) => x.id === row.model_id);
  if (!m) return phone;
  const size = measured ?? row.variant;
  const variant = size && m.variants.includes(size) ? size : null;
  return { modelId: m.id, label: `${m.brand} ${m.model}`, variant, match: "exact", why: `The store has this phone as the ${m.model} (from its IMEI).` };
}

/**
 * The case already has a battery-health % from somewhere other than the customer's screenshot:
 * the Phonecheck report attached to it (the one its grade reads). Then the phone isn't asked.
 */
function batteryKnown(caseId: string): boolean {
  const row = db()
    .prepare(`SELECT record FROM phonecheck_records WHERE case_id = ? AND attached_at IS NOT NULL ORDER BY attached_at DESC, received_at DESC LIMIT 1`)
    .get(caseId) as { record: string } | undefined;
  const pct = parseJson<{ batteryHealthPct?: unknown } | null>(row?.record, null)?.batteryHealthPct;
  return typeof pct === "number" && pct > 0 && pct <= 100;
}

/** The session a device ticket belongs to — or 401. */
function byTicket(authorization: string | null): Row {
  const m = /^Ticket\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization || "");
  if (!m) throw new HttpError(401, "Not connected to a store — scan the store's QR again.");
  const r0 = db().prepare(`SELECT * FROM test_sessions WHERE ticket_hash = ?`).get(sha(m[1])) as Row | undefined;
  if (!r0) throw new HttpError(401, "This session ended or moved — scan the store's QR again.");
  const r = expireIfDue(r0);
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(401, "This session has ended — ask the store for a new code.");
  return r;
}

/**
 * POST /api/device/declare — the damage answers (browser), and since 0.6.0 the
 * Identify step: IMEI 1 + 2, "that's my phone" or the customer's own pick, and
 * a counter-code customer's name and number. Each POST replaces the whole
 * declaration. A pick must be a model (and storage) on SwapUp's own list; it is
 * stored with its name so the store can read it, and stays a claim.
 */
export function deviceDeclare(authorization: string | null, raw: unknown) {
  const r = byTicket(authorization);
  const d = readDeclared(raw);
  if (!d.ok) throw new HttpError(400, d.reason);
  const picked = d.declared.picked;
  if (picked) {
    const tm = tradeModelRefs().find((m) => m.id === picked.modelId);
    if (!tm) throw new HttpError(400, "Choose your phone from the list.");
    if (picked.variant && !tm.variants.includes(picked.variant)) throw new HttpError(400, "Choose your phone's storage from the list.");
    d.declared.picked = { ...picked, label: `${tm.brand} ${tm.model}` };
  }
  db().prepare(`UPDATE test_sessions SET declared = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(d.declared), nowIso(), r.id);
  scheduleSync(r.id); // a declared IMEI rides along with the device report
  return { ok: true as const };
}

/** POST /api/device/phase { phase } — where SwapUp Check ≥ 0.6.0 is: identify, scan, battery, test, done. For the store's screen only. */
export function devicePhase(authorization: string | null, raw: { phase?: unknown }) {
  const r = byTicket(authorization);
  const phase = readPhase(raw?.phase);
  if (!phase) throw new HttpError(400, "Say which step the phone is on: identify, scan, battery, test, done or colours.");
  const now = nowIso();
  db().prepare(`UPDATE test_sessions SET phone_phase = ?, phone_phase_at = ?, updated_at = ? WHERE id = ?`).run(phase, now, now, r.id);
  return { ok: true as const };
}

/** Sessions whose camera link has gone to the customer's phone since this server started (audited once each). */
const linkAudited = new Set<string>();

/**
 * GET /api/device/camera-link → { url } — GradeIQ's camera link for the Scan
 * screen's QR (SwapUp Check ≥ 0.6.0, GradeIQ v2's way). 409 until GradeIQ has a
 * session for this check; the phone asks again. Audited, because it is the one
 * place a GradeIQ id leaves for the customer's phone.
 */
export function deviceCameraLinkGet(authorization: string | null): { url: string } {
  const r = byTicket(authorization);
  const out = deviceCameraLink(r);
  if (!out.ok)
    throw new HttpError(409, out.why === "pending" ? "The camera check isn't ready yet." : "No camera check — carry on with the tests.");
  if (!linkAudited.has(r.id)) {
    linkAudited.add(r.id);
    audit({ orgId: r.org_id, storeId: r.store_id, action: "test_session.camera_link", entity: "test_session", entityId: r.id, detail: { to: "customer's phone" } });
  }
  return { url: out.url };
}

/**
 * GET /api/device/models[?brand=] — the picker on the customer's phone, for a
 * model SwapUp could not recognise from its code: the brands, then that brand's
 * models (newest first) and storage sizes. SwapUp's own model list, no prices.
 */
export function deviceModels(authorization: string | null, brand: string | null): { brands: string[] } | { models: { id: string; brand: string; model: string; variants: string[] }[] } {
  byTicket(authorization);
  const b = (brand ?? "").trim();
  if (!b) {
    const rows = db().prepare(`SELECT brand, COUNT(*) AS n FROM trade_models GROUP BY brand ORDER BY n DESC, brand`).all() as { brand: string }[];
    return { brands: rows.map((x) => x.brand) };
  }
  const rows = db()
    .prepare(`SELECT id, brand, model, variants FROM trade_models WHERE brand = ? COLLATE NOCASE ORDER BY COALESCE(release_year, 0) DESC, model`)
    .all(b.slice(0, 40)) as { id: string; brand: string; model: string; variants: string }[];
  return { models: rows.map((x) => ({ id: x.id, brand: x.brand, model: x.model, variants: parseJson<string[]>(x.variants, []) })) };
}

/** A screenshot as a data URL, at most this long (≈ 2.2 MB of image). */
const MAX_SCREENSHOT_CHARS = 3 * 1024 * 1024;
const SCREENSHOT_RE = /^data:image\/(png|jpe?g|webp|heic|heif);base64,[A-Za-z0-9+/]+={0,2}$/i;

/**
 * POST /api/device/battery { image } — the customer's screenshot of their
 * battery-health screen. GradeIQ reads the % (call 7, its /ocr); the server
 * records battery_health itself: pass at 80 % and up, fail below (the
 * battery_drain fault, which prices), skip when nothing legible came back. The
 * phone never chooses the outcome. → { healthPct | null, outcome }.
 */
/**
 * Each read is a paid vision call and a screenshot kept by GradeIQ — so a few per
 * check, not a stream: at most BATTERY_READS_PER_SESSION, BATTERY_READ_GAP_MS apart.
 */
const BATTERY_READS_PER_SESSION = 5;
const BATTERY_READ_GAP_MS = 8_000;
const batteryReads = new Map<string, number[]>();

export async function deviceBattery(
  authorization: string | null,
  raw: { image?: unknown }
): Promise<{ healthPct: number | null; outcome: "pass" | "fail" | "skip"; recorded: { healthPct: number | null; outcome: string } | null }> {
  const r = byTicket(authorization);
  const reads = batteryReads.get(r.id) ?? [];
  if (reads.length >= BATTERY_READS_PER_SESSION) throw new HttpError(429, "No more tries — skip; the advisor checks the battery.");
  if (reads.length && Date.now() - reads[reads.length - 1] < BATTERY_READ_GAP_MS) throw new HttpError(429, "One moment — the last screenshot is still being read.");
  const image = typeof raw?.image === "string" ? raw.image.trim() : "";
  if (image.length > MAX_SCREENSHOT_CHARS) throw new HttpError(413, "Screenshot too big — crop it to the battery screen.");
  if (!SCREENSHOT_RE.test(image)) throw new HttpError(400, "Choose a screenshot of the battery health screen.");
  if (gradeiqConfig().enabled && r.gradeiq_state === "pending") throw new HttpError(409, "Battery reader starting — try again, or skip.");
  if (!gradeiqConfig().enabled || r.gradeiq_state !== "ready" || !r.gradeiq_id)
    throw new HttpError(409, "Battery reader isn't available — skip; the advisor checks it.");
  batteryReads.set(r.id, [...reads, Date.now()]);
  let pct: number | null;
  try {
    // Outside any transaction: one vision call, up to GRADEIQ_OCR_TIMEOUT_MS.
    pct = await readBatteryHealth(r.gradeiq_id, image);
  } catch (e) {
    // The reader itself is off (its AI service refused the call — e.g. out of credit): not the
    // customer's screenshot. The phone moves on and the advisor checks the battery instead.
    if (e instanceof GradeiqError && e.kind === "reader_off")
      throw new HttpError(409, "Battery reader isn't available — skip; the advisor checks it.");
    if (e instanceof GradeiqError) throw new HttpError(503, "Couldn't read the screenshot — try again, or skip.");
    throw e;
  }
  const result = batteryHealthResult(pct, nowIso());
  let recorded: { healthPct: number | null; outcome: string } | null = null;
  tx(() => {
    // The ticket may have ended during the read (cancelled, applied): writes stop with it.
    const fresh = byTicket(authorization);
    const results = parseJson<TestResults>(fresh.results, {});
    // An unreadable screenshot never wipes an earlier reading; a new reading keeps the old figures.
    const next = nextBatteryHealth(results[BATTERY_HEALTH_ID], result);
    const kept = next ?? results[BATTERY_HEALTH_ID] ?? null;
    if (kept) recorded = { healthPct: typeof kept.detail?.healthPct === "number" ? (kept.detail.healthPct as number) : null, outcome: kept.outcome };
    if (!next) return;
    const merged = mergeResults(results, [{ testId: BATTERY_HEALTH_ID, outcome: next.outcome, detail: next.detail, at: next.at }]);
    const status: SessionStatus = fresh.status === "joined" ? "testing" : fresh.status;
    db().prepare(`UPDATE test_sessions SET results = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), status, result.at, fresh.id);
  });
  // What THIS screenshot said, and what is RECORDED for the check (an unreadable
  // screenshot keeps an earlier reading) — the app shows the recorded one.
  return { healthPct: result.outcome === "skip" ? null : (result.detail?.healthPct as number), outcome: result.outcome as "pass" | "fail" | "skip", recorded };
}

export function deviceResults(authorization: string | null, raw: { results?: unknown }) {
  const out = resultsTx(authorization, raw);
  // After the batch commits: forward the FULL map to GradeIQ, one request at a time per session.
  scheduleSync(out.sessionId);
  const { sessionId: _id, ...reply } = out;
  return reply;
}

function resultsTx(authorization: string | null, raw: { results?: unknown }) {
  return tx(() => {
    const r = byTicket(authorization);
    const plan = parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]);
    const now = nowIso();
    const read = readResults(raw?.results, plan, now);
    const existing = parseJson<TestResults>(r.results, {});
    // battery_health is the server's reading; the phone may only report a skip (phoneMayPost).
    // In a browser, a fail that is only the customer's own yes/no is not a measurement: a skip,
    // as the native app's measured verdict would be (browserVerdict) — same phone, same answer.
    const device = parseJson<DeviceReport | null>(r.device, null);
    const items = read.items.filter((it) => phoneMayPost(it.testId, it.outcome, existing)).map((it) => browserVerdict(it, device));
    const ignored = [...read.ignored, ...read.items.filter((it) => !items.includes(it)).map((it) => it.testId)];
    const merged = mergeResults(existing, items);
    const status: SessionStatus = r.status === "joined" && items.length ? "testing" : r.status;
    db().prepare(`UPDATE test_sessions SET results = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), status, now, r.id);
    return { ok: true as const, received: items.length, ignored, progress: progressOf(plan, merged), sessionId: r.id };
  });
}

export function deviceComplete(authorization: string | null) {
  const r = byTicket(authorization);
  const now = nowIso();
  db().prepare(`UPDATE test_sessions SET status = 'complete', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`).run(now, now, r.id);
  // The phone has finished: if the camera grade is in too, the answer is ready without a tap.
  void autoApply(r.id);
  return { ok: true as const, summary: view(rowById(r.id)!).summary };
}

export function deviceStatus(authorization: string | null) {
  // A session the store has applied is still reported (the app shows "the store has your results").
  const m = /^Ticket\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization || "");
  if (!m) throw new HttpError(401, "This phone is not connected to a store session.");
  const r0 = db().prepare(`SELECT * FROM test_sessions WHERE ticket_hash = ?`).get(sha(m[1])) as Row | undefined;
  // Cancelled, expired or re-joined elsewhere: the ticket is gone, so the session is closed for this phone.
  if (!r0) return { status: "closed" as const, progress: null, storeName: null, caseRef: null, reportPath: null, grading: null, colours: false, answer: null };
  const r = expireIfDue(r0);
  // The phone asks every few seconds once it has finished: the results go on the case as soon as
  // everything is in, whether or not anyone has the Session screen open (autoApply).
  if (r.status === "complete") void autoApply(r.id);
  const v = view(r);
  // Once applied, the customer's own link to the phone's grading report (public, no money in it),
  // and the grade that page opens on — the SwapUp grade with its letter ("Good (B)"), no reasons, no price.
  const applied = v.status === "applied";
  // The tests are done and the advisor still has to certify the screen: show the test colours
  // full-screen on the result screen until they tap it (or Apply). The customer taps nothing.
  const phase = readPhase(r.phone_phase);
  const colours = !applied && (phase === "done" || phase === "colours") && certifyFor(r, cameraEvidence(r)).coloursWanted;
  return {
    status: v.status,
    progress: v.progress,
    storeName: v.storeName,
    caseRef: v.caseRef,
    reportPath: applied ? reportPathFor(r0.case_id) : null,
    grading: applied ? customerGradingFor(r0.case_id) : null,
    colours,
    // Once applied, the answer — the server's lines, the customer's whitelist slice (owner, 2026-10-18:
    // the answer on the customer's phone too). Read only: never a re-price or a partner call.
    answer: applied ? deviceAnswer(r0.case_id) : null,
  };
}

/* ─────────────────────────── the photo check (customer's phone) ─────────────────────────── */

/**
 * GET /api/device/screen — which pattern the store's camera wants this phone to
 * show. Proxied from GradeIQ; the GradeIQ id never reaches the phone.
 * state: disabled / failed → skip the photo check and run the tests;
 * pending → wait; ready → show `pattern` full-screen and echo it back.
 */
export async function deviceScreenGet(authorization: string | null): Promise<DeviceScreen> {
  const r = byTicket(authorization);
  try {
    return await deviceScreen(r);
  } catch (e) {
    if (e instanceof DeviceScreenUnavailable) throw new HttpError(503, "Can't reach the photo check — keep this screen open.");
    throw e;
  }
}

const PATTERN_RE = /^[a-z0-9-]{1,20}$/;

/** POST /api/device/screen { shown } — the pattern this phone is actually showing. */
export async function deviceScreenPost(authorization: string | null, raw: { shown?: unknown }) {
  const r = byTicket(authorization);
  const shown = typeof raw?.shown === "string" ? raw.shown.trim().toLowerCase() : "";
  if (!PATTERN_RE.test(shown)) throw new HttpError(400, "Say which pattern the screen is showing.");
  try {
    await deviceScreenShown(r, shown);
  } catch (e) {
    if (e instanceof GradeiqError) throw new HttpError(e.kind === "disabled" ? 409 : 503, e.kind === "disabled" ? "No photo check for this session." : "Can't reach the photo check — keep this screen open.");
    throw e;
  }
  return { ok: true as const };
}

export { getOrg };
