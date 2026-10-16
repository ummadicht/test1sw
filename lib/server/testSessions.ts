import { createHash, randomBytes, randomInt } from "node:crypto";
import { db, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { getStore, getOrg, canSeeStore, ownStore, storeInScope, type StoreRow } from "./scope";
import { createCase, getCase, updateCase } from "./cases";
import {
  DEFAULT_PLAN,
  CODE_ALPHABET,
  normaliseCode,
  readDevice,
  readResults,
  mergeResults,
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
 */

export type SessionStatus = "waiting" | "opened" | "joined" | "testing" | "complete" | "applied" | "expired" | "cancelled";

const UNJOINED_TTL_MS = 30 * 60_000;
const JOINED_TTL_MS = 2 * 60 * 60_000;
const OPEN_STATUSES: SessionStatus[] = ["waiting", "opened", "joined", "testing", "complete"];

type Row = {
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
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function publicBase(): string {
  return (process.env.SWAPUP_PUBLIC_URL || "http://localhost:4500").replace(/\/$/, "");
}

/** Links for a code. The deep link carries the server so a dev build can point anywhere. */
export function linksFor(code: string, base = publicBase()) {
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

function view(r: Row): TestSessionView {
  const plan = parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]);
  const results = parseJson<TestResults>(r.results, {});
  const device = parseJson<DeviceReport | null>(r.device, null);
  const declared = parseJson<Declared | null>(r.declared, null);
  const c = db().prepare(`SELECT ref FROM cases WHERE id = ?`).get(r.case_id) as { ref: string } | undefined;
  const store = getStore(r.store_id);
  const hasAnything = !!device || Object.keys(results).length > 0 || !!declared;
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
    results,
    declared,
    progress: progressOf(plan, results),
    summary: hasAnything ? summarise(plan, results, declared, device, tradeModelRefs()) : null,
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

export function createTestSession(u: SessionUser, input: { caseId?: string | null; customerName?: string; customerPhone?: string }) {
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
      `INSERT INTO test_sessions (id, code, case_id, store_id, org_id, created_by, status, plan, results, created_at, expires_at, updated_at)
       VALUES (?,?,?,?,?,?,'waiting',?,'{}',?,?,?)`
    )
    .run(id, code, caseId, store.id, store.org_id, u.id, JSON.stringify(DEFAULT_PLAN), now, new Date(Date.now() + UNJOINED_TTL_MS).toISOString(), now);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "test_session.create", entity: "test_session", entityId: id, detail: { caseId } });
  return withLinks(view(rowById(id)!), store);
}

function withLinks(session: TestSessionView, store: StoreRow) {
  const wifi = storeWifi(store);
  return { session, ...linksFor(session.code), wifi: wifi ? { ssid: wifi.ssid, qr: wifiQr(wifi) } : null };
}

export function getTestSession(u: SessionUser, id: string) {
  const { r, store } = inScope(u, id);
  return withLinks(view(r), store);
}

export function listOpenSessions(u: SessionUser): TestSessionView[] {
  requireCounter(u);
  const store = ownStore(u);
  const rows = db()
    .prepare(`SELECT * FROM test_sessions WHERE store_id = ? AND status IN ('waiting','opened','joined','testing','complete') ORDER BY created_at DESC LIMIT 50`)
    .all(store.id) as Row[];
  return rows.map(expireIfDue).filter((r) => r.status !== "expired").map(view);
}

export async function applyTestSession(u: SessionUser, id: string) {
  requireCounter(u);
  const { r } = inScope(u, id);
  if (r.status === "applied") throw new HttpError(409, "These results are already on the case.");
  if (!["joined", "testing", "complete"].includes(r.status)) throw new HttpError(409, "There are no results to apply yet.");
  const v = view(r);
  const s = v.summary;
  if (!s) throw new HttpError(409, "There are no results to apply yet.");
  const c = getCase(u, r.case_id);
  if (!["draft", "quoted"].includes(c.status)) throw new HttpError(409, "The case is past the counter, so the results can't change it any more.");

  const patch: Parameters<typeof updateCase>[2] = {};
  if (s.model.modelId) {
    patch.modelId = s.model.modelId;
    if (s.model.variant) patch.variant = s.model.variant;
  }
  patch.faults = unionFaults(c.faults, s.faults.map((f) => f.id));
  patch.conditionFromFaults = true;
  if (v.declared?.imei && !c.imei) patch.imei = v.declared.imei;
  // updateCase re-prices (partner quote, repair estimate, decision) outside any transaction.
  await updateCase(u, r.case_id, patch);
  const now = nowIso();
  // The ticket stays valid for STATUS reads only (byTicket refuses writes once
  // applied), so the customer's phone can show "the store has your results".
  db().prepare(`UPDATE test_sessions SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.apply", entity: "test_session", entityId: r.id, detail: { faults: patch.faults, model: s.model } });
  return { session: view(rowById(r.id)!), caseId: r.case_id };
}

export function cancelTestSession(u: SessionUser, id: string) {
  requireCounter(u);
  const { r, store } = inScope(u, id);
  if (["applied", "cancelled"].includes(r.status)) throw new HttpError(409, "This session is already closed.");
  db().prepare(`UPDATE test_sessions SET status = 'cancelled', ticket_hash = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), r.id);
  audit({ userId: u.id, orgId: r.org_id, storeId: r.store_id, action: "test_session.cancel", entity: "test_session", entityId: r.id });
  return withLinks(view(rowById(r.id)!), store);
}

/** A new code for the SAME case — the old one stops working. Results so far are kept only if joined. */
export function reissueTestSession(u: SessionUser, id: string) {
  requireCounter(u);
  const { r } = inScope(u, id);
  if (r.status === "applied") throw new HttpError(409, "These results are already on the case.");
  return tx(() => {
    db().prepare(`UPDATE test_sessions SET status = 'cancelled', ticket_hash = NULL, updated_at = ? WHERE id = ? AND status != 'applied'`).run(nowIso(), r.id);
    return createTestSession(u, { caseId: r.case_id });
  });
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

function rateLimit(ip: string): void {
  const now = Date.now();
  const cur = joinAttempts.get(ip);
  if (cur && cur.until > now) {
    if (cur.n >= 20) throw new HttpError(429, "Too many tries. Wait a few minutes, then scan the store's QR again.");
    cur.n += 1;
  } else joinAttempts.set(ip, { n: 1, until: now + 10 * 60_000 });
}

export function joinByCode(input: { code?: unknown; device?: unknown; appVersion?: unknown; installId?: unknown }, ip: string) {
  rateLimit(ip);
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
      session: { id: v.id, caseRef: v.caseRef, storeName: v.storeName, plan: v.plan, server: publicBase(), status: v.status, results: v.results, declared: v.declared },
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
  return { ok: true as const };
}

export function deviceResults(authorization: string | null, raw: { results?: unknown }) {
  return tx(() => {
    const r = byTicket(authorization);
    const plan = parseJson<PlanItem[]>(r.plan, [...DEFAULT_PLAN]);
    const now = nowIso();
    const { items, ignored } = readResults(raw?.results, plan, now);
    const merged = mergeResults(parseJson<TestResults>(r.results, {}), items);
    const status: SessionStatus = r.status === "joined" && items.length ? "testing" : r.status;
    db().prepare(`UPDATE test_sessions SET results = ?, status = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), status, now, r.id);
    return { ok: true as const, received: items.length, ignored, progress: progressOf(plan, merged) };
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

export { getOrg };
