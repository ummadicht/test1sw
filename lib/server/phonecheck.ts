import { createHash, timingSafeEqual } from "node:crypto";
import { query, queryOne, execute, tx, nowIso, newId, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { storeInScope, type StoreRow } from "./scope";
import { getCase, updateCase, recordFaultSources, type CaseView, type CasePatch, type UpdateInternal } from "./cases";
import { issueIfChanged } from "./gradingReport";
import { aiReaderConfigured, readReportFile } from "./phonecheckOcr";
import { DEFAULT_PLAN, matchModel, mergeCondition, summarise, unionFaults, withIssues, type TradeModelRef } from "../domain/diagnostics";
import { addFaultSources, applyCameraFloor, NO_FLOOR, type RecordedOverride } from "../domain/gradeiqMap";
import {
  checkPcUpload,
  evidenceFromPhonecheck,
  isNoData,
  pcDeviceReport,
  phonecheckUpsert,
  readPhonecheck,
  unwrapPhonecheck,
  PC_UPLOAD_MAX_BYTES,
  type PcRecord,
} from "../domain/phonecheck";
import { maskImei, readImei } from "../domain/imei";
import type { CaseStatus } from "../domain/lifecycle";
import type { FaultId } from "../domain/condition";

/**
 * PHONECHECK — a store's Phonecheck station, as one more source of test
 * evidence for the grade (docs/GRADING.md). Three ways a record arrives, one
 * way it reaches a case:
 *
 *   pull     staff press "Phonecheck results" on a case: one `GetDeviceInfo`
 *            by IMEI, form-encoded, with the account's API key and the STORE's
 *            station login (the master account name always gets a 401).
 *   webhook  Phonecheck POSTs a finished check (only after the erase passed —
 *            so rarely at the counter). Stored, NEVER auto-attached.
 *   upload   staff upload the JSON, or the report as a PDF / photo that the AI
 *            reader turns into the same fields (lib/server/phonecheckOcr.ts).
 *            Always provisional.
 *
 *   attach   advisor or store manager, case still at the counter: the record's
 *            IMEI must be the case's (a manager may attach a different one with
 *            a reason — provisional, PV8). Its failed tests are unioned into the
 *            case's faults (source "phonecheck"), the condition only ever gets
 *            worse, the model and storage fill only what the case lacks, and the
 *            case re-prices like any other edit and issues a report version.
 *
 * Switched OFF until the owner has keys (owner, 2026-10-17): with PHONECHECK_*
 * unset everything else works and the pull says why it is off.
 */

/* ─────────────────────────── config ─────────────────────────── */

export type PhonecheckConfig = {
  base: string;
  apiKey: string;
  username: string | null;
  contractConfirmed: boolean;
  webhookSecret: string | null;
  timeoutMs: number;
  tz: string | null;
};

export function phonecheckConfig(): PhonecheckConfig {
  const e = process.env;
  const t = Number(e.PHONECHECK_TIMEOUT_MS);
  return {
    base: (e.PHONECHECK_API_BASE || "https://clientapiv2.phonecheck.com/cloud/cloudDB").trim().replace(/\/$/, ""),
    apiKey: (e.PHONECHECK_API_KEY || "").trim(),
    username: (e.PHONECHECK_USERNAME || "").trim() || null,
    contractConfirmed: (e.PHONECHECK_CONTRACT_CONFIRMED || "").trim() === "1",
    webhookSecret: (e.PHONECHECK_WEBHOOK_SECRET || "").trim() || null,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 8_000,
    tz: (e.PHONECHECK_TZ || "").trim() || null,
  };
}

/** May SwapUp call Phonecheck at all? Worded like the buyback partner's live check (lib/server/buyback.ts). */
export function phonecheckConfigured(): { ok: boolean; why: string } {
  const c = phonecheckConfig();
  if (!c.apiKey) return { ok: false, why: "Phonecheck is off here — upload its JSON or report." };
  if (!c.contractConfirmed)
    return {
      ok: false,
      why: "Phonecheck pull is off until its contract is confirmed.",
    };
  return { ok: true, why: "Phonecheck pull." };
}

type StoreSettings = { phonecheck?: { station?: string | null } | null };

async function storeSettings(storeId: string): Promise<StoreSettings> {
  const row = await queryOne<{ settings: string }>(`SELECT settings FROM stores WHERE id = $1`, [storeId]);
  return parseJson<StoreSettings>(row?.settings, {});
}

/** The station login a pull for this store uses: the store's own, else PHONECHECK_USERNAME. */
export async function stationFor(storeId: string): Promise<{ station: string | null; from: "store" | "server" | null }> {
  const settings = await storeSettings(storeId);
  const own = settings.phonecheck?.station;
  if (typeof own === "string" && own.trim()) return { station: own.trim(), from: "store" };
  const fallback = phonecheckConfig().username;
  return fallback ? { station: fallback, from: "server" } : { station: null, from: null };
}

const EDITABLE: CaseStatus[] = ["draft", "quoted"];

/** Can staff pull this case's Phonecheck result now? `why` when not — never a silent no. */
export async function pullState(c: { storeId: string; status: CaseStatus; imei: string | null; imei2: string | null }): Promise<{ canPull: boolean; why: string | null }> {
  const conf = phonecheckConfigured();
  if (!conf.ok) return { canPull: false, why: conf.why };
  const st = await stationFor(c.storeId);
  if (!st.station)
    return { canPull: false, why: "No Phonecheck station login — a manager sets it in store settings." };
  if (!EDITABLE.includes(c.status)) return { canPull: false, why: "The case is past the counter." };
  if (!c.imei && !c.imei2) return { canPull: false, why: "Record the IMEI first." };
  return { canPull: true, why: null };
}

/* ─────────────────────────── the pull client ─────────────────────────── */

export type PhonecheckErrorKind = "config" | "auth" | "timeout" | "http" | "shape";

export class PhonecheckError extends Error {
  kind: PhonecheckErrorKind;
  status: number | null;
  constructor(kind: PhonecheckErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "PhonecheckError";
    this.kind = kind;
    this.status = status;
  }
}

const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

/**
 * One `GetDeviceInfo` by IMEI. 404 / "No Data Found" is `notFound` — never
 * tested on this account, not a failure. Throws PhonecheckError otherwise.
 */
export async function fetchByImei(imei: string, station: string): Promise<{ rows: unknown[] } | { notFound: true }> {
  const conf = phonecheckConfigured();
  if (!conf.ok) throw new PhonecheckError("config", conf.why);
  const cfg = phonecheckConfig();
  const scrub = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join("[key]") : s);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/GetDeviceInfo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ apiKey: cfg.apiKey, username: station, imei, IMEI: imei }).toString(),
      signal: ctl.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new PhonecheckError("timeout", `Phonecheck did not answer within ${Math.round(cfg.timeoutMs / 1000)} s.`);
    throw new PhonecheckError("http", `Can't reach Phonecheck (${scrub(String((e as Error)?.message || "network error"))}).`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    throw new PhonecheckError(ctl.signal.aborted ? "timeout" : "http", "Phonecheck's answer was cut off.");
  }
  clearTimeout(timer);
  if (text.length > MAX_RESPONSE_CHARS) throw new PhonecheckError("shape", "Phonecheck's answer was too large to read.");
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (isNoData(res.status, json ?? text)) return { notFound: true };
  if (res.status === 401) throw new PhonecheckError("auth", "Phonecheck refused the key or station login (not the master account).", 401);
  if (res.status === 403) {
    const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const said = scrub(String(o.msg ?? o.message ?? text ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);
    if (/licen[cs]e/i.test(said)) throw new PhonecheckError("http", `Phonecheck: ${said}`, 403);
    throw new PhonecheckError("auth", "Phonecheck refused this server — add 104.197.168.25 to its Approved IPs.", 403);
  }
  if (!res.ok) throw new PhonecheckError("http", `Phonecheck answered ${res.status}.`, res.status);
  if (json === undefined) throw new PhonecheckError("shape", "Phonecheck sent something that is not JSON.");
  const rows = unwrapPhonecheck(json);
  if (!rows.length) throw new PhonecheckError("shape", "Phonecheck's answer had no device record in it.");
  return { rows };
}

function asHttp(e: unknown): unknown {
  if (!(e instanceof PhonecheckError)) return e;
  if (e.kind === "config") return new HttpError(409, e.message);
  if (e.kind === "timeout") return new HttpError(504, e.message);
  return new HttpError(502, e.message);
}

const PULL_GAP_MS = 15_000;
const PULLS_PER_DAY = 10;
const AI_GAP_MS = 10_000;
const AI_READS_PER_DAY = 10;
const pulls = new Map<string, number[]>();
const aiReads = new Map<string, number[]>();

function throttle(map: Map<string, number[]>, caseId: string, gapMs: number, perDay: number, what: string): void {
  const now = Date.now();
  const day = (map.get(caseId) ?? []).filter((t) => now - t < 86_400_000);
  if (day.length >= perDay) throw new HttpError(429, `Daily limit of ${perDay} ${what}s reached — upload the JSON instead.`);
  if (day.length && now - day[day.length - 1] < gapMs) throw new HttpError(429, `One moment — last ${what} was under ${Math.round(gapMs / 1000)} s ago.`);
  map.set(caseId, [...day, now]);
}

/* ─────────────────────────── storage ─────────────────────────── */

type PcRow = {
  id: string;
  record_key: string;
  source: "pull" | "webhook" | "upload";
  imei: string | null;
  imei2: string | null;
  store_id: string | null;
  case_id: string | null;
  tested_at: string | null;
  record: string;
  raw: string;
  received_at: string;
  updated_at: string;
  attached_at: string | null;
  attached_by: string | null;
  attach_override: string | null;
};

const RAW_CAP = 64 * 1024;

export function capRaw(raw: unknown): string {
  const s = JSON.stringify(raw ?? null) ?? "null";
  if (s.length <= RAW_CAP) return s;
  return JSON.stringify({ truncated: true, chars: s.length, head: s.slice(0, RAW_CAP - 200) });
}

async function rowById(id: string): Promise<PcRow | null> {
  return queryOne<PcRow>(`SELECT * FROM phonecheck_records WHERE id = $1`, [id]);
}

export type StoreOutcome = "insert" | "replace" | "stale" | "fetched_copy";

export async function storeRecord(rec: PcRecord, raw: unknown, source: PcRow["source"], storeId: string | null): Promise<{ row: PcRow; outcome: StoreOutcome }> {
  return tx(async () => {
    const existing = await queryOne<PcRow>(`SELECT * FROM phonecheck_records WHERE record_key = $1`, [rec.key]);
    const now = nowIso();
    if (!existing) {
      const id = newId("pc");
      await execute(
        `INSERT INTO phonecheck_records (id, record_key, source, imei, imei2, store_id, case_id, tested_at, record, raw, received_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11)`,
        [id, rec.key, source, rec.imei, rec.imei2, storeId, rec.testedAt, JSON.stringify(rec), capRaw(raw), now, now]
      );
      const inserted = await rowById(id);
      return { row: inserted!, outcome: "insert" as const };
    }
    if (source === "upload" && existing.source !== "upload") return { row: existing, outcome: "fetched_copy" as const };
    const wasAi = recordOf(existing).aiRead === true;
    const overAi = wasAi && rec.aiRead !== true;
    if (rec.aiRead === true && !wasAi) return { row: existing, outcome: "stale" as const };
    const decision =
      overAi || (existing.source === "upload" && source !== "upload") ? "replace" : phonecheckUpsert({ testedAt: existing.tested_at }, { testedAt: rec.testedAt });
    if (decision !== "replace") return { row: existing, outcome: "stale" as const };
    await execute(
      `UPDATE phonecheck_records SET source = $1, imei = $2, imei2 = $3, store_id = COALESCE(store_id, $4), tested_at = $5, record = $6, raw = $7, received_at = $8, updated_at = $9 WHERE id = $10`,
      [source, rec.imei, rec.imei2, storeId, rec.testedAt, JSON.stringify(rec), capRaw(raw), now, now, existing.id]
    );
    const updated = await rowById(existing.id);
    return { row: updated!, outcome: "replace" as const };
  });
}

export function recordOf(row: Pick<PcRow, "record">): PcRecord {
  return JSON.parse(row.record) as PcRecord;
}

export type PcSummary = {
  id: string;
  source: PcRow["source"];
  aiRead: boolean;
  imei: string;
  imei2: string | null;
  reportNo: string | null;
  testedAt: string | null;
  testedAtWhy: string | null;
  receivedAt: string;
  phone: string | null;
  modelNo: string | null;
  variant: string | null;
  working: PcRecord["working"];
  passed: number;
  failed: string[];
  pending: string[];
  batteryHealthPct: number | null;
  testerGrade: string | null;
  deviceLock: PcRecord["deviceLock"];
  parts: PcRecord["parts"];
  erased: boolean | null;
  station: string | null;
  tester: string | null;
  links: PcRecord["links"];
  attached: { caseId: string; caseRef: string | null; at: string | null; by: string | null; imeiOverride: boolean } | null;
};

export async function summaryOf(row: PcRow): Promise<PcSummary> {
  const r = recordOf(row);
  let ref: string | null = null;
  if (row.case_id) {
    const caseRow = await queryOne<{ ref: string }>(`SELECT ref FROM cases WHERE id = $1`, [row.case_id]);
    ref = caseRow?.ref ?? null;
  }
  return {
    id: row.id,
    source: row.source,
    aiRead: r.aiRead === true,
    imei: r.imei,
    imei2: r.imei2,
    reportNo: r.reportId,
    testedAt: r.testedAt,
    testedAtWhy: r.testedAtWhy,
    receivedAt: row.received_at,
    phone: [r.make, r.model].filter(Boolean).join(" ") || null,
    modelNo: r.modelNo,
    variant: r.variant,
    working: r.working,
    passed: r.passed.length,
    failed: r.failed.map((n) => `${n.manual ? "M-" : ""}${n.name}`),
    pending: r.pending.map((n) => n.name),
    batteryHealthPct: r.batteryHealthPct,
    testerGrade: r.testerGrade,
    deviceLock: r.deviceLock,
    parts: r.parts,
    erased: r.erased,
    station: r.station,
    tester: r.tester,
    links: r.links,
    attached: row.case_id && row.attached_at ? { caseId: row.case_id, caseRef: ref, at: row.attached_at, by: row.attached_by, imeiOverride: !!row.attach_override } : null,
  };
}

/* ─────────────────────────── attach ─────────────────────────── */

export class PhonecheckMismatch extends HttpError {
  record: PcSummary;
  constructor(message: string, record: PcSummary) {
    super(409, message);
    this.name = "PhonecheckMismatch";
    this.record = record;
  }
}

const HOLDS_PHONE: CaseStatus[] = ["draft", "quoted", "locked", "in_pickup", "collected"];

async function tradeModelRefs(): Promise<TradeModelRef[]> {
  const rows = await query<{ id: string; brand: string; model: string; variants: string; model_codes: string }>(
    `SELECT id, brand, model, variants, model_codes FROM trade_models`
  );
  return rows.map((r) => ({ id: r.id, brand: r.brand, model: r.model, variants: parseJson<string[]>(r.variants, []), modelCodes: parseJson<string[]>(r.model_codes, []) }));
}

function requireCounter(u: SessionUser): void {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff attach Phonecheck results to a case.");
}

async function openCase(u: SessionUser, caseId: string): Promise<CaseView> {
  requireCounter(u);
  const v = await getCase(u, caseId);
  if (!EDITABLE.includes(v.status)) throw new HttpError(409, "The case is past the counter.");
  return v;
}

export type AttachOpts = { confirmMismatch?: boolean; reason?: string };

export async function attachRecord(u: SessionUser, caseId: string, recordId: string, opts: AttachOpts = {}): Promise<{ case: CaseView; record: PcSummary }> {
  const v = await openCase(u, caseId);
  const row = await rowById(recordId);
  if (!row || (row.store_id && row.store_id !== v.storeId)) throw new HttpError(404, "Phonecheck record not found.");
  if (row.case_id && row.case_id !== caseId) {
    const other = await queryOne<{ ref: string; status: CaseStatus }>(`SELECT ref, status FROM cases WHERE id = $1`, [row.case_id]);
    if (other && HOLDS_PHONE.includes(other.status)) throw new HttpError(409, `This Phonecheck report is already on case ${other.ref}.`);
  }
  const rec = recordOf(row);

  const ai = rec.aiRead === true;
  const patch: CasePatch = {};
  const caseImeis = [v.imei, v.imei2].filter((x): x is string => !!x);
  const recImeis = [rec.imei, rec.imei2].filter((x): x is string => !!x);
  let override: RecordedOverride | null = null;
  if (!caseImeis.length) {
    if (!ai) {
      patch.imei = rec.imei;
      if (rec.imei2) patch.imei2 = rec.imei2;
    }
  } else if (!recImeis.some((i) => caseImeis.includes(i))) {
    if (!opts.confirmMismatch)
      throw new PhonecheckMismatch(
        `Report IMEI ${recImeis.join(" / ")} isn't the case's ${caseImeis.join(" / ")} — check *#06#.`,
        await summaryOf(row)
      );
    if (u.role !== "store_manager") throw new HttpError(403, "Only a store manager can attach a report with a different IMEI.");
    const reason = String(opts.reason ?? "").trim().slice(0, 300);
    if (reason.length < 8) throw new HttpError(400, "Say how you checked it's this phone.");
    override = { by: u.name, userId: u.id, reason, at: nowIso(), items: ["imei"] };
  } else if (!v.imei2 && !ai) {
    const other = recImeis.find((i) => !caseImeis.includes(i));
    if (other) patch.imei2 = other;
  }

  const refs = await tradeModelRefs();
  const ev = evidenceFromPhonecheck(rec, row.source === "upload" ? "phonecheck_upload" : "phonecheck", row.received_at);
  const s = summarise(DEFAULT_PLAN, ev.results, null, null, refs);
  const pcFaults: FaultId[] = s.faults.map((f) => f.id);
  const faults = unionFaults(v.faults, pcFaults);
  if (faults.length !== v.faults.length) patch.faults = faults;
  if (v.condition) {
    const worse = applyCameraFloor(withIssues(mergeCondition(v.condition, faults), s.issues), v.camera?.floor ?? NO_FLOOR);
    if (JSON.stringify(worse) !== JSON.stringify(v.condition)) patch.condition = worse;
  }

  const internal: UpdateInternal = { reportReason: "phonecheck" };
  const match = matchModel(pcDeviceReport(rec), refs);
  if (!v.device && match.modelId && !ai) {
    patch.modelId = match.modelId;
    internal.modelSource = "phonecheck";
  }
  const modelId = patch.modelId ?? v.device?.modelId ?? null;
  if (!ai && modelId && modelId === match.modelId && !v.device?.variant && rec.variant) {
    const sizes = refs.find((m) => m.id === modelId)?.variants ?? [];
    if (sizes.includes(rec.variant)) {
      patch.variant = rec.variant;
      internal.variantSource = "measured";
    } else if (!v.measuredStorage) internal.measuredStorage = rec.variant;
  }

  const before = { case_id: row.case_id, attached_at: row.attached_at, attached_by: row.attached_by, attach_override: row.attach_override, store_id: row.store_id };
  await execute(
    `UPDATE phonecheck_records SET case_id = $1, attached_at = $2, attached_by = $3, attach_override = $4, store_id = COALESCE(store_id, $5), updated_at = $6 WHERE id = $7`,
    [caseId, nowIso(), u.name, override ? JSON.stringify(override) : null, v.storeId, nowIso(), row.id]
  );
  await recordFaultSources(caseId, addFaultSources(v.faultSources, pcFaults.map((id) => ({ id, source: "phonecheck" as const }))));
  let after: CaseView;
  try {
    after = await updateCase(u, caseId, patch, internal);
  } catch (e) {
    await execute(
      `UPDATE phonecheck_records SET case_id = $1, attached_at = $2, attached_by = $3, attach_override = $4, store_id = $5 WHERE id = $6`,
      [before.case_id, before.attached_at, before.attached_by, before.attach_override, before.store_id, row.id]
    );
    throw e;
  }
  await audit({
    userId: u.id,
    orgId: v.orgId,
    storeId: v.storeId,
    action: "phonecheck.attach",
    entity: "case",
    entityId: caseId,
    detail: {
      record: row.id,
      source: row.source,
      aiRead: rec.aiRead,
      reportNo: rec.reportId,
      imei: maskImei(rec.imei),
      faults: pcFaults,
      model: patch.modelId ?? null,
      variant: patch.variant ?? null,
      ...(override ? { imeiOverride: override.reason } : {}),
    },
  });
  const updatedRow = (await rowById(row.id))!;
  return { case: after, record: await summaryOf(updatedRow) };
}

/* ─────────────────────────── what the counter calls ─────────────────────────── */

export type CasePhonecheckResult = {
  case: CaseView;
  record: PcSummary | null;
  outcome: "attached" | "not_found" | "stale";
  note: string | null;
  extracted?: Record<string, unknown>;
};

function newest(recs: PcRecord[]): PcRecord {
  return [...recs].sort((a, b) => (Date.parse(b.testedAt ?? "") || 0) - (Date.parse(a.testedAt ?? "") || 0))[0];
}

export async function pullForCase(u: SessionUser, caseId: string, input: { imei?: unknown } = {}): Promise<CasePhonecheckResult> {
  const v = await openCase(u, caseId);
  let imei: string | null = v.imei ?? v.imei2;
  if (input.imei !== undefined && input.imei !== null && input.imei !== "") {
    const r = readImei(String(input.imei));
    if (!r.ok) throw new HttpError(400, r.reason);
    imei = r.imei;
  }
  const state = await pullState({ storeId: v.storeId, status: v.status, imei, imei2: null });
  if (!state.canPull) throw new HttpError(409, state.why ?? "Phonecheck can't be asked for this case.");
  const station = (await stationFor(v.storeId)).station!;
  throttle(pulls, caseId, PULL_GAP_MS, PULLS_PER_DAY, "Phonecheck look-up");
  let got: Awaited<ReturnType<typeof fetchByImei>>;
  try {
    got = await fetchByImei(imei!, station);
  } catch (e) {
    await audit({ userId: u.id, orgId: v.orgId, storeId: v.storeId, action: "phonecheck.pull", entity: "case", entityId: caseId, detail: { imei: maskImei(imei!), outcome: "error", why: e instanceof Error ? e.message : String(e) } });
    throw asHttp(e);
  }
  if ("notFound" in got) {
    await audit({ userId: u.id, orgId: v.orgId, storeId: v.storeId, action: "phonecheck.pull", entity: "case", entityId: caseId, detail: { imei: maskImei(imei!), outcome: "not_found" } });
    return { case: v, record: null, outcome: "not_found", note: "No Phonecheck test for this IMEI — test it on the station." };
  }
  const tz = phonecheckConfig().tz;
  const parsed: { rec: PcRecord; raw: unknown }[] = [];
  const rejected: string[] = [];
  for (const raw of got.rows) {
    const r = readPhonecheck(raw, { tz });
    if (r.ok) parsed.push({ rec: r.record, raw });
    else rejected.push(r.reason);
  }
  if (!parsed.length) throw new HttpError(502, `Phonecheck sent a record SwapUp couldn't read: ${rejected[0] ?? "no device record"}`);
  const stored = await Promise.all(parsed.map(async (p) => ({ ...(await storeRecord(p.rec, p.raw, "pull", v.storeId)), rec: p.rec })));
  const best = newest(parsed.map((p) => p.rec));
  const pick = stored.find((x) => x.rec.key === best.key)!;
  await audit({ userId: u.id, orgId: v.orgId, storeId: v.storeId, action: "phonecheck.pull", entity: "case", entityId: caseId, detail: { imei: maskImei(imei!), outcome: pick.outcome, records: parsed.length, rejected: rejected.length } });
  if (pick.outcome === "stale" && pick.row.case_id === caseId && pick.row.attached_at)
    return { case: await getCase(u, caseId), record: await summaryOf(pick.row), outcome: "stale", note: "Nothing new: this Phonecheck check is already on the case." };
  const out = await attachRecord(u, caseId, pick.row.id);
  return { ...out, outcome: "attached", note: null };
}

export async function uploadForCase(u: SessionUser, caseId: string, body: unknown, opts: AttachOpts = {}): Promise<CasePhonecheckResult> {
  const v = await openCase(u, caseId);
  const raws = unwrapPhonecheck(body);
  if (!raws.length) throw new HttpError(400, "Not a Phonecheck record — upload its JSON, PDF or photo.");
  const tz = phonecheckConfig().tz;
  const parsed: { rec: PcRecord; raw: unknown }[] = [];
  let firstReason: string | null = null;
  for (const raw of raws) {
    const r = readPhonecheck(raw, { tz });
    if (r.ok) parsed.push({ rec: r.record, raw });
    else firstReason ??= r.reason;
  }
  if (!parsed.length) throw new HttpError(400, firstReason ?? "That is not a Phonecheck record.");
  const caseImeis = [v.imei, v.imei2].filter(Boolean);
  const mine = parsed.filter((p) => caseImeis.includes(p.rec.imei) || (!!p.rec.imei2 && caseImeis.includes(p.rec.imei2)));
  const best = newest((mine.length ? mine : parsed).map((p) => p.rec));
  const chosen = parsed.find((p) => p.rec.key === best.key)!;
  const { row, outcome } = await storeRecord(chosen.rec, chosen.raw, "upload", v.storeId);
  await audit({ userId: u.id, orgId: v.orgId, storeId: v.storeId, action: "phonecheck.upload", entity: "case", entityId: caseId, detail: { imei: maskImei(chosen.rec.imei), outcome, records: parsed.length } });
  const out = await attachRecord(u, caseId, row.id, opts);
  return {
    ...out,
    outcome: "attached",
    note:
      outcome === "fetched_copy"
        ? "Phonecheck's own copy was already here — that one is used."
        : outcome === "stale"
          ? "Not used: this check is already on file."
          : null,
  };
}

export async function uploadFileForCase(
  u: SessionUser,
  caseId: string,
  file: { bytes: Uint8Array; mime: string | null; name: string | null },
  opts: AttachOpts = {}
): Promise<CasePhonecheckResult> {
  const v = await openCase(u, caseId);
  const ok = checkPcUpload(file.mime, file.bytes);
  if (!ok.ok) throw new HttpError(file.bytes.length > PC_UPLOAD_MAX_BYTES ? 413 : 400, ok.reason);
  const ready = aiReaderConfigured();
  if (!ready.ok) throw new HttpError(503, ready.why);
  throttle(aiReads, caseId, AI_GAP_MS, AI_READS_PER_DAY, "AI report read");
  const read = await readReportFile(file.bytes, file.mime);
  const r = readPhonecheck(read.raw, { tz: phonecheckConfig().tz, aiRead: true });
  if (!r.ok) throw new HttpError(422, `AI reading unusable: ${r.reason}`);
  const raw = { readBy: "ai", model: read.model, file: { mime: read.mime, bytes: file.bytes.length, name: (file.name ?? "").slice(0, 80) || null }, extracted: read.raw };
  const { row, outcome } = await storeRecord(r.record, raw, "upload", v.storeId);
  await audit({ userId: u.id, orgId: v.orgId, storeId: v.storeId, action: "phonecheck.upload", entity: "case", entityId: caseId, detail: { imei: maskImei(r.record.imei), outcome, ai: read.model, mime: read.mime } });
  const out = await attachRecord(u, caseId, row.id, opts);
  const lacks = [!out.case.device ? "model" : null, !out.case.device?.variant ? "storage" : null, !out.case.imei ? "IMEI" : null].filter((x): x is string => !!x);
  const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  return {
    ...out,
    outcome: "attached",
    note:
      outcome === "fetched_copy"
        ? "Phonecheck's own copy was already here — that one is used."
        : outcome === "stale"
          ? "Not used: this check is already on file."
          : `Read by AI — check the figures.${lacks.length ? ` Enter the ${and(lacks)} yourself.` : ""}`,
    extracted: read.raw,
  };
}

export async function attachForCase(u: SessionUser, caseId: string, recordId: unknown, opts: AttachOpts): Promise<CasePhonecheckResult> {
  if (typeof recordId !== "string" || !/^pc_[A-Za-z0-9_-]{8,40}$/.test(recordId)) throw new HttpError(400, "Say which Phonecheck record to attach.");
  const out = await attachRecord(u, caseId, recordId, opts);
  return { ...out, outcome: "attached", note: null };
}

export async function phonecheckForCase(u: SessionUser, caseId: string) {
  requireCounter(u);
  const v = await getCase(u, caseId);
  const imeis = [v.imei, v.imei2].filter((x): x is string => !!x);
  const rows = await query<PcRow>(
    `SELECT * FROM phonecheck_records
     WHERE (case_id = $1 ${imeis.length ? `OR imei = ANY($2::text[]) OR imei2 = ANY($2::text[])` : ""}) AND (store_id IS NULL OR store_id = $3)
     ORDER BY COALESCE(tested_at, received_at) DESC LIMIT 20`,
    imeis.length ? [caseId, imeis, v.storeId] : [caseId, v.storeId]
  );
  const st = await stationFor(v.storeId);
  const pull = await pullState({ storeId: v.storeId, status: v.status, imei: v.imei, imei2: v.imei2 });
  const records = await Promise.all(rows.map(summaryOf));
  return {
    configured: phonecheckConfigured(),
    station: st.station,
    stationFrom: st.from,
    ...pull,
    aiReader: aiReaderConfigured(),
    records,
  };
}

/* ─────────────────────────── the webhook ─────────────────────────── */

export const WEBHOOK_MAX_BYTES = 512 * 1024;
const digest = (s: string) => createHash("sha256").update(s).digest();

export function webhookAuth(headers: Headers): { ok: true } | { ok: false; status: 503 | 401; error: string } {
  const secret = phonecheckConfig().webhookSecret;
  if (!secret || secret.length < 24) return { ok: false, status: 503, error: "The Phonecheck webhook is not set up on this server (PHONECHECK_WEBHOOK_SECRET)." };
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") || "")?.[1];
  const given = headers.get("x-pc-secret") ?? bearer ?? "";
  if (!given || !timingSafeEqual(digest(given), digest(secret))) return { ok: false, status: 401, error: "Wrong or missing webhook secret." };
  return { ok: true };
}

export function readWebhookBody(text: string, contentType: string | null): unknown {
  const t = text.trim();
  if (/json/i.test(contentType ?? "") || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      throw new HttpError(400, "The webhook body is not valid JSON.");
    }
  }
  const form = Object.fromEntries(new URLSearchParams(t));
  for (const k of Object.keys(form)) {
    const v = form[k].trim();
    if ((v.startsWith("{") || v.startsWith("[")) && Object.keys(form).length <= 3) {
      try {
        return JSON.parse(v);
      } catch {
        /* a field that only looks like JSON */
      }
    }
  }
  return form;
}

async function storeForStation(station: string | null): Promise<string | null> {
  if (!station) return null;
  const rows = await query<{ id: string }>(
    `SELECT id FROM stores WHERE (settings::jsonb #>> '{phonecheck,station}') ILIKE $1 LIMIT 2`,
    [station]
  );
  return rows.length === 1 ? rows[0].id : null;
}

export async function receiveWebhook(body: unknown): Promise<{ ok: true; received: number; stored: number; stale: number; rejected: { reason: string }[] }> {
  const raws = unwrapPhonecheck(body);
  const tz = phonecheckConfig().tz;
  let stored = 0;
  let stale = 0;
  const rejected: { reason: string }[] = [];
  const touched = new Set<string>();
  for (const raw of raws) {
    const r = readPhonecheck(raw, { tz });
    if (!r.ok) {
      rejected.push({ reason: r.reason });
      continue;
    }
    const storeId = await storeForStation(r.record.station);
    const out = await storeRecord(r.record, raw, "webhook", storeId);
    if (out.outcome === "insert" || out.outcome === "replace") stored++;
    else stale++;
    if (out.outcome === "replace" && out.row.case_id && out.row.attached_at) touched.add(out.row.case_id);
  }
  for (const caseId of touched) await issueIfChanged(caseId, "phonecheck", null);
  await audit({ action: "phonecheck.webhook", entity: "phonecheck", detail: { received: raws.length, stored, stale, rejected: rejected.length } });
  return { ok: true, received: raws.length, stored, stale, rejected };
}

/* ─────────────────────────── the store's station ─────────────────────────── */

const STATION_RE = /^[A-Za-z0-9._@ +-]{2,60}$/;

export async function getStorePhonecheck(u: SessionUser, storeId: string) {
  const store = await storeInScope(u, storeId);
  if (u.role === "partner") throw new HttpError(404, "Store not found.");
  return stationView(store);
}

async function stationView(store: StoreRow) {
  const settings = await storeSettings(store.id);
  const own = settings.phonecheck?.station ?? null;
  return { station: own, serverDefault: !!phonecheckConfig().username, configured: phonecheckConfigured() };
}

export async function setStorePhonecheck(u: SessionUser, storeId: string, raw: unknown) {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only the store manager can change the store's Phonecheck station.");
  const store = await storeInScope(u, storeId);
  const v = (raw ?? {}) as { station?: unknown };
  let station: string | null = null;
  if (v.station !== null && v.station !== undefined && v.station !== "") {
    if (typeof v.station !== "string" || !STATION_RE.test(v.station.trim()))
      throw new HttpError(400, "Station login: 2–60 letters, digits or . _ - @ (not the master account).");
    station = v.station.trim();
  }
  const row = await queryOne<{ settings: string }>(`SELECT settings FROM stores WHERE id = $1`, [store.id]);
  const settings = { ...parseJson<Record<string, unknown>>(row?.settings, {}), phonecheck: station ? { station } : null };
  await execute(`UPDATE stores SET settings = $1 WHERE id = $2`, [JSON.stringify(settings), store.id]);
  await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "store.phonecheck", entity: "store", entityId: store.id, detail: { station } });
  return stationView(store);
}
