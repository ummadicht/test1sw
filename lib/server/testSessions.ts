import { createHash, randomBytes, randomInt } from "node:crypto";
import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { getStore, getOrg, canSeeStore, ownStore, storeInScope, type StoreRow } from "./scope";
import { createCase, getCase, updateCase, recordCameraCheck, markLcdOverride } from "./cases";
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
} from "./gradeiqBridge";
import { GradeiqError } from "./gradeiq";
import { applyCameraFloor, addFaultSources, blankCameraCheck, resultsWithCameraDisplay, type CaseCameraCheck } from "../domain/gradeiqMap";
import {
  DEFAULT_PLAN,
  CODE_ALPHABET,
  normaliseCode,
  readDevice,
  readResults,
  mergeResults,
  mergeCondition,
  readDeclared,
  summarise,
  progressOf,
  unionFaults,
  readWifi,
  wifiQr,
  type PlanItem,
  type TestResults,
  type Declared,
  type DeviceReport,
  type DiagnosticSummary,
  type TradeModelRef,
  type StoreWifi,
} from "../domain/diagnostics";

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
 * reach staff only — never the customer's phone, the QR or a public page.
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
};

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

/** `staff`: include the grading block (camera URL, GradeIQ result). Never for a device response. */
function view(r: Row, opts: { staff?: boolean } = {}): TestSessionView {
  const plan = parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]);
  const results = parseJson<TestResults>(r.results, {});
  const device = parseJson<DeviceReport | null>(r.device, null);
  const declared = parseJson<Declared | null>(r.declared, null);
  const c = db().prepare(`SELECT ref FROM cases WHERE id = ?`).get(r.case_id) as { ref: string } | undefined;
  const store = getStore(r.store_id);
  const hasAnything = !!device || Object.keys(results).length > 0 || !!declared;
  // The store camera's LCD sweep is the native run's display test — fold it in
  // so a fully tested phone isn't reported "incomplete".
  const effective = resultsWithCameraDisplay(results, cameraEvidence(r).mapping.lcd, r.updated_at);
  const nativeApp = !!device?.appVersion && !device.appVersion.startsWith("web-");
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
    summary: hasAnything ? summarise(plan, effective, declared, device, tradeModelRefs(), { declaredExpected: !nativeApp }) : null,
    grading: opts.staff ? gradingView(r) : null,
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

function freshCode(): string {
  for (let i = 0; i < 20; i++) {
    let code = "";
    for (let k = 0; k < 6; k++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const clash = db()
      .prepare(`SELECT 1 FROM test_sessions WHERE code = ? AND status IN ('waiting','opened','joined','testing','complete') AND expires_at > ?`)
      .get(code, nowIso());
    if (!clash) return code;
  }
  throw new HttpError(503, "Could not make a fresh code — try again.");
}

/* ─────────────────────────── staff side ─────────────────────────── */

export function createTestSession(u: SessionUser, input: { caseId?: string | null; customerName?: string; customerPhone?: string }, origin?: string | null) {
  requireCounter(u);
  const store = ownStore(u);
  let caseId = input.caseId || null;
  if (caseId) {
    const c = getCase(u, caseId); // scope check
    if (!["draft", "quoted"].includes(c.status)) throw new HttpError(409, "That case is past the counter — start a new one for this customer.");
  } else {
    caseId = createCase(u, { customerName: input.customerName, customerPhone: input.customerPhone }).id;
  }
  const now = nowIso();
  const id = newId("ts");
  const code = freshCode();
  db()
    .prepare(
      `INSERT INTO test_sessions (id, code, case_id, store_id, org_id, created_by, status, plan, results, created_at, expires_at, updated_at, gradeiq_state)
       VALUES (?,?,?,?,?,?,'waiting',?,'{}',?,?,?,?)`
    )
    .run(id, code, caseId, store.id, store.org_id, u.id, JSON.stringify(DEFAULT_PLAN), now, new Date(Date.now() + UNJOINED_TTL_MS).toISOString(), now, initialGradeiqState());
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "test_session.create", entity: "test_session", entityId: id, detail: { caseId } });
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

export async function applyTestSession(u: SessionUser, id: string) {
  requireCounter(u);
  const { r } = inScope(u, id);
  if (r.status === "applied") throw new HttpError(409, "These results are already on the case.");
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "There are no results to apply yet.");
  if (!view(r).summary) throw new HttpError(409, "There are no results to apply yet.");
  if (!["draft", "quoted"].includes(getCase(u, r.case_id).status)) throw new HttpError(409, "The case is past the counter, so the results can't change it any more.");

  // What the store camera saw (GradeIQ) — one last pull and the DeviceFax
  // snapshot, outside any transaction. Only a FINAL grade's confirmed damage
  // counts; anything weaker stays a flag for the advisor.
  const cam = await evidenceForApply(r.id);
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
  const c = getCase(u, r.case_id);
  if (!["draft", "quoted"].includes(c.status)) throw new HttpError(409, "The case is past the counter, so the results can't change it any more.");

  const patch: Parameters<typeof updateCase>[2] = {};
  if (s.model.modelId) {
    patch.modelId = s.model.modelId;
    if (s.model.variant) patch.variant = s.model.variant;
  }
  const testedFaults = s.faults.map((f) => f.id);
  const cameraFaults = cam.mapping.faults.map((f) => f.id);
  patch.faults = unionFaults(unionFaults(c.faults, testedFaults), cameraFaults);
  // Never better than what the advisor recorded, the faults allow, or the camera confirmed.
  patch.condition = applyCameraFloor(mergeCondition(c.condition, patch.faults as typeof c.faults), cam.mapping.floor);
  if (v.declared?.imei && !c.imei) patch.imei = v.declared.imei;

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
      ...(cam.state !== "ready"
        ? ["Not camera-graded — the condition is the advisor's."]
        : cam.fin.final
          ? []
          : cam.snap?.cosmeticGrade || cam.fin.status === "failed"
            ? cam.fin.reasons
            : ["Not camera-graded — no camera grade came back before Apply. The condition is the advisor's."]),
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

  // updateCase re-prices (partner quote, repair estimate, decision) outside any transaction.
  await updateCase(u, r.case_id, patch);
  // The ticket stays valid for STATUS reads only (byTicket refuses writes once
  // applied), so the customer's phone can show "the store has your results".
  db().prepare(`UPDATE test_sessions SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
  audit({
    userId: u.id,
    orgId: r.org_id,
    storeId: r.store_id,
    action: "test_session.apply",
    entity: "test_session",
    entityId: r.id,
    detail: { faults: patch.faults, model: s.model, camera: { state: cam.state, grade: check.grade, final: check.final, faults: cameraFaults, identity: check.identity.verdict, lcdChecked: check.lcd.cameraChecked } },
  });
  return { session: view(rowById(r.id)!, { staff: true }), caseId: r.case_id };
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
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id) throw new HttpError(409, "Camera grading is not available for this session.");
  const reason = typeof raw?.reason === "string" ? raw.reason.trim().slice(0, 300) : "";
  if (reason.length < 8) throw new HttpError(400, "Say why the camera has to start without the customer's phone showing the patterns.");
  const info = { by: u.name, reason, at: nowIso() };
  recordOverride(r.id, info);
  markLcdOverride(r.case_id, { ...info, userId: u.id, testSessionId: r.id });
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.camera_override", entity: "test_session", entityId: r.id, detail: { reason } });
  return getTestSession(u, r.id, origin);
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

/* ─────────────────────────── the public page ─────────────────────────── */

/** What /j/<code> may show. Marks the session opened; never binds or consumes it. */
export function openByCode(raw: string): { ok: true; code: string; storeName: string; caseRef: string; status: SessionStatus } | { ok: false } {
  const code = normaliseCode(raw);
  if (!code) return { ok: false };
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
  return { ok: true, code, storeName: v.storeName, caseRef: v.caseRef, status: r.status === "waiting" ? "opened" : r.status };
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
  if (cur && cur.until > Date.now() && cur.n >= 20) throw new HttpError(429, "Too many tries. Wait a few minutes, then scan the store's QR again.");
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
    if (e instanceof HttpError && e.status < 500) noteRefusedJoin(ip);
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
  const invalid = new HttpError(404, "That code is not valid any more. Ask the store for a new one.");
  if (!code) throw invalid;
  return tx(() => {
    const r0 = db().prepare(`SELECT * FROM test_sessions WHERE code = ? ORDER BY created_at DESC LIMIT 1`).get(code) as Row | undefined;
    if (!r0) throw invalid;
    const r = expireIfDue(r0);
    if (!["waiting", "opened", "joined", "testing", "complete"].includes(r.status)) throw invalid;
    if (r.install_id && r.install_id !== installId) throw new HttpError(409, "This code is already being used on another phone. Ask the store for a new one.");
    const ticket = randomBytes(32).toString("base64url");
    const now = nowIso();
    const device = readDevice(input.device, input.appVersion);
    const firstJoin = !r.install_id;
    db()
      .prepare(
        `UPDATE test_sessions SET install_id = ?, ticket_hash = ?, device = ?, status = CASE WHEN status IN ('waiting','opened') THEN 'joined' ELSE status END,
           joined_at = COALESCE(joined_at, ?), opened_at = COALESCE(opened_at, ?), expires_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(installId, sha(ticket), JSON.stringify(device), now, now, firstJoin ? new Date(Date.now() + JOINED_TTL_MS).toISOString() : r.expires_at, now, r.id);
    audit({ orgId: r.org_id, storeId: r.store_id, action: firstJoin ? "test_session.join" : "test_session.rejoin", entity: "test_session", entityId: r.id, detail: { model: device.modelName, ip } });
    const v = view(rowById(r.id)!);
    return {
      ticket,
      session: { id: v.id, caseRef: v.caseRef, storeName: v.storeName, plan: v.plan, server: publicBase(origin), status: v.status, results: v.results, declared: v.declared },
    };
  });
}

/** The session a device ticket belongs to — or 401. */
function byTicket(authorization: string | null): Row {
  const m = /^Ticket\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization || "");
  if (!m) throw new HttpError(401, "This phone is not connected to a store session. Scan the store's QR again.");
  const r0 = db().prepare(`SELECT * FROM test_sessions WHERE ticket_hash = ?`).get(sha(m[1])) as Row | undefined;
  if (!r0) throw new HttpError(401, "This test session has ended or moved to another phone. Scan the store's QR again.");
  const r = expireIfDue(r0);
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(401, "This test session has ended. Ask the store for a new code.");
  return r;
}

export function deviceDeclare(authorization: string | null, raw: unknown) {
  const r = byTicket(authorization);
  const d = readDeclared(raw);
  if (!d.ok) throw new HttpError(400, d.reason);
  db().prepare(`UPDATE test_sessions SET declared = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(d.declared), nowIso(), r.id);
  scheduleSync(r.id); // a declared IMEI rides along with the device report
  return { ok: true as const };
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
    const { items, ignored } = readResults(raw?.results, plan, now);
    const merged = mergeResults(parseJson<TestResults>(r.results, {}), items);
    const status: SessionStatus = r.status === "joined" && items.length ? "testing" : r.status;
    db().prepare(`UPDATE test_sessions SET results = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), status, now, r.id);
    return { ok: true as const, received: items.length, ignored, progress: progressOf(plan, merged), sessionId: r.id };
  });
}

export function deviceComplete(authorization: string | null) {
  const r = byTicket(authorization);
  const now = nowIso();
  db().prepare(`UPDATE test_sessions SET status = 'complete', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`).run(now, now, r.id);
  return { ok: true as const, summary: view(rowById(r.id)!).summary };
}

export function deviceStatus(authorization: string | null) {
  // A session the store has applied is still reported (the app shows "the store has your results").
  const m = /^Ticket\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization || "");
  if (!m) throw new HttpError(401, "This phone is not connected to a store session.");
  const r0 = db().prepare(`SELECT * FROM test_sessions WHERE ticket_hash = ?`).get(sha(m[1])) as Row | undefined;
  // Cancelled, expired or re-joined elsewhere: the ticket is gone, so the session is closed for this phone.
  if (!r0) return { status: "closed" as const, progress: null, storeName: null, caseRef: null };
  const v = view(expireIfDue(r0));
  return { status: v.status, progress: v.progress, storeName: v.storeName, caseRef: v.caseRef };
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
    if (e instanceof DeviceScreenUnavailable) throw new HttpError(503, "The photo check can't reach the grading service right now. Keep this screen open — it carries on by itself.");
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
    if (e instanceof GradeiqError) throw new HttpError(e.kind === "disabled" ? 409 : 503, e.kind === "disabled" ? "The photo check is not running for this session." : "The photo check can't reach the grading service right now. Keep this screen open.");
    throw e;
  }
  return { ok: true as const };
}

export { getOrg };
