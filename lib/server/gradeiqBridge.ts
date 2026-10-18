import { createHash, randomUUID } from "node:crypto";
import { db, nowIso, parseJson, audit } from "./db";
import * as giq from "./gradeiq";
import { GradeiqError } from "./gradeiq";
import { matchModel, type DeviceReport, type Declared, type TestResults, type TradeModelRef } from "../domain/diagnostics";
import { coloursApp, scanFirstApp, scanFirstLock, scanFirstMessage, readPhase } from "../domain/phoneLed";
import {
  finality,
  mapCamera,
  assessmentView,
  disagreements,
  gradeiqFunctionalMap,
  pullWindowStart,
  pullWindowClosed,
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
 *            accepted, for at most 180 s from the LATER of the photos and the
 *            camera page finishing (pullWindowStart — with two camera passes the
 *            screen check comes minutes after the photos) — then the last
 *            snapshot is kept.
 *   abandon  cancel / reissue stop all calls; the old id is recorded.
 *
 * Nothing here invents a grade: no GradeIQ session, no reachable GradeIQ, no
 * final grade — each means "not camera-graded", shown as such.
 */

export type GradeiqState = "disabled" | "pending" | "ready" | "failed";

const SYNC_STATUSES = ["joined", "testing", "complete"];
const SCREEN_EVERY_MS = 2_000;
/**
 * The customer's phone reads GradeIQ's /screen FRESH on every poll: GradeIQ's
 * camera page gives the phone 4 s to confirm white, and a reading reused from
 * up to half a second ago was one more delay in a relay that already has two
 * hops each way. A read already in flight is shared only if it started within
 * DEVICE_SCREEN_SHARE_MS — never an older one.
 */
const DEVICE_SCREEN_EVERY_MS = 0;
const DEVICE_SCREEN_SHARE_MS = 120;
const PULL_EVERY_MS = 5_000;
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
  /** Where SwapUp Check ≥ 0.6.0 says it is (POST /api/device/phase). */
  phone_phase?: string | null;
  /** The advisor let the phone go on from Scan without the camera ({by, userId, at}). */
  scan_release?: string | null;
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
  screen: Map<string, { at: number; promise: Promise<void> | null; startedAt?: number; savedFrom?: number }>;
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
    if (ge.orphanId) addOrphan(id, ge.orphanId, `not used: ${ge.message}`);
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
  const map = gradeiqFunctionalMap(results, snap?.displayCheck?.verdict ?? null);
  // Only SwapUp-only results so far (battery_health): nothing for GradeIQ yet.
  return Object.keys(map).length ? map : null;
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
      // Compare-and-set: if a new sweep marked the map for re-sending while this
      // request was in flight, keep the marker so the follow-up run sends again.
      db()
        .prepare(`UPDATE test_sessions SET gradeiq_forward_hash = ?, gradeiq_forwarded_at = ? WHERE id = ? AND gradeiq_forward_hash IS ?`)
        .run(h, nowIso(), id, r.gradeiq_forward_hash);
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

/**
 * Read GradeIQ's /screen unless a read newer than maxAgeMs exists; persist what
 * changed. A read in flight is shared when it started recently enough for the
 * caller (maxAgeMs, or DEVICE_SCREEN_SHARE_MS for the phone's maxAge of 0);
 * otherwise a new read starts beside it, and whichever STARTED last is the one
 * kept — an older read that finishes late never overwrites a newer one.
 */
function refreshScreen(id: string, gradeiqId: string, maxAgeMs: number): Promise<void> {
  const c = mem.screen.get(id);
  const started = Date.now();
  if (c?.promise && started - (c.startedAt ?? 0) <= Math.max(maxAgeMs, DEVICE_SCREEN_SHARE_MS)) return c.promise;
  if (c && !c.promise && started - c.at < maxAgeMs) return Promise.resolve();
  const entry: { at: number; promise: Promise<void> | null; startedAt: number; savedFrom: number } = { at: started, promise: null, startedAt: started, savedFrom: c?.savedFrom ?? 0 };
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
    // A read that started before the newest one saved has nothing newer to say.
    const cur = mem.screen.get(id);
    if ((cur?.savedFrom ?? 0) > started) return;
    if (cur) cur.savedFrom = started;
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
      // The pull window opens when the photos are accepted (and again at the
      // handoff above — pullWindowStart); a retake restarts it.
      if (screen.cosmeticDone && !r.gradeiq_cosmetic_done_at) db().prepare(`UPDATE test_sessions SET gradeiq_cosmetic_done_at = ? WHERE id = ?`).run(now, id);
      if (!screen.cosmeticDone && r.gradeiq_cosmetic_done_at) db().prepare(`UPDATE test_sessions SET gradeiq_cosmetic_done_at = NULL WHERE id = ?`).run(id);
    }
  })().finally(() => {
    const cur = mem.screen.get(id);
    // Only the newest read's finish moves the cache; an older one may still be finishing beside it.
    if (cur === entry) {
      entry.promise = null;
      entry.at = Date.now();
    }
  });
  mem.screen.set(id, entry);
  return entry.promise;
}

/**
 * When this session's pull window opened: the later of the photos being
 * accepted and the camera page finishing (live().handoffAt, stamped by
 * refreshScreen). null until the photos are accepted.
 */
function windowStart(r: Pick<GiqRow, "gradeiq_cosmetic_done_at" | "gradeiq_screen">): string | null {
  return pullWindowStart(r.gradeiq_cosmetic_done_at, live(r).handoffAt);
}

function pullWindowOver(r: Pick<GiqRow, "gradeiq_cosmetic_done_at" | "gradeiq_screen">, now = Date.now()): boolean {
  return pullWindowClosed(windowStart(r), now);
}

/** The finality of what is stored, with the 180 s cap applied. */
function storedFinality(r: GiqRow): { snap: GradeiqSnapshot | null; fin: Finality; timedOut: boolean } {
  const snap = parseJson<GradeiqSnapshot | null>(r.gradeiq_snapshot, null);
  const timedOut = pullWindowOver(r);
  return { snap, fin: finality(snap, { timedOut }), timedOut };
}

function pullDue(r: GiqRow): boolean {
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id || !windowStart(r)) return false;
  if (pullWindowOver(r)) return false;
  if (r.gradeiq_synced_at && Date.now() - Date.parse(r.gradeiq_synced_at) < PULL_EVERY_MS) return false;
  const { snap, fin } = storedFinality(r);
  const l = live(r);
  // Done once the grade is final AND the LCD sweep's verdict is in (or the
  // camera finished its whole sequence and we have looked since).
  const lcdIn = !!snap?.displayCheck || (!!l.handoffAt && !!r.gradeiq_synced_at && r.gradeiq_synced_at > l.handoffAt);
  // Photos first (two passes): until the screen check has run there is no LCD
  // verdict to fetch, so a final grade needs no more pulls — each one downloads
  // the whole session, photos and all. The handoff reopens the window and the
  // pulls resume until its verdict is in.
  const screenCheckToCome = !snap?.displayCheck && !l.handoffAt;
  // Photos skipped: there is no grade to wait for — only the screen check's verdict.
  if (!r.gradeiq_cosmetic_done_at) return !lcdIn;
  return !(fin.final && (lcdIn || screenCheckToCome));
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
    // Every screen sweep rewrites GradeIQ's `display` with its own verdict and
    // drops results posted during its AI call (contract §5 #7). So a new sweep
    // forces a full re-send even when SwapUp's map hashes the same — e.g. a
    // self-test fail with a camera pass leaves GradeIQ saying "pass" otherwise.
    // The marker is unique, so a forward already in flight can't overwrite it.
    if (JSON.stringify(prev?.displayCheck ?? null) !== JSON.stringify(snap.displayCheck ?? null)) {
      db().prepare(`UPDATE test_sessions SET gradeiq_forward_hash = ? WHERE id = ?`).run(`resend:${randomUUID()}`, id);
      scheduleSync(id);
    }
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
  // Photos first: pass 1 runs while the session is still waiting/opened (the
  // customer's phone hasn't joined), so /screen and the grade are read from then
  // on. Forwarding the phone's results still starts only once it has joined.
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id || !["waiting", "opened", ...SYNC_STATUSES].includes(r.status)) return;
  const st = mem.sync.get(id);
  if (SYNC_STATUSES.includes(r.status) && syncStatus(r).state !== "in_sync" && syncStatus(r).state !== "idle" && !st?.running && !st?.timer) scheduleSync(id);
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
  /** When GradeIQ's camera page first opened for this session — lets the phone tell "camera on its way" from "nobody there". */
  connectedAt: string | null;
  /**
   * The advisor let the phone go on from its Scan step without the camera (POST
   * /api/test-sessions/<id>/release-scan). The phone never offers the customer a
   * skip: it stays on Scan until the camera finishes (handoffDone) or this is true.
   */
  released: boolean;
  /**
   * SwapUp Check ≥ 0.8.0 only: GradeIQ can't be read right now. Sent as a normal answer (not a
   * 503) so the phone still learns `released` — it says "busy" and keeps polling, and the
   * customer is never offered a skip; the advisor can let it go on from SwapUp Store.
   */
  unreachable?: true;
};

export class DeviceScreenUnavailable extends Error {}

/** What the customer's phone echoes when it leaves its Scan step: never a colour GradeIQ could wait for. */
export const SHOWN_OFF = "off";

/** GET /api/device/screen — never carries the GradeIQ id. */
export async function deviceScreen(r: GiqRow): Promise<DeviceScreen> {
  const released = !!r.scan_release;
  const idle: DeviceScreen = { state: r.gradeiq_state, pattern: "idle", shown: null, cosmeticDone: false, handoffDone: false, capture: null, connectedAt: null, released };
  if (!giq.gradeiqConfig().enabled) return { ...idle, state: "disabled" };
  if (r.gradeiq_state === "pending" && !mem.creating.has(r.id) && !mem.createTimers.has(r.id)) void ensureCreated(r.id);
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id) return idle;
  await refreshScreen(r.id, r.gradeiq_id, DEVICE_SCREEN_EVERY_MS);
  const l = live(row(r.id) ?? r);
  if (l.screenError || !l.screen) {
    // Released by the advisor: the phone goes on whatever GradeIQ says — a camera service that
    // can't be read must not keep it on Scan (it would only ever see the 503).
    if (released) return { ...idle, ...(l.screen ? { cosmeticDone: l.screen.cosmeticDone, handoffDone: l.screen.handoffDone, connectedAt: l.screen.connectedAt ?? null } : null) };
    if (coloursApp(parseJson<DeviceReport | null>(r.device, null))) return { ...idle, unreachable: true };
    throw new DeviceScreenUnavailable(l.screenError ?? "The photo check has not started yet.");
  }
  const s = l.screen;
  const hideStale = checkBefore050(r.device) && !s.handoffDone;
  return {
    state: "ready",
    pattern: s.pattern,
    shown: s.shown,
    cosmeticDone: hideStale ? false : s.cosmeticDone,
    handoffDone: s.handoffDone,
    capture: hideStale ? null : s.capture,
    connectedAt: s.connectedAt ?? null,
    released,
  };
}

/**
 * GET /api/device/camera-link — GradeIQ's own camera link, which SwapUp Check ≥
 * 0.6.0 shows as a QR on its Scan screen (docs/PHONE-LED-FLOW.md). It is the
 * full single pass, no `pass`: photos, the dark front glass, the screen sweep and
 * the Settings photo, ending with handoffDone — exactly GradeIQ v2's await2nd
 * handoff, so GradeIQ needs no change. The owner accepted that this puts the
 * GradeIQ id on the customer's phone; no other device route ever carries it.
 */
export function deviceCameraLink(r: GiqRow): { ok: true; url: string } | { ok: false; why: "pending" | "off" } {
  if (!giq.gradeiqConfig().enabled) return { ok: false, why: "off" };
  // A create lost to a restart is picked up here too, as the /screen poll does.
  if (r.gradeiq_state === "pending" && !mem.creating.has(r.id) && !mem.createTimers.has(r.id)) void ensureCreated(r.id);
  if (r.gradeiq_state === "pending") return { ok: false, why: "pending" };
  if (r.gradeiq_state !== "ready" || !r.gradeiq_id) return { ok: false, why: "off" };
  return { ok: true, url: giq.cameraUrl(r.gradeiq_id) };
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
  // A /screen read that started before this echo would bring back the old `shown`: it is dropped.
  const m = mem.screen.get(r.id);
  if (m) m.savedFrom = Date.now();
}

/* ─────────────────────────── what staff see ─────────────────────────── */

export type GradingView = {
  state: GradeiqState;
  /** One line for the top of the card. */
  message: string;
  error: string | null;
  canRetry: boolean;
  /** The customer's phone is echoing screen patterns (GradeIQ /screen `shown` is a pattern — not "off"). */
  deviceReady: boolean;
  cameraConnected: boolean;
  /**
   * GradeIQ's camera page for the STORE device, the original single pass (photos +
   * screen sweep). Staff-only; withheld until deviceReady (or an override). Kept as
   * it was for SwapUp Store ≤ 0.4.x; newer apps use photosUrl, then screenUrl.
   */
  cameraUrl: string | null;
  /**
   * Pass 1 — the exterior photos only (`?pass=photos`). Staff-only. Offered as soon
   * as camera grading is ready and the session is open or still waiting: it needs
   * nothing on the customer's phone, so it is NOT gated on deviceReady. Always
   * null once a scan-first phone (SwapUp Check ≥ 0.6.0) has joined: the tablet
   * then runs the single pass (`cameraUrl`), from the phone's scan code or Take photos.
   */
  photosUrl: string | null;
  /** Pass 2 — the screen check only (`?pass=screen`). Same gate as cameraUrl: the phone must be showing its photo screen. */
  screenUrl: string | null;
  /** Why cameraUrl / screenUrl are withheld (null when they are not). */
  cameraLocked: string | null;
  canOverride: boolean;
  override: CameraOverrideInfo;
  /** The advisor let the phone go on from Scan without the camera — who and when. */
  released: { by: string; at: string } | null;
  /** "Go on without the camera" may be offered: a scan-first phone waiting on its Scan step, the camera not finished. */
  canRelease: boolean;
  screenReadable: boolean;
  pattern: string | null;
  cosmeticDone: boolean;
  handoffDone: boolean;
  /** The photos were accepted (GradeIQ's cosmeticDone seen) — pass 1, or the photo half of the single pass. */
  photosDone: boolean;
  /** The screen check ran: an LCD verdict exists, or the camera page said it finished (handoffDone seen). */
  screenDone: boolean;
  capture: { verdict: string; reasons: string[] } | null;
  sync: { state: "idle" | "in_sync" | "sending" | "retrying"; error: string | null; forwardedAt: string | null };
  /** "GradeIQ out of sync, retrying". SwapUp's own results stay authoritative either way. */
  outOfSync: boolean;
  assessment: AssessmentView | null;
  disagreements: Disagreement[];
  /** Stopped waiting for a final grade (180 s after the later of the photos being accepted and the screen check finishing). */
  timedOut: boolean;
  /** Photos are in but the grade (or the LCD verdict) isn't final yet — Apply waits (cameraGradePending). */
  gradePending: boolean;
  syncedAt: string | null;
};

/**
 * The photos are in and GradeIQ is still working out the grade or the LCD
 * verdict, inside the 180 s pull window (which opens again when the screen
 * check finishes — pullWindowStart). Applying now would turn the camera's
 * confirmed damage into "not final, so not added" flags, and Apply is one-shot —
 * so Apply waits. With photos as the phone's LAST step, the phone reports
 * "complete" about a second after the photos, well before the grade lands.
 */
export function cameraGradePending(r: GiqRow): boolean {
  if (!giq.gradeiqConfig().enabled || r.gradeiq_state !== "ready" || !r.gradeiq_id || !windowStart(r)) return false;
  if (pullWindowOver(r)) return false;
  const { snap, fin } = storedFinality(r);
  const l = live(r);
  // Wait only while something can still change: a grade still being worked out,
  // or the camera page still running its screen sweep. A failed grade (stub tier,
  // too little visible) or a provisional one that is no longer refining (a case
  // on the phone, say) will not become final by waiting — it needs a retake.
  // The screen check finished but its verdict hasn't been read since: Apply would record "LCD not checked".
  const pulledSinceHandoff = !!l.handoffAt && !!r.gradeiq_synced_at && r.gradeiq_synced_at > l.handoffAt;
  const lcdPending = !!l.handoffAt && !snap?.displayCheck && !pulledSinceHandoff;
  // Photos skipped: no grade can come — wait only for the screen check's verdict.
  if (!r.gradeiq_cosmetic_done_at) return lcdPending;
  const settled = fin.final || fin.status === "failed" || (fin.status === "provisional" && !snap?.refining);
  const sweepRunning = !snap?.displayCheck && !l.handoffAt;
  return !settled || sweepRunning || lcdPending;
}

/**
 * SwapUp Check before 0.5.0 counts a cosmeticDone or capture verdict already on
 * GradeIQ's /screen as "the camera is here" and leaves its photo screen 30 s
 * after cosmeticDone. With photos first, pass 1 leaves exactly that behind
 * before the phone even joins — so those builds would walk off before the
 * screen check. For them, /screen shows neither until the camera's handoff.
 */
function checkBefore050(deviceJson: string | null): boolean {
  const v = parseJson<{ appVersion?: string | null } | null>(deviceJson, null)?.appVersion ?? "";
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m || v.startsWith("web-")) return false;
  return Number(m[1]) === 0 && Number(m[2]) < 5;
}

function isBrowserCheck(deviceJson: string | null): boolean {
  return (parseJson<{ appVersion?: string | null } | null>(deviceJson, null)?.appVersion ?? "").startsWith("web-");
}

/** SwapUp Check 0.3.0+ (native) runs its tests first and shows the photo screen last. */
export function photosLastApp(deviceJson: string | null): boolean {
  const v = parseJson<{ appVersion?: string | null } | null>(deviceJson, null)?.appVersion ?? "";
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m || v.startsWith("web-")) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 3;
}

export function cameraEvidence(r: GiqRow): { snap: GradeiqSnapshot | null; fin: Finality; mapping: CameraMapping; override: CameraOverrideInfo } {
  const override = parseJson<CameraOverrideInfo>(r.gradeiq_override, null);
  // The kill switch means NO GradeIQ data is used — not even a snapshot pulled
  // before it was thrown. Otherwise Apply would add camera_ai faults and a
  // camera floor to a case it records as "not camera-graded".
  if (!giq.gradeiqConfig().enabled) {
    const fin = finality(null);
    return { snap: null, fin, mapping: mapCamera(null, fin, { lcdOverride: override }), override };
  }
  const { snap, fin } = storedFinality(r);
  return { snap, fin, mapping: mapCamera(snap, fin, { lcdOverride: override }), override };
}

export function gradingView(r: GiqRow): GradingView {
  const cfg = giq.gradeiqConfig();
  const l = live(r);
  const { snap, fin, mapping, override } = cameraEvidence(r);
  const state: GradeiqState = cfg.enabled ? r.gradeiq_state : "disabled";
  const open = SYNC_STATUSES.includes(r.status);
  const screen = l.screen;
  // GradeIQ never clears `shown`, so an echo from a phone that then LEFT the photo
  // screen without photos (it records display skip with detail.photos) must not
  // keep counting as "ready".
  const resultsNow = parseJson<TestResults>(r.results, {});
  const photosEnded = ["skipped", "unavailable"].includes(String((resultsNow.display?.detail as Record<string, unknown> | null | undefined)?.photos ?? ""));
  // "off" = the phone said it left its Scan step (SwapUp Check ≥ 0.8.0): no longer showing anything.
  const echoing = typeof screen?.shown === "string" && screen.shown !== SHOWN_OFF;
  const deviceReady = state === "ready" && open && !l.screenError && echoing && !photosEnded;
  const sync = syncStatus(r);
  // Two camera passes (docs/TWO-PASS-CAMERA.md): the photos can be in before the
  // customer's phone has even joined, and the screen check comes after its tests.
  const photosDone = !!r.gradeiq_cosmetic_done_at || !!screen?.cosmeticDone;
  const screenDone = !!snap?.displayCheck || !!l.handoffAt;
  // SwapUp Check ≥ 0.6.0 leads (docs/PHONE-LED-FLOW.md): it identifies itself,
  // shows GradeIQ's camera link as its scan code BEFORE its tests, and the tablet
  // runs the single pass from that. No photos before it joins. Only known once
  // the phone has joined (its appVersion); until then this is today's view.
  const scanFirst = scanFirstApp(parseJson<DeviceReport | null>(r.device, null));
  const phase = readPhase(r.phone_phase);

  let cameraLocked: string | null = null;
  let canOverride = false;
  if (state !== "ready" || !r.gradeiq_id) cameraLocked = "No camera grading for this session.";
  else if (!open) cameraLocked = ["waiting", "opened"].includes(r.status) ? "Open SwapUp Check on the phone first." : "This session is closed.";
  else if (l.screenError) {
    // The store's camera service didn't answer — not the phone. Its raw error stays in the logs.
    cameraLocked = "Camera service not answering — override with your name and a reason.";
    canOverride = true;
  } else if (!screen) cameraLocked = "Checking the phone…";
  else if (!echoing || photosEnded) {
    // Once the photos are in (pass 1), only the screen check is left behind this
    // lock — say that, not "photos". The single pass never gets here with photos
    // done: it takes them with the phone already echoing.
    cameraLocked = scanFirst
      ? scanFirstLock(phase, photosEnded, r.status === "complete")
      : r.status === "complete" || photosEnded
        ? photosDone
          ? "Phone finished without the photo screen — screen check needs an override."
          : "Phone finished without the photo screen — photos need an override."
        : photosLastApp(r.device)
          ? "Camera unlocks when the phone's tests finish."
          : isBrowserCheck(r.device)
            ? photosDone
              ? "Browser check: no photo screen — screen check needs an override."
              : "Browser check: no photo screen — use \"Take photos anyway\"."
            : "Keep SwapUp Check on its photo screen.";
    canOverride = true;
  }
  const unlocked = state === "ready" && !!r.gradeiq_id && open && (deviceReady || !!override);
  if (unlocked) {
    cameraLocked = null;
    canOverride = false;
  }
  // Pass 1 needs nothing on the customer's phone, so it is offered the moment the
  // GradeIQ session exists — before the phone joins, which is the point of it.
  // Not for a scan-first phone: the tablet scans the phone's code instead, and
  // the single pass takes the photos with the phone already in the app.
  const photosOpen = !scanFirst && state === "ready" && !!r.gradeiq_id && ["waiting", "opened", ...SYNC_STATUSES].includes(r.status);

  // What the grade itself says, once it says anything.
  const gradeLine = fin.final
    ? `Camera grade ${snap?.cosmeticGrade} (final).`
    : fin.provisional
      ? `Camera grade ${snap?.cosmeticGrade || ""} provisional${fin.reasons[0] ? ` — ${fin.reasons[0].charAt(0).toLowerCase()}${fin.reasons[0].slice(1)}` : "."}`
      : fin.status === "failed"
        ? fin.reasons[0]
        : null;
  // Photos in, screen check still to come: tell the advisor what happens next,
  // or the grade alone would read as if the camera were finished.
  let next: string | null = null;
  if (state === "ready" && photosDone && !screenDone) {
    if (unlocked)
      next = override
        ? "Check the screen here — unlocked by override."
        : "Phone on its photo screen — check the screen here.";
    else if (r.status === "waiting" || r.status === "opened") next = "Next, connect the phone — screen check after its tests.";
    else if ((r.status === "joined" || r.status === "testing") && !l.screenError && !photosEnded && photosLastApp(r.device))
      next = "Phone testing — screen check after its tests.";
    else next = cameraLocked;
  }

  let msg: string;
  if (!cfg.enabled) msg = "Camera grading off — check by eye.";
  else if (state === "disabled") msg = "No camera grading — press Retry, or check by eye.";
  else if (state === "pending") msg = r.gradeiq_error ? "Setting up camera grading… retrying." : "Setting up camera grading…";
  else if (state === "failed") msg = "Camera grading unavailable — check by eye.";
  else if (scanFirst && open)
    msg = scanFirstMessage({
      phase,
      unlocked,
      locked: cameraLocked,
      cameraAtWork: !!screen?.connectedAt || (!!screen?.pattern && screen.pattern !== "idle"),
      photosDone,
      screenDone,
      gradeLine: gradeLine ?? null,
      // Waiting changes nothing once it is final, failed, or provisional with nothing refining it (cameraGradePending's rule).
      gradeSettled: fin.final || fin.status === "failed" || (fin.status === "provisional" && !snap?.refining),
    });
  else if (gradeLine) msg = next ? `${gradeLine} ${next}` : gradeLine;
  else if (next) msg = `Photos in — ${next.charAt(0).toLowerCase()}${next.slice(1)}`;
  else if (photosDone) msg = screenDone ? "Photos and screen done — grade coming." : "Photos in — grade coming.";
  else if (screenDone) msg = "Screen checked, no photos — check by eye.";
  else if (unlocked) msg = override ? "Camera unlocked by override." : "Phone ready — take the photos here.";
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
    photosUrl: photosOpen ? giq.cameraUrl(r.gradeiq_id!, "photos") : null,
    // A phone-led (≥ 0.6.0) phone is photographed in ONE pass from its Scan screen, so an
    // older SwapUp Store's "Check the screen" must open the full pass too — pass=screen
    // would run only the sweep and skip the photos and Settings entirely.
    screenUrl: unlocked ? (scanFirst ? giq.cameraUrl(r.gradeiq_id!) : giq.cameraUrl(r.gradeiq_id!, "screen")) : null,
    cameraLocked,
    canOverride,
    override,
    released: releasedOf(r),
    canRelease: open && scanFirst && phase === "scan" && !r.scan_release && !l.handoffAt && state !== "disabled" && state !== "failed",
    screenReadable: !!screen && !l.screenError,
    pattern: screen?.pattern ?? null,
    cosmeticDone: !!screen?.cosmeticDone,
    handoffDone: !!screen?.handoffDone,
    photosDone,
    screenDone,
    capture: screen?.capture ? { verdict: screen.capture.verdict, reasons: screen.capture.reasons } : null,
    sync,
    outOfSync: sync.state === "retrying" || sync.state === "sending",
    assessment: snap || state === "ready" ? assessmentView(snap, fin, mapping) : null,
    disagreements: disagreements(declared, results, snap, mapping, fin),
    timedOut: pullWindowOver(r),
    gradePending: cameraGradePending(r),
    syncedAt: r.gradeiq_synced_at,
  };
}

function releasedOf(r: GiqRow): { by: string; at: string } | null {
  const v = parseJson<{ by?: unknown; at?: unknown } | null>(r.scan_release ?? null, null);
  return v && typeof v.by === "string" && typeof v.at === "string" ? { by: v.by, at: v.at } : null;
}

/* ─────────────────────────── staff override + apply ─────────────────────────── */

/** Unlock the camera without the customer's phone echoing — recorded with a name and a reason. */
export function recordOverride(id: string, info: NonNullable<CameraOverrideInfo>): void {
  db().prepare(`UPDATE test_sessions SET gradeiq_override = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(info), nowIso(), id);
}

export type ApplyEvidence = {
  /** The grade is still being worked out (cameraGradePending): Apply must wait. Nothing was exported. */
  pending: boolean;
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
    // /screen first: it is what records when the photos were accepted and when
    // the camera page finished (the pull window). On the override paths nothing
    // else may have polled it since.
    await refreshScreen(id, r.gradeiq_id, 0).catch(() => {});
    const snap = await pullSnapshot(id);
    if (!snap) notes.push("Camera unreadable at Apply — only a final result was used.");
    const now = row(id)!;
    if (cameraGradePending(now)) {
      const ev = cameraEvidence(now);
      return { pending: true, state: now.gradeiq_state, gradeiqId: now.gradeiq_id, ...ev, devicefax: false, notes };
    }
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
  return { pending: false, state: cfg.enabled ? r.gradeiq_state : "disabled", gradeiqId: r.gradeiq_id, snap, fin, mapping, override, devicefax, notes };
}
