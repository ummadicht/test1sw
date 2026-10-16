import { createHash } from "node:crypto";
import { db, nowIso, parseJson, audit } from "./db";
import * as giq from "./gradeiq";
import { GradeiqError } from "./gradeiq";
import { matchModel, type DeviceReport, type Declared, type TestResults, type TradeModelRef } from "../domain/diagnostics";
import {
  finality,
  mapCamera,
  assessmentView,
  disagreements,
  gradeiqFunctionalMap,
  type GiqScreen,
  type GradeiqSnapshot,
  type Finality,
  type CameraMapping,
  type AssessmentView,
  type Disagreement,
  type CameraOverrideInfo,
} from "../domain/gradeiqMap";

/**
 * THE GRADEIQ BRIDGE — every SwapUp Check session has a GradeIQ session behind
 * it, kept in step in the background so the counter never waits on GradeIQ.
 *
 *   create   after the test session commits; one create in flight per session;
 *            a failure retries with backoff, then waits for staff to press Retry.
 *   forward  per session, ONE request at a time, outside any transaction: the
 *            device report (call 2) and the FULL mapped functional map (call 3,
 *            merge:true). A body is sent only when it differs from the last one
 *            GradeIQ acknowledged (hash), so retries are idempotent and a lost
 *            forward heals itself. Failures retry with backoff and show staff
 *            "GradeIQ out of sync".
 *   pull     only while a staff client is watching (lazy on GET): /screen at
 *            most every 2 s; the whole session every 5 s once the photos are
 *            accepted, for at most 180 s — then the last snapshot is kept.
 *   abandon  cancel / reissue stop all calls; the old id is recorded.
 *
 * Nothing here invents a grade: no GradeIQ session, no reachable GradeIQ, no
 * final grade — each means "not camera-graded", shown as such.
 */

export type GradeiqState = "disabled" | "pending" | "ready" | "failed";

const SYNC_STATUSES = ["joined", "testing", "complete"];
const SCREEN_EVERY_MS = 2_000;
const DEVICE_SCREEN_EVERY_MS = 500;
const PULL_EVERY_MS = 5_000;
const PULL_WINDOW_MS = 180_000;
const MAX_AUTO_CREATES = 3;

/** The columns the bridge reads — a slice of the test_sessions row. */
export type GiqRow = {
  id: string;
  case_id: string;
  org_id: string;
  store_id: string;
  status: string;
  device: string | null;
  declared: string | null;
  results: string;
  gradeiq_id: string | null;
  gradeiq_state: GradeiqState;
  gradeiq_error: string | null;
  gradeiq_snapshot: string | null;
  gradeiq_synced_at: string | null;
  gradeiq_forwarded_at: string | null;
  gradeiq_attempts: number;
  gradeiq_orphans: string;
  gradeiq_screen: string | null;
  gradeiq_screen_at: string | null;
  gradeiq_cosmetic_done_at: string | null;
  gradeiq_device_hash: string | null;
  gradeiq_forward_hash: string | null;
  gradeiq_sync_error: string | null;
  gradeiq_override: string | null;
  gradeiq_devicefax: string | null;
};

/** What the last /screen read and the last session pull said (gradeiq_screen). */
type Live = {
  screen: GiqScreen | null;
  screenError: string | null;
  handoffAt: string | null;
  pullError: string | null;
};

type Mem = {
  creating: Map<string, Promise<void>>;
  createTimers: Map<string, ReturnType<typeof setTimeout>>;
  sync: Map<string, { running: boolean; again: boolean; timer: ReturnType<typeof setTimeout> | null; failures: number }>;
  screen: Map<string, { at: number; promise: Promise<void> | null }>;
  pulling: Map<string, Promise<void>>;
};
const g = globalThis as typeof globalThis & { __swapup_giq?: Mem };
const mem: Mem = (g.__swapup_giq ??= { creating: new Map(), createTimers: new Map(), sync: new Map(), screen: new Map(), pulling: new Map() });

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
const message = (e: unknown) => (e instanceof GradeiqError ? e.message : `GradeIQ call failed (${(e as Error)?.message || String(e)}).`);

function row(id: string): GiqRow | null {
  return (db().prepare(`SELECT * FROM test_sessions WHERE id = ?`).get(id) as GiqRow | undefined) ?? null;
}

function live(r: Pick<GiqRow, "gradeiq_screen">): Live {
  return { screen: null, screenError: null, handoffAt: null, pullError: null, ...parseJson<Partial<Live>>(r.gradeiq_screen, {}) };
}

function saveLive(id: string, next: Live, at: string): void {
  db().prepare(`UPDATE test_sessions SET gradeiq_screen = ?, gradeiq_screen_at = ? WHERE id = ?`).run(JSON.stringify(next), at, id);
}

function addOrphan(id: string, gradeiqId: string | null, why: string): void {
  const r = row(id);
  if (!r) return;
  const list = parseJson<{ id: string | null; why: string; at: string }[]>(r.gradeiq_orphans, []);
  list.push({ id: gradeiqId, why, at: nowIso() });
  db().prepare(`UPDATE test_sessions SET gradeiq_orphans = ? WHERE id = ?`).run(JSON.stringify(list.slice(-20)), id);
}

/** The state a brand-new test session starts in. */
export function initialGradeiqState(): GradeiqState {
  return giq.gradeiqConfig().enabled ? "pending" : "disabled";
}

/* ─────────────────────────── create (call 1) ─────────────────────────── */

function caseModelLabel(caseId: string): string | null {
  const r = db()
    .prepare(`SELECT t.brand, t.model FROM cases c JOIN trade_models t ON t.id = c.model_id WHERE c.id = ?`)
    .get(caseId) as { brand: string; model: string } | undefined;
  return r ? `${r.brand} ${r.model}` : null;
}

/** Start the GradeIQ create AFTER the caller's transaction has committed (better-sqlite3 transactions are synchronous). */
export function kickCreate(id: string): void {
  if (!giq.gradeiqConfig().enabled) return;
  setImmediate(() => void ensureCreated(id));
}

function ensureCreated(id: string): Promise<void> {
  const inflight = mem.creating.get(id);
  if (inflight) return inflight;
  const p = createOnce(id).finally(() => mem.creating.delete(id));
  mem.creating.set(id, p);
  return p;
}

async function createOnce(id: string): Promise<void> {
  const r = row(id);
  if (!r || r.gradeiq_id || r.gradeiq_state !== "pending") return;
  if (!["waiting", "opened", ...SYNC_STATUSES].includes(r.status)) return;
  const attempt = r.gradeiq_attempts + 1;
  db().prepare(`UPDATE test_sessions SET gradeiq_attempts = ? WHERE id = ?`).run(attempt, id);
  try {
    const created = await giq.createSession({ model: caseModelLabel(r.case_id) });
    const now = nowIso();
    const upd = db()
      .prepare(
        `UPDATE test_sessions SET gradeiq_id = ?, gradeiq_state = 'ready', gradeiq_error = NULL, updated_at = ?
         WHERE id = ? AND gradeiq_id IS NULL AND gradeiq_state = 'pending' AND status IN ('waiting','opened','joined','testing','complete')`
      )
      .run(created.id, now, id);
    if (upd.changes !== 1) {
      addOrphan(id, created.id, "the test session closed before GradeIQ answered");
      return;
    }
    audit({ orgId: r.org_id, storeId: r.store_id, action: "test_session.gradeiq_create", entity: "test_session", entityId: id, detail: { gradeiqId: created.id, client: created.client, attempt } });
    scheduleSync(id);
  } catch (e) {
    const ge = e instanceof GradeiqError ? e : new GradeiqError("network", message(e));
    // A timed-out create may still have made a session SwapUp never learned the id of.
    if (ge.ambiguous) addOrphan(id, null, `create timed out on attempt ${attempt} — GradeIQ may hold a session SwapUp never learned`);
    const giveUp = ge.kind === "tenant" || ge.kind === "disabled" || attempt >= MAX_AUTO_CREATES;
    db()
      .prepare(`UPDATE test_sessions SET gradeiq_state = ?, gradeiq_error = ?, updated_at = ? WHERE id = ? AND gradeiq_id IS NULL`)
      .run(giveUp ? "failed" : "pending", giveUp ? ge.message : `${ge.message} Retrying.`, nowIso(), id);
    if (ge.kind === "tenant") {
      console.error(`[swapup] GradeIQ tenant mismatch: ${ge.message}`);
      audit({ orgId: r.org_id, storeId: r.store_id, action: "gradeiq.tenant_mismatch", entity: "test_session", entityId: id, detail: { error: ge.message } });
    }
    if (!giveUp) {
      const t = setTimeout(() => {
        mem.createTimers.delete(id);
        void ensureCreated(id);
      }, attempt === 1 ? 5_000 : 20_000);
      mem.createTimers.set(id, t);
    }
  }
}

/** Staff pressed Retry: a fresh create (counts restart). Also creates one for a session that started while grading was off. */
export function retryCreate(id: string): void {
  if (!giq.gradeiqConfig().enabled) throw new GradeiqError("disabled", "Camera grading is switched off (GRADEIQ_ENABLED=0).");
  db()
    .prepare(`UPDATE test_sessions SET gradeiq_state = 'pending', gradeiq_error = NULL, gradeiq_attempts = 0, updated_at = ? WHERE id = ? AND gradeiq_id IS NULL AND gradeiq_state IN ('failed','disabled','pending')`)
    .run(nowIso(), id);
  const t = mem.createTimers.get(id);
  if (t) clearTimeout(t);
  mem.createTimers.delete(id);
  void ensureCreated(id);
}

/** Cancel / reissue: stop every call for this session and record the GradeIQ id it leaves behind. */
export function abandon(id: string, why: string): void {
  const r = row(id);
  const t = mem.createTimers.get(id);
  if (t) clearTimeout(t);
  mem.createTimers.delete(id);
  const s = mem.sync.get(id);
  if (s?.timer) clearTimeout(s.timer);
  mem.sync.delete(id);
  mem.screen.delete(id);
  if (r?.gradeiq_id) addOrphan(id, r.gradeiq_id, `abandoned: ${why}`);
}

/* ─────────────────────────── forward (calls 2 + 3) ─────────────────────────── */

function tradeModelRefs(): TradeModelRef[] {
  return (db().prepare(`SELECT id, brand, model, variants, model_codes FROM trade_models`).all() as { id: string; brand: string; model: string; variants: string; model_codes: string }[]).map((r) => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    variants: parseJson<string[]>(r.variants, []),
    modelCodes: parseJson<string[]>(r.model_codes, []),
  }));
}

const STORAGE_GB: Record<string, number> = { "16GB": 16, "32GB": 32, "64GB": 64, "128GB": 128, "256GB": 256, "512GB": 512, "1TB": 1024 };

/**
 * Call 2's body. The SwapUp model label and storage go only on an EXACT model
 * code match — GradeIQ keeps the first model it is given. The declared IMEI
 * rides along; GradeIQ's /device route runs no lookup on it.
 */
export function deviceForward(r: Pick<GiqRow, "device" | "declared">, models: TradeModelRef[] = tradeModelRefs()): giq.DeviceForward | null {
  const device = parseJson<DeviceReport | null>(r.device, null);
  const declared = parseJson<Declared | null>(r.declared, null);
  if (!device && !declared?.imei) return null;
  const match = matchModel(device, models);
  const d: giq.DeviceForward["device"] = { source: "swapup-check" };
  const brand = device?.manufacturer || device?.brand;
  if (brand) d.brand = brand;
  if (device?.modelName) d.model = device.modelName;
  if (device?.osVersion) {
    const apple = /apple|iphone|ipad|ios/i.test(`${brand ?? ""} ${device.modelName ?? ""}`);
    d.os = `${apple ? "iOS" : "Android"} ${device.osVersion}`;
  }
  if (match.match === "exact" && match.variant && STORAGE_GB[match.variant]) d.storageGB = STORAGE_GB[match.variant];
  if (declared?.imei) d.imei = declared.imei;
  const body: giq.DeviceForward = { device: d };
  if (match.match === "exact" && match.label) body.model = match.label;
  return body;
}

/** The functional map as it would be sent now (display = worse of self-test and the camera sweep). */
function functionalNow(r: Pick<GiqRow, "results" | "gradeiq_snapshot">): Record<string, "pass" | "fail" | "skip"> | null {
  const results = parseJson<TestResults>(r.results, {});
  if (!Object.keys(results).length) return null;
  const snap = parseJson<GradeiqSnapshot | null>(r.gradeiq_snapshot, null);
  return gradeiqFunctionalMap(results, snap?.displayCheck?.verdict ?? null);
}

/** Queue a forward for this session. Coalesces: a request already running is followed by exactly one more. */
export function scheduleSync(id: string, delayMs = 0): void {
  if (!giq.gradeiqConfig().enabled) return;
  let st = mem.sync.get(id);
  if (!st) {
    st = { running: false, again: false, timer: null, failures: 0 };
    mem.sync.set(id, st);
  }
  if (st.running) {
    st.again = true;
    return;
  }
  if (st.timer) {
    if (delayMs > 0) return; // a retry is already scheduled
    clearTimeout(st.timer);
  }
  st.timer = setTimeout(() => void runSync(id), delayMs);
}

async function runSync(id: string): Promise<void> {
  const st = mem.sync.get(id);
  if (!st) return;
  st.timer = null;
  st.running = true;
  st.again = false;
  try {
    await syncOnce(id);
    st.failures = 0;
    db().prepare(`UPDATE test_sessions SET gradeiq_sync_error = NULL WHERE id = ? AND gradeiq_sync_error IS NOT NULL`).run(id);
  } catch (e) {
    st.failures += 1;
    db().prepare(`UPDATE test_sessions SET gradeiq_sync_error = ? WHERE id = ?`).run(message(e), id);
    st.running = false;
    if (!(e instanceof GradeiqError && e.kind === "disabled")) scheduleSync(id, Math.min(60_000, 2_000 * 2 ** (st.failures - 1)));
    return;
  }
  st.running = false;
  if (st.again) scheduleSync(id);
}

async function syncOnce(id: string): Promise<void> {
  const r = row(id);
  if (!r || !r.gradeiq_id || r.gradeiq_state !== "ready" || !SYNC_STATUSES.includes(r.status)) return;
  const dev = deviceForward(r);
  if (dev) {
    const h = hash(dev);
    if (h !== r.gradeiq_device_hash) {
      await giq.postDevice(r.gradeiq_id, dev);
      db().prepare(`UPDATE test_sessions SET gradeiq_device_hash = ? WHERE id = ?`).run(h, id);
    }
  }
  const fn = functionalNow(r);
  if (fn) {
    const h = hash(fn);
    if (h !== r.gradeiq_forward_hash) {
      await giq.postFunctional(r.gradeiq_id, fn);
      db().prepare(`UPDATE test_sessions SET gradeiq_forward_hash = ?, gradeiq_forwarded_at = ? WHERE id = ?`).run(h, nowIso(), id);
    }
  }
}

function syncStatus(r: GiqRow): { state: "idle" | "in_sync" | "sending" | "retrying"; error: string | null; forwardedAt: string | null } {
  if (r.gradeiq_state !== "ready") return { state: "idle", error: null, forwardedAt: r.gradeiq_forwarded_at };
  const fn = functionalNow(r);
  const dev = deviceForward(r);
  const behind = (!!fn && hash(fn) !== r.gradeiq_forward_hash) || (!!dev && hash(dev) !== r.gradeiq_device_hash);
  if (r.gradeiq_sync_error) return { state: "retrying", error: r.gradeiq_sync_error, forwardedAt: r.gradeiq_forwarded_at };
  return { state: behind ? "sending" : fn || dev ? "in_sync" : "idle", error: null, forwardedAt: r.gradeiq_forwarded_at };
}

/* ─────────────────────────── pull (calls 4 + 5) ─────────────────────────── */

/** Read GradeIQ's /screen unless a read newer than maxAgeMs exists; persist what changed. */
function refreshScreen(id: string, gradeiqId: string, maxAgeMs: number): Promise<void> {
  const c = mem.screen.get(id);
  if (c?.promise) return c.promise;
  if (c && Date.now() - c.at < maxAgeMs) return Promise.resolve();
  const entry = { at: Date.now(), promise: null as Promise<void> | null };
  entry.promise = (async () => {
    let screen: GiqScreen | null = null;
    let err: string | null = null;
    try {
      screen = await giq.getScreen(gradeiqId);
    } catch (e) {
      err = message(e);
    }
    const r = row(id);
    if (!r) return;
    const prev = live(r);
    const now = nowIso();
    const next: Live = {
      ...prev,
      screen: screen ?? prev.screen,
      screenError: err,
      handoffAt: screen?.handoffDone ? (prev.handoffAt ?? now) : screen ? null : prev.handoffAt,
    };
    // Written only when something changed: the customer's phone polls this every 700 ms.
    if (JSON.stringify(next) !== JSON.stringify(prev) || !r.gradeiq_screen_at) saveLive(id, next, now);
    if (screen) {
      // The 180 s pull window starts when the photos are accepted; a retake restarts it.
      if (screen.cosmeticDone && !r.gradeiq_cosmetic_done_at) db().prepare(`UPDATE test_sessions SET gradeiq_cosmetic_done_at = ? WHERE id = ?`).run(now, id);
      if (!screen.cosmeticDone && r.gradeiq_cosmetic_done_at) db().prepare(`UPDATE test_sessions SET gradeiq_cosmetic_done_at = NULL WHERE id = ?`).run(id);
    }
  })().finally(() => {
    entry.promise = null;
    entry.at = Date.now();
  });
  mem.screen.set(id, entry);
  return entry.promise;
}

function pullWindowOver(r: Pick<GiqRow, "gradeiq_cosmetic_done_at">, now = Date.now()): boolean {
  return !!r.gradeiq_cosmetic_done_at && now - Date.parse(r.gradeiq_cosmetic_done_at) > PULL_WINDOW_MS;
}

/** The finality of what is stored, with the 180 s cap applied. */
function storedFinality(r: GiqRow): { snap: GradeiqSnapshot | null; fin: Finality; timedOut: boolean } {
  const snap = parseJson<GradeiqSnapshot | null>(r.gradeiq_snapshot, null);
  const timedOut = pullWindowOver(r);
  return { snap, fin: finality(snap, { timedOut }), timedOut };
}

function pullDue(r: GiqRow): boolean {
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id || !r.gradeiq_cosmetic_done_at) return false;
  if (pullWindowOver(r)) return false;
  if (r.gradeiq_synced_at && Date.now() - Date.parse(r.gradeiq_synced_at) < PULL_EVERY_MS) return false;
  const { snap, fin } = storedFinality(r);
  const l = live(r);
  // Done once the grade is final AND the LCD sweep's verdict is in (or the
  // camera finished its whole sequence and we have looked since).
  const lcdIn = !!snap?.displayCheck || (!!l.handoffAt && !!r.gradeiq_synced_at && r.gradeiq_synced_at > l.handoffAt);
  return !(fin.final && lcdIn);
}

/** Pull the whole session now and store the snapshot. Returns it, or null when GradeIQ could not be read. */
async function pullSnapshot(id: string): Promise<GradeiqSnapshot | null> {
  const r = row(id);
  if (!r?.gradeiq_id) return null;
  const now = nowIso();
  try {
    const snap = await giq.getSession(r.gradeiq_id, now);
    const prev = parseJson<GradeiqSnapshot | null>(r.gradeiq_snapshot, null);
    db().prepare(`UPDATE test_sessions SET gradeiq_snapshot = ?, gradeiq_synced_at = ? WHERE id = ?`).run(JSON.stringify(snap), now, id);
    const l = live(r);
    if (l.pullError) saveLive(id, { ...l, pullError: null }, now);
    // The camera's LCD verdict changes what `display` must say in GradeIQ.
    if (prev?.displayCheck?.verdict !== snap.displayCheck?.verdict) scheduleSync(id);
    return snap;
  } catch (e) {
    db().prepare(`UPDATE test_sessions SET gradeiq_synced_at = ? WHERE id = ?`).run(now, id);
    saveLive(id, { ...live(r), pullError: message(e) }, now);
    return null;
  }
}

/**
 * Called on every staff read of a session. Does what is due — lazy recovery of
 * a create or a forward lost to a restart, the /screen poll, the session pull —
 * and waits at most `waitMs` for it (the rest finishes in the background and
 * shows on the next poll).
 */
export async function refreshGrading(id: string, waitMs = 1_500): Promise<void> {
  const cfg = giq.gradeiqConfig();
  if (!cfg.enabled) return;
  const r = row(id);
  if (!r) return;
  if (r.gradeiq_state === "pending" && !mem.creating.has(id) && !mem.createTimers.has(id)) void ensureCreated(id);
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id || !SYNC_STATUSES.includes(r.status)) return;
  const st = mem.sync.get(id);
  if (syncStatus(r).state !== "in_sync" && syncStatus(r).state !== "idle" && !st?.running && !st?.timer) scheduleSync(id);
  const work = (async () => {
    await refreshScreen(id, r.gradeiq_id!, SCREEN_EVERY_MS);
    const r2 = row(id);
    if (r2 && pullDue(r2) && !mem.pulling.has(id)) {
      const p = pullSnapshot(id).then(() => undefined).finally(() => mem.pulling.delete(id));
      mem.pulling.set(id, p);
      await p;
    }
  })();
  await Promise.race([work, new Promise((res) => setTimeout(res, waitMs))]);
}

/* ─────────────────────────── the customer's phone (pairing proxy) ─────────────────────────── */

export type DeviceScreen = {
  /** disabled / failed: skip the photo step and run the tests. pending: wait. ready: show the patterns. */
  state: GradeiqState;
  pattern: string;
  shown: string | null;
  cosmeticDone: boolean;
  handoffDone: boolean;
  capture: { verdict: string; code: string | null; reasons: string[]; attempt: number } | null;
};

export class DeviceScreenUnavailable extends Error {}

/** GET /api/device/screen — never carries the GradeIQ id. */
export async function deviceScreen(r: GiqRow): Promise<DeviceScreen> {
  const idle: DeviceScreen = { state: r.gradeiq_state, pattern: "idle", shown: null, cosmeticDone: false, handoffDone: false, capture: null };
  if (!giq.gradeiqConfig().enabled) return { ...idle, state: "disabled" };
  if (r.gradeiq_state === "pending" && !mem.creating.has(r.id) && !mem.createTimers.has(r.id)) void ensureCreated(r.id);
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id) return idle;
  await refreshScreen(r.id, r.gradeiq_id, DEVICE_SCREEN_EVERY_MS);
  const l = live(row(r.id) ?? r);
  if (l.screenError || !l.screen) throw new DeviceScreenUnavailable(l.screenError ?? "The photo check has not started yet.");
  const s = l.screen;
  return { state: "ready", pattern: s.pattern, shown: s.shown, cosmeticDone: s.cosmeticDone, handoffDone: s.handoffDone, capture: s.capture };
}

/** POST /api/device/screen {shown} — the pattern the customer's phone is actually showing. */
export async function deviceScreenShown(r: GiqRow, shown: string): Promise<void> {
  if (!giq.gradeiqConfig().enabled || r.gradeiq_state !== "ready" || !r.gradeiq_id) throw new GradeiqError("disabled", "The photo check is not running for this session.");
  await giq.postScreenShown(r.gradeiq_id, shown);
  const fresh = row(r.id);
  if (!fresh) return;
  const l = live(fresh);
  const screen: GiqScreen = { ...(l.screen ?? { pattern: "idle", shown: null, cosmeticDone: false, handoffDone: false, capture: null, connectedAt: null }), shown };
  saveLive(r.id, { ...l, screen, screenError: null }, nowIso());
}

/* ─────────────────────────── what staff see ─────────────────────────── */

export type GradingView = {
  state: GradeiqState;
  /** One line for the top of the card. */
  message: string;
  error: string | null;
  canRetry: boolean;
  /** The customer's phone is echoing screen patterns (GradeIQ /screen `shown` is a string). */
  deviceReady: boolean;
  cameraConnected: boolean;
  /** GradeIQ's camera page for the STORE device. Staff-only; withheld until deviceReady (or an override). */
  cameraUrl: string | null;
  /** Why cameraUrl is withheld (null when it is not). */
  cameraLocked: string | null;
  canOverride: boolean;
  override: CameraOverrideInfo;
  screenReadable: boolean;
  pattern: string | null;
  cosmeticDone: boolean;
  handoffDone: boolean;
  capture: { verdict: string; reasons: string[] } | null;
  sync: { state: "idle" | "in_sync" | "sending" | "retrying"; error: string | null; forwardedAt: string | null };
  /** "GradeIQ out of sync, retrying". SwapUp's own results stay authoritative either way. */
  outOfSync: boolean;
  assessment: AssessmentView | null;
  disagreements: Disagreement[];
  /** Stopped waiting for a final grade (180 s after the photos were accepted). */
  timedOut: boolean;
  syncedAt: string | null;
};

export function cameraEvidence(r: GiqRow): { snap: GradeiqSnapshot | null; fin: Finality; mapping: CameraMapping; override: CameraOverrideInfo } {
  const { snap, fin } = storedFinality(r);
  const override = parseJson<CameraOverrideInfo>(r.gradeiq_override, null);
  return { snap, fin, mapping: mapCamera(snap, fin, { lcdOverride: override }), override };
}

export function gradingView(r: GiqRow): GradingView {
  const cfg = giq.gradeiqConfig();
  const l = live(r);
  const { snap, fin, mapping, override } = cameraEvidence(r);
  const state: GradeiqState = cfg.enabled ? r.gradeiq_state : "disabled";
  const open = SYNC_STATUSES.includes(r.status);
  const screen = l.screen;
  const deviceReady = state === "ready" && open && !l.screenError && typeof screen?.shown === "string";
  const sync = syncStatus(r);

  let cameraLocked: string | null = null;
  let canOverride = false;
  if (state !== "ready" || !r.gradeiq_id) cameraLocked = "Camera grading is not available for this session.";
  else if (!open) cameraLocked = ["waiting", "opened"].includes(r.status) ? "Open SwapUp Check on the customer's phone first — it has to show the screen patterns the camera asks for." : "This session is closed.";
  else if (l.screenError) {
    cameraLocked = `Can't confirm the customer's phone is ready (${l.screenError}). An override needs your name and a reason, and the LCD is then recorded as not camera-checked.`;
    canOverride = true;
  } else if (!screen) cameraLocked = "Checking whether the customer's phone is ready…";
  else if (typeof screen.shown !== "string") {
    cameraLocked = "Open SwapUp Check on the customer's phone first — it has to show the screen patterns the camera asks for.";
    canOverride = true;
  }
  const unlocked = state === "ready" && !!r.gradeiq_id && open && (deviceReady || !!override);
  if (unlocked) {
    cameraLocked = null;
    canOverride = false;
  }

  let msg: string;
  if (!cfg.enabled) msg = "Camera grading is switched off. Check the condition by eye.";
  else if (state === "disabled") msg = "This session started without camera grading. Press Retry to add it, or check the condition by eye.";
  else if (state === "pending") msg = r.gradeiq_error ? `Setting up camera grading… ${r.gradeiq_error}` : "Setting up camera grading…";
  else if (state === "failed") msg = `Camera grading unavailable. Check the condition by eye. ${r.gradeiq_error ?? ""}`.trim();
  else if (fin.final) msg = `Camera grade ${snap?.cosmeticGrade} (final).`;
  else if (fin.provisional) msg = `Camera grade ${snap?.cosmeticGrade || ""} is provisional. ${fin.reasons[0] ?? ""}`.trim();
  else if (fin.status === "failed") msg = fin.reasons[0];
  else if (screen?.cosmeticDone) msg = "Photos accepted — the camera grade is being worked out while the customer tests.";
  else if (unlocked) msg = override ? "Camera unlocked by override — the LCD will be recorded as not camera-checked." : "The customer's phone is ready. Take the photos on this device.";
  else msg = cameraLocked ?? "";

  const results = parseJson<TestResults>(r.results, {});
  const declared = parseJson<Declared | null>(r.declared, null);
  return {
    state,
    message: msg,
    error: state === "failed" || state === "pending" ? r.gradeiq_error : l.pullError,
    canRetry: cfg.enabled && (state === "failed" || state === "disabled") && !r.gradeiq_id && ["waiting", "opened", ...SYNC_STATUSES].includes(r.status),
    deviceReady,
    cameraConnected: !!screen?.connectedAt,
    cameraUrl: unlocked ? giq.cameraUrl(r.gradeiq_id!) : null,
    cameraLocked,
    canOverride,
    override,
    screenReadable: !!screen && !l.screenError,
    pattern: screen?.pattern ?? null,
    cosmeticDone: !!screen?.cosmeticDone,
    handoffDone: !!screen?.handoffDone,
    capture: screen?.capture ? { verdict: screen.capture.verdict, reasons: screen.capture.reasons } : null,
    sync,
    outOfSync: sync.state === "retrying" || sync.state === "sending",
    assessment: snap || state === "ready" ? assessmentView(snap, fin, mapping) : null,
    disagreements: disagreements(declared, results, snap, mapping, fin),
    timedOut: pullWindowOver(r),
    syncedAt: r.gradeiq_synced_at,
  };
}

/* ─────────────────────────── staff override + apply ─────────────────────────── */

/** Unlock the camera without the customer's phone echoing — recorded with a name and a reason. */
export function recordOverride(id: string, info: NonNullable<CameraOverrideInfo>): void {
  db().prepare(`UPDATE test_sessions SET gradeiq_override = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(info), nowIso(), id);
}

export type ApplyEvidence = {
  state: GradeiqState;
  gradeiqId: string | null;
  snap: GradeiqSnapshot | null;
  fin: Finality;
  mapping: CameraMapping;
  override: CameraOverrideInfo;
  devicefax: boolean;
  notes: string[];
};

/**
 * At Apply: one last pull of the session (so a grade that went final since the
 * last poll counts), then the DeviceFax snapshot for staff. Both outside any
 * transaction; a failure keeps the last stored snapshot — which counts only if
 * it was final.
 */
export async function evidenceForApply(id: string): Promise<ApplyEvidence> {
  const notes: string[] = [];
  const cfg = giq.gradeiqConfig();
  let r = row(id)!;
  let devicefax = false;
  if (cfg.enabled && r.gradeiq_state === "ready" && r.gradeiq_id) {
    const snap = await pullSnapshot(id);
    if (!snap) notes.push("GradeIQ could not be read at Apply; the last camera result was used only if it was final.");
    try {
      const fax = await giq.exportDeviceFax(r.gradeiq_id);
      db().prepare(`UPDATE test_sessions SET gradeiq_devicefax = ? WHERE id = ?`).run(JSON.stringify({ fetchedAt: nowIso(), devicefax: fax }), id);
      devicefax = true;
    } catch (e) {
      notes.push(`DeviceFax not saved: ${message(e)}`);
    }
    r = row(id)!;
  }
  const { snap, fin, mapping, override } = cameraEvidence(r);
  return { state: cfg.enabled ? r.gradeiq_state : "disabled", gradeiqId: r.gradeiq_id, snap, fin, mapping, override, devicefax, notes };
}
