import { db, tx, nowIso, todayIso, newId, nextSeq, parseJson, audit } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { getOrg, getStore, ownStore, storeInScope, canSeeStore, orgPartnerId, type StoreRow } from "./scope";
import { partnerQuote, partnerMode, type PartnerQuote, type PartnerMode } from "./buyback";
import { storeEvents, storePolicy, postEvents } from "./credit";
import { activeCampaigns, newDevices } from "./catalog";
import { caseMarketSell, type CaseMarketSell } from "./marketPrices";
import {
  type ConditionAnswers,
  type FaultId,
  isFaultId,
  conditionFloor,
  conditionFromFaults,
  healedCondition,
  SCREEN_ORDER,
  BODY_ORDER,
  ISSUE_LABEL,
  type IssueId,
  type AgeBand,
} from "../domain/condition";
import { estimateRepair, type Coverage, type ManualQuote, type RepairEstimate, type RepairBookEntry } from "../domain/repair";
import { bestCampaign, type BonusResult, type Campaign } from "../domain/bonus";
import { decide, type Decision } from "../domain/decision";
import { suggestUpgrade, UPGRADE_RULE_VERSION } from "../domain/upgrade";
import { buildOffer, expiredQuoteBlocker, type Offer, type StorageQuote, type VariantSource } from "../domain/offer";
import { storageOnSave } from "../domain/phoneLed";
import { canHold } from "../domain/credit";
import { readImei } from "../domain/imei";
import { indianMobile } from "../domain/phone";
import { type CaseStatus, assertTransition, OPEN_TRADE_STATUSES, cancelEvents } from "../domain/lifecycle";
import { DATA_CLEAR_LABEL, DATA_CLEAR_STATUSES, DATA_CLEAR_STEPS, dataClearState, missingDataClearSteps, type DataClearRecord, type DataClearState } from "../domain/dataClear";
import {
  type CaseCameraCheck,
  type FaultSources,
  type RecordedOverride,
  applyCameraFloor,
  blankCameraCheck,
  cameraOverrideProblems,
  identityBlock,
  reconcileFaultSources,
} from "../domain/gradeiqMap";

/* ─────────────────────────── types ─────────────────────────── */

export type Customer = { name: string; phone: string; idType: string | null; idLast4: string | null };

/** Result of the government IMEI register check (Sanchar Saathi / CEIR "Know Your Mobile"). */
export type KymStatus = "clear" | "blacklisted" | "duplicate" | "in_use";
export const KYM_LABEL: Record<KymStatus, string> = {
  clear: "No block — OK to buy",
  blacklisted: "Black-listed (reported lost/stolen)",
  duplicate: "Duplicate IMEI",
  in_use: "Already in use",
};

export type Checks = {
  ownership: boolean;
  /** Older cases only: the reset used to be ticked at hand-over. It is now its own step after acceptance (dataClear). */
  factoryReset?: boolean;
  accountsRemoved?: boolean;
  simRemoved: boolean;
  imeiMatches: boolean;
  noFinanceLock: boolean;
  kym: { status: KymStatus; reference: string | null };
  imeiCheckAck?: boolean;
  /** The storage was the customer's claim, and the advisor saw it in Settings › About phone. */
  storageSeen?: boolean;
  at: string;
  by: string;
};

export type UpgradeChoice = {
  deviceId: string;
  label: string;
  model: string;
  series: string;
  variant: string;
  price: number;
  supportEndYear: number | null;
  /** true = SwapUp suggested it (lib/domain/upgrade.ts); false/absent = staff chose it, and it stands. */
  suggested?: boolean;
  /** The suggestion's one-sentence reason, e.g. "Newest Galaxy S Ultra, same storage (256GB)." */
  why?: string;
  /** UPGRADE_RULE_VERSION when suggested. */
  rule?: string;
};

export type BonusApplied = BonusResult & {
  campaignName: string;
  override: { bp: number; amount: number; reason: string; by: string } | null;
};

export type TradeModel = {
  id: string;
  brand: string;
  model: string;
  series: string | null;
  release_year: number | null;
  support_end_year: number | null;
  variants: string;
  service_tier: string;
  care_plus_fee: number | null;
};

/** A quote the advisor read off the partner's own app, with its reference code. */
export type PartnerManual = { amount: number; reference: string; validUntil: string; repairedAmount: number | null; by: string; at: string };

type CaseRow = {
  id: string;
  ref: string;
  org_id: string;
  store_id: string;
  advisor_id: string;
  status: CaseStatus;
  customer: string | null;
  model_id: string | null;
  variant: string | null;
  imei: string | null;
  imei_check: string | null;
  imei2: string | null;
  imei2_check: string | null;
  closed_reason: string | null;
  faults: string;
  coverage: Coverage;
  condition: string | null;
  manual_repair: string | null;
  partner_manual: string | null;
  repair: string | null;
  quote: string | null;
  repaired_quote: string | null;
  upgrade: string | null;
  bonus: string | null;
  decision: string | null;
  checks: string | null;
  trade_value: number | null;
  bonus_value: number | null;
  payable: number | null;
  pickup_id: string | null;
  clearance: string | null;
  settled_at: string | null;
  demo: number;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  closed_at: string | null;
  fault_sources: string;
  camera_check: string | null;
  data_clear: string | null;
  refurb_cost: string | null;
  variant_source: string | null;
  storage_quotes: string | null;
  measured_storage: string | null;
};

/** The store's own cost to put the phone right (BUY vs SELL). Not the customer's repair price. */
export type RefurbCost = { amount: number; by: string; at: string };

export type Clearance = { outcome: string; accepted: number; shortfall: number; reason: string | null; by: string; at: string };

export type CaseView = {
  id: string;
  ref: string;
  status: CaseStatus;
  orgId: string;
  storeId: string;
  storeName: string;
  storeCode: string;
  advisorId: string;
  advisorName: string | null;
  customer: Customer | null;
  device: { modelId: string; brand: string; model: string; series: string | null; variant: string | null; releaseYear: number | null; supportEndYear: number | null; ageYears: number | null } | null;
  imei: string | null;
  imeiCheck: "valid" | "invalid" | null;
  /** Second IMEI on a dual-SIM phone, when recorded. */
  imei2: string | null;
  imei2Check: "valid" | "invalid" | null;
  closedReason: string | null;
  faults: FaultId[];
  /** Where each fault came from: the phone's own test, the customer, the store camera (GradeIQ), the advisor. */
  faultSources: FaultSources;
  coverage: Coverage;
  condition: ConditionAnswers | null;
  conditionProblems: string[];
  /**
   * What the store camera saw, written when a SwapUp Check session is applied. null = never camera-checked.
   * The GradeIQ session id is kept on the row but never in a view: partners read cases, and that id is
   * the only key to GradeIQ's anonymous writes (contract §5 #1).
   */
  camera: Omit<CaseCameraCheck, "gradeiqId"> | null;
  /** Why there is no trade-in quote although the phone is described (the camera's identity check). */
  quoteBlocked: string | null;
  manualRepair: ManualQuote | null;
  /** The store's refurb cost quote (BUY vs SELL) — never read by the advice, the bonus or the partner quote. */
  refurbCost: RefurbCost | null;
  /** SELL: what the phone sells for refurbished — PriceIQ's Cashify listing less 2–5% (lib/domain/marketSell.ts). */
  marketSell: CaseMarketSell;
  partnerManual: PartnerManual | null;
  /** The centre does not repair this brand — only an outside quote can be compared. */
  repairNotServiced: string | null;
  repair: RepairEstimate | null;
  quote: PartnerQuote | null;
  quoteExpired: boolean;
  repairedQuote: PartnerQuote | null;
  upgrade: UpgradeChoice | null;
  bonus: BonusApplied | null;
  decision: Decision | null;
  checks: Checks | null;
  tradeValue: number | null;
  bonusValue: number | null;
  payable: number | null;
  pickupId: string | null;
  clearance: Clearance | null;
  settledAt: string | null;
  demo: boolean;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  closedAt: string | null;
  partner: PartnerMode | null;
  /** Live credit check for locking THIS trade-in at THIS store, when it is lockable. */
  creditCheck: ReturnType<typeof canHold> | null;
  /** Why the trade-in cannot be locked yet (empty = it can). */
  lockBlockers: string[];
  /** The customer's factory reset after acceptance, as the store saw it. */
  dataClear: DataClearRecord | null;
  dataClearState: DataClearState;
  /** Where the storage came from: the phone's measurement, the catalogue's only size, the customer's claim, or staff. */
  variantSource: VariantSource | null;
  /**
   * The size the phone read off its own disk at Apply, whatever the model's list says (null = it
   * didn't measure). When it isn't on the list (a 1TB Ultra on file as 256/512GB) the storage stays
   * empty, and a Cashify quote entered for the phone settles it at this size (updateCase).
   */
  measuredStorage: string | null;
  /** THE ANSWER — refurb quote vs trade-in + bonus, and the one thing still missing (lib/domain/offer.ts). null for the partner. */
  offer: Offer | null;
};

/* ─────────────────────────── reads ─────────────────────────── */

function row(id: string): CaseRow | null {
  return (db().prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as CaseRow | undefined) ?? null;
}

export function getTradeModel(id: string | null): TradeModel | null {
  if (!id) return null;
  return (db().prepare(`SELECT * FROM trade_models WHERE id = ?`).get(id) as TradeModel | undefined) ?? null;
}

/** The buyback partner sees a case only once it became a trade-in it will collect. */
export const PARTNER_HIDDEN_STATUSES: CaseStatus[] = ["draft", "quoted", "repair_chosen", "walked_away", "cancelled"];

function caseInScope(u: SessionUser, id: string): { c: CaseRow; store: StoreRow } {
  const c = row(id);
  if (!c) throw new HttpError(404, "Case not found.");
  const store = getStore(c.store_id);
  if (!store || !canSeeStore(u, store)) throw new HttpError(404, "Case not found.");
  // A customer still at the counter (or one who never traded in) is not the
  // partner's business — same rule as listCases, enforced on every read path.
  if (u.role === "partner" && PARTNER_HIDDEN_STATUSES.includes(c.status)) throw new HttpError(404, "Case not found.");
  return { c, store };
}

function thisYear(): number {
  return new Date().getUTCFullYear();
}

function withoutGradeiqId(c: CaseCameraCheck): Omit<CaseCameraCheck, "gradeiqId"> {
  const { gradeiqId: _gradeiqId, ...rest } = c;
  return rest;
}

const VARIANT_SOURCES = new Set<string>(["measured", "catalogue", "customer", "advisor"]);
const readVariantSource = (s: string | null): VariantSource | null => (s && VARIANT_SOURCES.has(s) ? (s as VariantSource) : null);

function toView(c: CaseRow, store: StoreRow): CaseView {
  const tm = getTradeModel(c.model_id);
  const advisor = db().prepare(`SELECT name FROM users WHERE id = ?`).get(c.advisor_id) as { name: string } | undefined;
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const quote = parseJson<PartnerQuote | null>(c.quote, null);
  const quoteExpired = !!quote?.validUntil && Date.parse(quote.validUntil) < Date.now();
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  const org = getOrg(c.org_id);
  const partner = org?.partner_id ? partnerMode(org.partner_id) : null;
  const view: CaseView = {
    id: c.id,
    ref: c.ref,
    status: c.status,
    orgId: c.org_id,
    storeId: c.store_id,
    storeName: store.name,
    storeCode: store.code,
    advisorId: c.advisor_id,
    advisorName: advisor?.name ?? null,
    customer: parseJson<Customer | null>(c.customer, null),
    device: tm
      ? {
          modelId: tm.id,
          brand: tm.brand,
          model: tm.model,
          series: tm.series,
          variant: c.variant,
          releaseYear: tm.release_year,
          supportEndYear: tm.support_end_year,
          ageYears: tm.release_year ? Math.max(0, thisYear() - tm.release_year) : null,
        }
      : null,
    imei: c.imei,
    imeiCheck: (c.imei_check as "valid" | "invalid" | null) ?? null,
    imei2: c.imei2,
    imei2Check: (c.imei2_check as "valid" | "invalid" | null) ?? null,
    closedReason: c.closed_reason,
    faults,
    faultSources: reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults),
    coverage: c.coverage,
    condition,
    conditionProblems: condition ? conditionFloor(condition, faults) : [],
    camera: camera ? withoutGradeiqId(camera) : null,
    quoteBlocked: identityBlock(camera),
    manualRepair: parseJson<ManualQuote | null>(c.manual_repair, null),
    refurbCost: parseJson<RefurbCost | null>(c.refurb_cost, null),
    marketSell: caseMarketSell({ modelId: tm?.id ?? null, variant: c.variant, model: tm?.model ?? null, condition }),
    partnerManual: parseJson<PartnerManual | null>(c.partner_manual, null),
    repairNotServiced: tm && org?.target_brand && tm.brand !== org.target_brand ? `This centre repairs ${org.target_brand} phones only. Enter the customer's own repair quote to compare.` : null,
    repair: parseJson<RepairEstimate | null>(c.repair, null),
    quote,
    quoteExpired,
    repairedQuote: parseJson<PartnerQuote | null>(c.repaired_quote, null),
    upgrade: parseJson<UpgradeChoice | null>(c.upgrade, null),
    bonus: parseJson<BonusApplied | null>(c.bonus, null),
    decision: parseJson<Decision | null>(c.decision, null),
    checks: parseJson<Checks | null>(c.checks, null),
    tradeValue: c.trade_value,
    bonusValue: c.bonus_value,
    payable: c.payable,
    pickupId: c.pickup_id,
    clearance: parseJson<Clearance | null>(c.clearance, null),
    settledAt: c.settled_at,
    demo: !!c.demo,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    lockedAt: c.locked_at,
    closedAt: c.closed_at,
    partner,
    creditCheck: null,
    lockBlockers: [],
    dataClear: parseJson<DataClearRecord | null>(c.data_clear, null),
    dataClearState: "not_applicable",
    variantSource: c.variant ? readVariantSource(c.variant_source) : null,
    measuredStorage: c.measured_storage ?? null,
    offer: null,
  };
  const legacyChecks = parseJson<Checks | null>(c.checks, null);
  view.dataClearState = dataClearState(c.status, view.dataClear, legacyChecks?.factoryReset === true);
  if (c.status === "quoted") {
    view.lockBlockers = lockBlockers(view, !!org?.demo);
    if (view.quoteBlocked) view.lockBlockers.unshift(view.quoteBlocked);
    // A store that registered itself has no credit line until the programme approves it.
    if (store.status === "pending")
      view.lockBlockers.unshift(`This store is waiting for approval from ${org?.name ?? "the programme"}. Phone tests and quotes work; taking trade-ins starts once it is approved and given a credit line.`);
    if (store.status === "rejected") view.lockBlockers.unshift("This store is closed in SwapUp, so it can't take trade-ins.");
    if (quote?.status === "priced" && quote.amount) {
      view.creditCheck = canHold(storePolicy(store), storeEvents(store.id), quote.amount);
      if (!view.creditCheck.ok) view.lockBlockers.push(view.creditCheck.reason);
    }
  }
  // The answer is worked out for every status; `open` says whether it can still be acted on.
  // With no new phone on an open case, ask the suggestion rule whether the catalogue HAS one,
  // so the ask never says "nothing matches" after staff cleared it or on a desk-only case.
  const newPhoneMatch =
    tm && !view.upgrade && EDITABLE.includes(c.status)
      ? suggestUpgrade({ brand: tm.brand, model: tm.model, series: tm.series, variant: c.variant }, newDevices(store.org_id)) !== null
      : false;
  view.offer = buildOffer({
    status: c.status,
    device: tm ? { label: `${tm.brand} ${tm.model}`, variant: c.variant, variants: parseJson<string[]>(tm.variants, []) } : null,
    variantSource: view.variantSource,
    measuredStorage: view.measuredStorage,
    storageQuotes: parseJson<StorageQuote[] | null>(c.storage_quotes, null),
    faultCount: faults.length,
    coverage: c.coverage,
    repair: view.repair,
    manualRepair: view.manualRepair,
    repairNotServiced: view.repairNotServiced,
    quote: view.quote,
    quoteExpired,
    quoteBlocked: view.quoteBlocked,
    conditionProblems: view.conditionProblems,
    hasCondition: !!condition,
    upgrade: view.upgrade,
    bonus: view.bonus,
    decision: view.decision,
    tested: !!camera,
    newPhoneMatch,
  });
  return view;
}

function lockBlockers(v: CaseView, orgIsDemo: boolean): string[] {
  const out: string[] = [];
  if (!v.device || !v.device.variant) out.push("Choose the phone's model and storage.");
  if (!v.imei) out.push("Record the IMEI (dial *#06#).");
  if (!v.condition) out.push("Answer the condition questions.");
  if (v.conditionProblems.length) out.push("The condition is recorded better than the faults allow.");
  if (!v.quote || v.quote.status !== "priced" || !v.quote.amount) out.push("No trade-in price from the partner.");
  // Re-quote fixes a rate-card or live quote; one read off the Cashify app needs today's from the app.
  else if (v.quoteExpired) out.push(expiredQuoteBlocker(v.quote));
  else if (v.quote.source.kind === "sample" && !orgIsDemo)
    out.push("This price comes from a SAMPLE rate card. Load the partner's rate card before taking a real trade-in.");
  if (!v.upgrade) out.push("Choose the new phone.");
  return out;
}

export function getCase(u: SessionUser, id: string): CaseView {
  const { c, store } = caseInScope(u, id);
  return toView(c, store);
}

export type CaseListItem = {
  id: string;
  ref: string;
  status: CaseStatus;
  storeId: string;
  storeName: string;
  customerName: string | null;
  device: string | null;
  imei: string | null;
  tradeValue: number | null;
  bonusValue: number | null;
  newDevice: string | null;
  recommendation: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  demo: boolean;
  dataClear: DataClearState;
};

export function listCases(
  u: SessionUser,
  opts: { storeId?: string | null; status?: CaseStatus[] | null; q?: string | null; limit?: number; pickupId?: string | null } = {}
): CaseListItem[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (u.role === "advisor" || u.role === "store_manager") {
    where.push("c.store_id = ?");
    args.push(u.storeId);
  } else if (u.role === "org_admin") {
    where.push("c.org_id = ?");
    args.push(u.orgId);
  } else if (u.role === "partner") {
    where.push("c.org_id IN (SELECT id FROM orgs WHERE kind = 'client' AND partner_id = ?)");
    args.push(u.orgId);
    where.push(`c.status NOT IN (${PARTNER_HIDDEN_STATUSES.map((x) => `'${x}'`).join(",")})`);
  }
  if (opts.storeId) {
    storeInScope(u, opts.storeId);
    where.push("c.store_id = ?");
    args.push(opts.storeId);
  }
  if (opts.pickupId) {
    where.push("c.pickup_id = ?");
    args.push(opts.pickupId);
  }
  if (opts.status?.length) {
    where.push(`c.status IN (${opts.status.map(() => "?").join(",")})`);
    args.push(...opts.status);
  }
  if (opts.q) {
    where.push("(c.ref LIKE ? OR c.imei LIKE ? OR c.customer LIKE ? OR t.model LIKE ?)");
    const like = `%${opts.q.trim()}%`;
    args.push(like, like, like, like);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db()
    .prepare(
      `SELECT c.*, s.name AS store_name, t.brand, t.model AS model_name
       FROM cases c JOIN stores s ON s.id = c.store_id LEFT JOIN trade_models t ON t.id = c.model_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY c.updated_at DESC LIMIT ${limit}`
    )
    .all(...args) as (CaseRow & { store_name: string; brand: string | null; model_name: string | null })[];
  return rows.map((r) => {
    const cust = parseJson<Customer | null>(r.customer, null);
    const up = parseJson<UpgradeChoice | null>(r.upgrade, null);
    const dec = parseJson<Decision | null>(r.decision, null);
    return {
      id: r.id,
      ref: r.ref,
      status: r.status,
      storeId: r.store_id,
      storeName: r.store_name,
      customerName: cust?.name ?? null,
      device: r.model_name ? `${r.brand} ${r.model_name}${r.variant ? " " + r.variant : ""}` : null,
      imei: r.imei,
      tradeValue: r.trade_value ?? parseJson<PartnerQuote | null>(r.quote, null)?.amount ?? null,
      bonusValue: r.bonus_value,
      newDevice: up?.label ?? null,
      recommendation: dec?.recommendation ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lockedAt: r.locked_at,
      demo: !!r.demo,
      dataClear: dataClearState(r.status, parseJson<DataClearRecord | null>(r.data_clear, null), parseJson<Checks | null>(r.checks, null)?.factoryReset === true),
    };
  });
}

/** Accepted phones still at this store whose data clearing is not recorded. */
export function dataClearDueIds(storeId: string): Set<string> {
  const rows = db()
    .prepare(
      `SELECT id FROM cases WHERE store_id = ? AND status IN (${DATA_CLEAR_STATUSES.map(() => "?").join(",")})
         AND data_clear IS NULL AND COALESCE(json_extract(checks, '$.factoryReset'), 0) != 1`
    )
    .all(storeId, ...DATA_CLEAR_STATUSES) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/* ─────────────────────────── writes ─────────────────────────── */

const COUNTER_ROLES = ["advisor", "store_manager"] as const;

/** "+91 98200 12345" → "9820012345", so the customer lookup by mobile finds it; anything else as typed digits. */
function storedMobile(raw: string | null | undefined): string {
  return indianMobile(raw) ?? digitsOnly(raw).slice(0, 10);
}

function requireCounter(u: SessionUser): void {
  if (!(COUNTER_ROLES as readonly string[]).includes(u.role)) throw new HttpError(403, "Only store staff work cases at the counter.");
}

export function createCase(u: SessionUser, input: { customerName?: string; customerPhone?: string; demo?: boolean; via?: "demo" | "counter" } = {}): CaseView {
  requireCounter(u);
  const store = ownStore(u);
  const id = newId("case");
  const ref = `SU-${store.code}-${String(nextSeq(`case:${store.id}`)).padStart(5, "0")}`;
  const now = nowIso();
  const customer =
    input.customerName || input.customerPhone
      ? JSON.stringify({ name: (input.customerName || "").trim().slice(0, 80), phone: storedMobile(input.customerPhone), idType: null, idLast4: null })
      : null;
  db()
    .prepare(
      `INSERT INTO cases (id, ref, org_id, store_id, advisor_id, status, customer, faults, coverage, demo, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,'[]','none',?,?,?)`
    )
    .run(id, ref, store.org_id, store.id, u.id, customer, input.demo ? 1 : 0, now, now);
  // A counter-QR case is opened by the customer, under a staff member's name: say so.
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "case.create", entity: "case", entityId: id, ...(input.via ? { detail: { via: input.via === "counter" ? "counter code (customer-started)" : "standing demo code" } } : {}) });
  return getCase(u, id);
}

const digitsOnly = (s?: string | null) => (s || "").replace(/\D/g, "");

/**
 * The store camera's word on a case and where each fault came from — written
 * by Apply on a SwapUp Check session, just before the case is updated and
 * re-priced (so an identity mismatch already blocks that re-price).
 */
export function recordCameraCheck(caseId: string, check: CaseCameraCheck, sources: FaultSources): void {
  db()
    .prepare(`UPDATE cases SET camera_check = ?, fault_sources = ?, updated_at = ? WHERE id = ? AND status IN ('draft','quoted')`)
    .run(JSON.stringify(check), JSON.stringify(sources), nowIso(), caseId);
}

/** Staff unlocked the camera without the customer's phone echoing: the case is marked "LCD not camera-checked" now, not only at Apply. */
export function markLcdOverride(caseId: string, info: { by: string; userId: string; reason: string; at: string; testSessionId: string }): void {
  // Only while the case is at the counter — a locked trade-in's record is not rewritten.
  const row0 = db().prepare(`SELECT camera_check FROM cases WHERE id = ? AND status IN ('draft','quoted')`).get(caseId) as { camera_check: string | null } | undefined;
  if (!row0) return;
  const prev = parseJson<CaseCameraCheck | null>(row0.camera_check, null) ?? { ...blankCameraCheck(info.at), testSessionId: info.testSessionId };
  const reason = `the camera was unlocked by ${info.by} before the customer's phone showed the patterns: ${info.reason}`;
  const flag = `LCD not camera-checked: ${reason}`;
  const next: CaseCameraCheck = {
    ...prev,
    lcdOverride: { by: info.by, reason: info.reason, at: info.at },
    lcd: { ...prev.lcd, cameraChecked: false, reason },
    flags: [...prev.flags.filter((f) => !f.startsWith("LCD not camera-checked")), flag],
  };
  db().prepare(`UPDATE cases SET camera_check = ?, updated_at = ? WHERE id = ? AND status IN ('draft','quoted')`).run(JSON.stringify(next), nowIso(), caseId);
}

const SCREENS = new Set<string>(SCREEN_ORDER);
const BODIES = new Set<string>(BODY_ORDER);
const ISSUES = new Set<string>(Object.keys(ISSUE_LABEL));
const AGES = new Set<string>(["lt3m", "3to11m", "gt11m"]);

function cleanCondition(raw: unknown): ConditionAnswers {
  const a = (raw ?? {}) as Partial<ConditionAnswers> & { accessories?: Partial<ConditionAnswers["accessories"]> };
  if (!SCREENS.has(String(a.screen))) throw new HttpError(400, "Choose the screen condition.");
  if (!BODIES.has(String(a.body))) throw new HttpError(400, "Choose the body condition.");
  if (!AGES.has(String(a.age))) throw new HttpError(400, "Choose how old the phone is.");
  const issues = Array.isArray(a.issues) ? [...new Set(a.issues.map(String).filter((i) => ISSUES.has(i)))].sort() : [];
  return {
    powersOn: a.powersOn !== false,
    calls: a.calls !== false,
    screen: a.screen as ConditionAnswers["screen"],
    body: a.body as ConditionAnswers["body"],
    issues: issues as IssueId[],
    accessories: { charger: !!a.accessories?.charger, box: !!a.accessories?.box, bill: !!a.accessories?.bill },
    age: a.age as AgeBand,
  };
}

export type CasePatch = {
  modelId?: string | null;
  variant?: string | null;
  imei?: string | null;
  /** Second IMEI (dual-SIM). */
  imei2?: string | null;
  faults?: string[];
  coverage?: Coverage;
  condition?: unknown;
  /** Fill condition from the faults (keeps accessories/age). */
  conditionFromFaults?: boolean;
  customer?: { name?: string; phone?: string } | null;
  manualRepair?: { amount: number; reason: string } | null;
  /** The store's refurb cost (BUY vs SELL). Changes no price: the partner is not re-asked. */
  refurbCost?: { amount: number } | null;
  /** The partner's quote read off its own app (amount + reference code). */
  partnerQuote?: { amount: number; reference: string; validDays?: number; repairedAmount?: number | null } | null;
  upgradeDeviceId?: string | null;
  /**
   * Record the phone as BETTER than the store camera confirmed (remove a fault
   * it found, or a better screen/body answer): a reason is required and the
   * advisor's name is stored with it. `identity: true` — a store manager
   * accepts the phone despite the camera's identity mismatch.
   */
  cameraOverride?: { reason?: string; identity?: boolean } | null;
};

const EDITABLE: CaseStatus[] = ["draft", "quoted"];

/**
 * What only the server's own callers may say about a change — never the public
 * PATCH route, so staff can't record their own storage as "measured".
 *   variantSource    where patch.variant came from (Apply: the phone measured it,
 *                    the model has one size, or the customer typed it). Default "advisor".
 *   autoUpgrade      suggest the new phone (Apply), unless staff already chose one.
 *   measuredStorage  the size the phone read off its own disk (Apply), or null when
 *                    it didn't measure. Left out = unchanged.
 */
export type UpdateInternal = { variantSource?: "measured" | "catalogue" | "customer"; autoUpgrade?: boolean; measuredStorage?: string | null };

/**
 * Save what the advisor has learned about the device, then re-price.
 * Partner calls happen OUTSIDE any transaction.
 */
export async function updateCase(u: SessionUser, id: string, patch: CasePatch, internal: UpdateInternal = {}): Promise<CaseView> {
  requireCounter(u);
  const { c, store } = caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) throw new HttpError(409, "This case is past the counter and can no longer be edited.");

  const sets: Record<string, unknown> = {};
  let pricingChanged = false;

  if (patch.modelId !== undefined) {
    const tm = patch.modelId ? getTradeModel(patch.modelId) : null;
    if (patch.modelId && !tm) throw new HttpError(400, "Unknown model.");
    sets.model_id = tm?.id ?? null;
    if (tm?.id !== c.model_id) {
      sets.variant = null;
      sets.variant_source = null;
    }
    pricingChanged = true;
  }
  const modelChanged = "model_id" in sets && sets.model_id !== c.model_id;
  let variantChanged = false;
  if (patch.variant !== undefined) {
    const tm = getTradeModel((sets.model_id as string | undefined) ?? c.model_id);
    const variants = tm ? parseJson<string[]>(tm.variants, []) : [];
    if (patch.variant && !variants.includes(patch.variant)) throw new HttpError(400, "That storage variant does not exist for this model.");
    // Re-saving the size already there (the pressed chip tapped again) is no news: it keeps
    // the size's source and its quote. Only Apply's word may change the source of the same
    // size — a measurement upgrades the customer's claim (lib/domain/phoneLed.ts storageOnSave).
    const next = patch.variant || null;
    const s = storageOnSave({ next, prev: c.variant, prevSource: readVariantSource(c.variant_source), from: internal.variantSource, modelChanged });
    if (s.changed || internal.variantSource) {
      sets.variant = next;
      sets.variant_source = s.source;
      pricingChanged = true;
      variantChanged = s.changed;
    }
  }
  if (internal.measuredStorage !== undefined) sets.measured_storage = internal.measuredStorage;
  if (patch.imei !== undefined) {
    if (!patch.imei) {
      sets.imei = null;
      sets.imei_check = null;
    } else {
      const r = readImei(patch.imei);
      if (!r.ok) throw new HttpError(400, r.reason);
      sets.imei = r.imei;
      sets.imei_check = r.checkDigit;
    }
  }
  if (patch.imei2 !== undefined) {
    if (!patch.imei2) {
      sets.imei2 = null;
      sets.imei2_check = null;
    } else {
      const r = readImei(patch.imei2);
      if (!r.ok) throw new HttpError(400, r.reason.replace("IMEI", "second IMEI"));
      const first = (sets.imei as string | null | undefined) ?? c.imei;
      if (first && r.imei === first) throw new HttpError(400, "The second IMEI is the same as the first — a dual-SIM phone has two different numbers.");
      sets.imei2 = r.imei;
      sets.imei2_check = r.checkDigit;
    }
  }
  let faults = parseJson<FaultId[]>(c.faults, []);
  if (patch.faults !== undefined) {
    if (!Array.isArray(patch.faults)) throw new HttpError(400, "Faults must be a list.");
    const bad = patch.faults.filter((f) => !isFaultId(f));
    if (bad.length) throw new HttpError(400, `Unknown fault: ${bad[0]}`);
    faults = [...new Set(patch.faults as FaultId[])];
    sets.faults = JSON.stringify(faults);
    pricingChanged = true;
  }
  if (patch.coverage !== undefined) {
    if (!["none", "warranty", "care_plus"].includes(patch.coverage)) throw new HttpError(400, "Unknown cover.");
    // Cover moves only the repair price. The partner's quote reads model, storage,
    // condition and IMEI — re-asking would silently extend (or re-call) the trade-in.
    sets.coverage = patch.coverage;
  }
  if (patch.condition !== undefined) {
    sets.condition = patch.condition === null ? null : JSON.stringify(cleanCondition(patch.condition));
    pricingChanged = true;
  }
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  if (patch.conditionFromFaults) {
    const prev = parseJson<ConditionAnswers | null>((sets.condition as string | undefined) ?? c.condition, null);
    const base = prev ? { accessories: prev.accessories, age: prev.age } : { accessories: { charger: true, box: false, bill: false }, age: "gt11m" as const };
    // What the camera confirmed is part of what is known about the phone.
    const filled = conditionFromFaults(faults, base);
    sets.condition = JSON.stringify(camera ? applyCameraFloor(filled, camera.floor) : filled);
    pricingChanged = true;
  }
  if (patch.faults !== undefined) sets.fault_sources = JSON.stringify(reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults));
  // The camera only ever makes the phone worse. Recording it better than the
  // camera confirmed needs a reason, kept with the advisor's name.
  if (camera && (patch.faults !== undefined || patch.condition !== undefined || patch.conditionFromFaults || patch.cameraOverride)) {
    const answers = parseJson<ConditionAnswers | null>((sets.condition as string | undefined) ?? c.condition, null);
    const covered = new Set(camera.overrides.flatMap((o) => o.items));
    const problems = cameraOverrideProblems(answers, faults, camera).filter((p) => !covered.has(p.key));
    const reason = String(patch.cameraOverride?.reason ?? "").trim().slice(0, 300);
    const next: CaseCameraCheck = { ...camera, overrides: [...camera.overrides] };
    let changed = false;
    if (problems.length) {
      if (reason.length < 8) throw new HttpError(409, `${problems[0].why} Give the reason as an override, or keep the camera's answer.`);
      next.overrides.push({ by: u.name, userId: u.id, reason, at: nowIso(), items: problems.map((p) => p.key) });
      changed = true;
    }
    if (patch.cameraOverride?.identity && identityBlock(camera)) {
      if (u.role !== "store_manager") throw new HttpError(403, "Only the store manager can accept a phone the camera says is not the one on the case.");
      if (reason.length < 8) throw new HttpError(400, "Say how you checked that this is the right phone.");
      next.identityOverride = { by: u.name, userId: u.id, reason, at: nowIso(), items: ["identity"] } satisfies RecordedOverride;
      changed = true;
      pricingChanged = true;
    }
    if (changed) {
      sets.camera_check = JSON.stringify(next);
      audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.camera_override", entity: "case", entityId: id, detail: { reason, items: problems.map((p) => p.key), identity: !!next.identityOverride && !camera.identityOverride } });
    }
  }
  if (patch.customer !== undefined) {
    const prev = parseJson<Customer | null>(c.customer, null);
    sets.customer = patch.customer
      ? JSON.stringify({
          name: (patch.customer.name ?? prev?.name ?? "").trim().slice(0, 80),
          phone: storedMobile(patch.customer.phone ?? prev?.phone),
          idType: prev?.idType ?? null,
          idLast4: prev?.idLast4 ?? null,
        })
      : null;
  }
  if (patch.manualRepair !== undefined) {
    if (patch.manualRepair === null) sets.manual_repair = null;
    else {
      const amount = Number(patch.manualRepair.amount);
      const reason = String(patch.manualRepair.reason || "").trim();
      if (!Number.isInteger(amount) || amount < 0 || amount > 500_000) throw new HttpError(400, "Repair quote must be a whole rupee amount.");
      if (reason.length < 8) throw new HttpError(400, "Say where the repair quote comes from (e.g. the job-sheet number).");
      sets.manual_repair = JSON.stringify({ amount, reason, by: u.name } satisfies ManualQuote);
    }
    // The repair quote is the customer's, not the partner's: no re-quote (see cover above).
  }
  if (patch.refurbCost !== undefined) {
    if (patch.refurbCost === null) sets.refurb_cost = null;
    else {
      const amount = Number(patch.refurbCost.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 500_000) throw new HttpError(400, "Refurb cost must be a whole rupee amount up to ₹5,00,000.");
      sets.refurb_cost = JSON.stringify({ amount, by: u.name, at: nowIso() } satisfies RefurbCost);
    }
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.refurb_cost", entity: "case", entityId: id, detail: { amount: patch.refurbCost?.amount ?? null } });
  }
  // A partner quote read off its app describes ONE device in ONE condition. If
  // the description changes, that quote no longer belongs to this phone.
  const describes = patch.modelId !== undefined || variantChanged || patch.faults !== undefined || patch.condition !== undefined || patch.conditionFromFaults;
  if (describes && c.partner_manual) sets.partner_manual = null;
  if (patch.partnerQuote !== undefined) {
    if (patch.partnerQuote === null) sets.partner_manual = null;
    else {
      const amount = Number(patch.partnerQuote.amount);
      const reference = String(patch.partnerQuote.reference || "").trim().toUpperCase();
      const days = patch.partnerQuote.validDays === undefined ? 3 : Number(patch.partnerQuote.validDays);
      const rep = patch.partnerQuote.repairedAmount;
      const repairedAmount = rep === null || rep === undefined || (rep as unknown) === "" ? null : Number(rep);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 500_000) throw new HttpError(400, "Enter the partner's quote as a whole rupee amount.");
      if (!/^[A-Z0-9-]{4,40}$/.test(reference)) throw new HttpError(400, "Enter the reference code the partner's app shows for this quote.");
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, "Quote validity must be 1–30 days.");
      if (repairedAmount !== null && (!Number.isInteger(repairedAmount) || repairedAmount < amount))
        throw new HttpError(400, "The repaired value must be a whole rupee amount, at least the as-is quote.");
      sets.partner_manual = JSON.stringify({
        amount,
        reference,
        validUntil: new Date(Date.now() + days * 86_400_000).toISOString(),
        repairedAmount,
        by: u.name,
        at: nowIso(),
      } satisfies PartnerManual);
      // The phone measured a size the model's list doesn't have (a 1TB Ultra on file as
      // 256/512GB), so no chip could be right and the answer said: check Settings, and enter
      // the Cashify quote if it's really that size. The quote entered for it settles the
      // storage at the size the phone measured — the partner's app priced that phone.
      const size = "variant" in sets ? (sets.variant as string | null) : c.variant;
      const measured = "measured_storage" in sets ? (sets.measured_storage as string | null) : c.measured_storage;
      const tmNow = !size && measured ? getTradeModel("model_id" in sets ? (sets.model_id as string | null) : c.model_id) : null;
      if (tmNow && measured && !parseJson<string[]>(tmNow.variants, []).includes(measured)) {
        sets.variant = measured;
        sets.variant_source = "measured";
        variantChanged = true;
      }
    }
    pricingChanged = true;
  }
  if (patch.upgradeDeviceId !== undefined) {
    if (!patch.upgradeDeviceId) sets.upgrade = null;
    else {
      const d = db()
        .prepare(`SELECT * FROM new_devices WHERE id = ? AND org_id = ? AND active = 1`)
        .get(patch.upgradeDeviceId, store.org_id) as
        | { id: string; brand: string; model: string; series: string; variant: string; price: number; support_end_year: number | null }
        | undefined;
      if (!d) throw new HttpError(400, "That new phone is not in this programme's catalogue.");
      sets.upgrade = JSON.stringify({
        deviceId: d.id,
        label: `${d.brand} ${d.model} ${d.variant}`,
        model: d.model,
        series: d.series,
        variant: d.variant,
        price: d.price,
        supportEndYear: d.support_end_year,
        // Staff chose it: it stands across later storage and model changes.
        suggested: false,
      } satisfies UpgradeChoice);
    }
  }

  // The new phone SwapUp suggests (lib/domain/upgrade.ts) — at Apply, and again
  // whenever the phone's model or storage really changes on a case whose new
  // phone is still SwapUp's suggestion, or that has none yet (a desk-only case
  // given its model, a tested one that had no model at Apply): with no new phone
  // the swap can't be locked, so an empty case is never left waiting for one.
  // Staff's own choice always stands; their Clear stands until the phone itself
  // changes. A suggestion for another phone is cleared, never kept: no
  // suggestion is better than a wrong one.
  const prevUpgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
  const phoneChanged = modelChanged || variantChanged;
  const autoUpgrade = patch.upgradeDeviceId === undefined && (internal.autoUpgrade || phoneChanged) && (!prevUpgrade || prevUpgrade.suggested === true);
  if (autoUpgrade) {
    const tm = getTradeModel("model_id" in sets ? (sets.model_id as string | null) : c.model_id);
    // With no size on the case, the phone's own reading still says how big it is (a 1TB
    // Ultra is suggested against 1TB, not "storage unknown").
    const measured = "measured_storage" in sets ? (sets.measured_storage as string | null) : c.measured_storage;
    const variant = ("variant" in sets ? (sets.variant as string | null) : c.variant) ?? measured;
    const catalogue = newDevices(store.org_id);
    const s = tm ? suggestUpgrade({ brand: tm.brand, model: tm.model, series: tm.series, variant }, catalogue) : null;
    const d = s ? catalogue.find((x) => x.id === s.deviceId) : undefined;
    sets.upgrade =
      s && d
        ? JSON.stringify({
            deviceId: d.id,
            label: `${d.brand} ${d.model} ${d.variant}`,
            model: d.model,
            series: d.series,
            variant: d.variant,
            price: d.price,
            supportEndYear: d.supportEndYear,
            suggested: true,
            why: s.why,
            rule: UPGRADE_RULE_VERSION,
          } satisfies UpgradeChoice)
        : null;
  }

  if (Object.keys(sets).length) {
    sets.updated_at = nowIso();
    const cols = Object.keys(sets);
    db()
      .prepare(`UPDATE cases SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND status IN ('draft','quoted')`)
      .run(...cols.map((k) => sets[k]), id);
  }
  return reprice(u, id, { requote: pricingChanged });
}

/**
 * Recompute everything derived: repair estimate, partner quotes (when pricing
 * inputs changed or the quote is missing/expired), bonus and decision.
 */
export async function reprice(u: SessionUser, id: string, opts: { requote?: boolean } = {}): Promise<CaseView> {
  const { c, store } = caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) return toView(c, store);
  const org = getOrg(c.org_id)!;
  const settings = orgSettings(org.id);
  const tm = getTradeModel(c.model_id);
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const manual = parseJson<ManualQuote | null>(c.manual_repair, null);

  // 1. Repair estimate — needs only the model and the faults. A centre prices
  //    only the brand it services; anything else needs the customer's own quote.
  let repair: RepairEstimate | null = null;
  const serviced = !tm || !org.target_brand || tm.brand === org.target_brand;
  if (tm && (manual || (faults.length && serviced))) {
    const book = (
      db().prepare(`SELECT model_id, part, price, source FROM repair_book WHERE org_id = ? AND model_id = ?`).all(org.id, tm.id) as {
        model_id: string;
        part: string;
        price: number;
        source: string;
      }[]
    ).map((r) => ({ modelId: r.model_id, part: r.part, price: r.price, source: parseJson(r.source, { kind: "client", label: "Price book" }) }) as RepairBookEntry);
    const rp = settings.repairPolicy;
    const policy = {
      labour: rp.labourByTier[tm.service_tier] ?? rp.labourByTier.other ?? 0,
      carePlusFee: tm.care_plus_fee ?? rp.carePlusFeeDefault,
      gstBp: rp.gstBp,
    };
    repair = estimateRepair({ book, modelId: tm.id, faults, coverage: c.coverage, policy, manual });
  }

  // 2. Partner quotes — only with a complete, consistent description of the phone.
  let quote = parseJson<PartnerQuote | null>(c.quote, null);
  let repairedQuote = parseJson<PartnerQuote | null>(c.repaired_quote, null);
  const pm = parseJson<PartnerManual | null>(c.partner_manual, null);
  const consistent = !!condition && conditionFloor(condition, faults).length === 0;
  const expired = !!quote?.validUntil && Date.parse(quote.validUntil) < Date.now();
  const partnerId = orgPartnerId(org.id);
  const partnerName = getOrg(partnerId)?.name ?? "Partner";
  // The camera says this is not the phone on the case: no price until a store manager resolves it.
  const blocked = identityBlock(parseJson<CaseCameraCheck | null>(c.camera_check, null));
  if (!tm || !c.variant || !condition || !consistent || blocked) {
    quote = null;
    repairedQuote = null;
  } else if (pm) {
    // Read off the partner's own app: binding as entered, with its reference.
    quote = {
      status: "priced",
      amount: pm.amount,
      lines: [{ label: `${partnerName} quote · ref ${pm.reference}`, amount: pm.amount }],
      source: { kind: "partner_manual", label: `Entered from the ${partnerName} app by ${pm.by}` },
      partner: partnerName,
      partnerRef: pm.reference,
      quotedAt: pm.at,
      validUntil: pm.validUntil,
    };
    if (pm.repairedAmount !== null) {
      repairedQuote = { ...quote, amount: pm.repairedAmount, lines: [{ label: `${partnerName} value in repaired condition`, amount: pm.repairedAmount }], validUntil: null };
    } else if (!faults.length) {
      repairedQuote = { ...quote, validUntil: null };
    } else {
      // Only a REAL rate card may supply the repaired value next to a real quote;
      // a sample figure beside a partner quote would be a comparison of fiction with fact.
      const what = await partnerQuote({ partnerId, modelId: tm.id, variant: c.variant, answers: healedCondition(condition, faults), whatIf: true });
      repairedQuote = what.status === "priced" && what.source.kind !== "sample" ? what : null;
    }
  } else if (opts.requote || !quote || expired || quote.source.kind === "partner_manual") {
    quote = await partnerQuote({
      partnerId,
      modelId: tm.id,
      variant: c.variant,
      answers: condition,
      imei: c.imei,
      validityDaysOverride: settings.quoteValidityDays,
    });
    repairedQuote = faults.length
      ? await partnerQuote({ partnerId, modelId: tm.id, variant: c.variant, answers: healedCondition(condition, faults), whatIf: true })
      : quote.status === "priced"
        ? { ...quote, validUntil: null }
        : quote;
  }

  // 2b. Storage unknown: the partner's what-if price for EACH size, so the answer
  //     asks with one row of priced chips instead of a form — never a guessed
  //     size. Kept only while the storage is unknown; asked again only when the
  //     description changed (requote) or there are none yet. Never for a phone that
  //     measured a size off the model's list: every size on it is one the phone has
  //     ruled out, so there is nothing to offer and nothing to ask the partner.
  let storageQuotes = parseJson<StorageQuote[] | null>(c.storage_quotes, null);
  const sizes = tm ? parseJson<string[]>(tm.variants, []) : [];
  const measuredOffList = !!c.measured_storage && !sizes.includes(c.measured_storage);
  if (tm && !c.variant && condition && consistent && !blocked && !measuredOffList) {
    if (opts.requote || !storageQuotes) {
      const out: StorageQuote[] = [];
      for (const v of sizes) {
        const w = await partnerQuote({ partnerId, modelId: tm.id, variant: v, answers: condition, whatIf: true });
        const priced = w.status === "priced" && w.amount !== null;
        out.push({ variant: v, amount: priced ? w.amount : null, reason: priced ? null : (w.reason ?? null), sample: w.source.kind === "sample" });
      }
      storageQuotes = out.length ? out : null;
    }
  } else storageQuotes = null;

  // 3. Bonus — from the best active campaign for this upgrade.
  const upgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
  const asIs = quote?.status === "priced" ? quote.amount : null;
  const repairedVal = repairedQuote?.status === "priced" ? repairedQuote.amount : null;
  const repairPays = repair?.status === "quoted" ? repair.customerPays : null;
  const repairRatio = repairPays !== null && repairedVal ? repairPays / repairedVal : null;
  let bonus: BonusApplied | null = parseJson<BonusApplied | null>(c.bonus, null);
  if (upgrade && tm) {
    const campaigns: Campaign[] = activeCampaigns(org.id);
    const best = bestCampaign(campaigns, {
      today: todayIso(),
      oldBrand: tm.brand,
      oldAgeYears: tm.release_year ? Math.max(0, thisYear() - tm.release_year) : null,
      targetSeries: upgrade.series,
      newPrice: upgrade.price,
      tradeInValue: asIs ?? 0,
      repairRatio,
      storeKind: store.kind,
    });
    // A manager's override survives a re-price only for the same campaign and
    // only while it still sits inside that campaign's band; its rupee amount is
    // re-derived against today's basis, floored and capped like the rule result.
    let override = bonus?.override && best && bonus.campaignId === best.campaign.id ? bonus.override : null;
    if (override && best) {
      if (override.bp < best.campaign.minBp || override.bp > best.campaign.maxBp) override = null;
      else {
        let amt = Math.floor((best.result.basisAmount * override.bp) / 10_000);
        if (best.campaign.capRupees !== null) amt = Math.min(amt, best.campaign.capRupees);
        override = { ...override, amount: amt };
      }
    }
    bonus = best ? { ...best.result, campaignName: best.campaign.name, override } : null;
  } else bonus = null;

  // 4. Decision — the bonus is passed for display only (see decide()).
  const bonusAmount = bonus ? (bonus.override?.amount ?? bonus.amount) : 0;
  const decision = decide({
    repairPays,
    repairCovered: repair?.status === "quoted" && repair.customerPays === 0 && repair.coverage !== "none" && repair.basis === "book",
    repairedValue: repairedVal,
    asIsValue: asIs,
    valueSource: quote?.source.kind ?? null,
    upgrade: upgrade ? { label: upgrade.label, newPrice: upgrade.price, bonus: bonusAmount, supportEndYear: upgrade.supportEndYear } : null,
    old: { ageYears: tm?.release_year ? Math.max(0, thisYear() - tm.release_year) : null, supportEndYear: tm?.support_end_year ?? null },
    thisYear: thisYear(),
    nothingToRepair: faults.length === 0 && !manual,
    faultCount: faults.length,
    systemicFault: faults.some((f) => ["water_damage", "no_power", "no_network", "frame_damage"].includes(f)),
    swollenBattery: faults.includes("battery_swollen"),
    thresholds: settings.thresholds,
  });

  const status: CaseStatus = asIs !== null || repairPays !== null ? "quoted" : "draft";
  db()
    .prepare(
      `UPDATE cases SET repair = ?, quote = ?, repaired_quote = ?, storage_quotes = ?, bonus = ?, decision = ?, status = ?, updated_at = ?
       WHERE id = ? AND status IN ('draft','quoted')`
    )
    .run(
      repair ? JSON.stringify(repair) : null,
      quote ? JSON.stringify(quote) : null,
      repairedQuote ? JSON.stringify(repairedQuote) : null,
      storageQuotes ? JSON.stringify(storageQuotes) : null,
      bonus ? JSON.stringify(bonus) : null,
      JSON.stringify(decision),
      status,
      nowIso(),
      id
    );
  return getCase(u, id);
}

export async function setBonusOverride(u: SessionUser, id: string, input: { bp: number | null; reason?: string }): Promise<CaseView> {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can change the bonus.");
  const { c, store } = caseInScope(u, id);
  if (c.status !== "quoted") throw new HttpError(409, "The bonus can only be changed before the trade-in is locked.");
  const bonus = parseJson<BonusApplied | null>(c.bonus, null);
  if (!bonus) throw new HttpError(409, "Choose the new phone first — there is no bonus to change.");
  const campaign = activeCampaigns(c.org_id).find((x) => x.id === bonus.campaignId);
  if (!campaign) throw new HttpError(409, "The campaign behind this bonus is no longer running.");
  if (input.bp === null) {
    bonus.override = null;
  } else {
    const bp = Number(input.bp);
    if (!Number.isInteger(bp) || bp < campaign.minBp || bp > campaign.maxBp)
      throw new HttpError(400, `The bonus must stay inside the campaign band (${campaign.minBp / 100}–${campaign.maxBp / 100}%).`);
    const reason = (input.reason || "").trim();
    if (reason.length < 8) throw new HttpError(400, "Say why this customer gets a different bonus.");
    let amount = Math.floor((bonus.basisAmount * bp) / 10_000);
    if (campaign.capRupees !== null) amount = Math.min(amount, campaign.capRupees);
    bonus.override = { bp, amount, reason, by: u.name };
  }
  db().prepare(`UPDATE cases SET bonus = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(bonus), nowIso(), id);
  audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.bonus_override", entity: "case", entityId: id, detail: bonus.override });
  // The decision shows the bonus; recompute it without asking the partner again.
  return reprice(u, id, { requote: false });
}

export function chooseRepair(u: SessionUser, id: string): CaseView {
  requireCounter(u);
  return tx(() => {
    const { c, store } = caseInScope(u, id);
    assertTransition(c.status, "repair_chosen");
    const now = nowIso();
    db().prepare(`UPDATE cases SET status = 'repair_chosen', closed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.repair_chosen", entity: "case", entityId: id });
    return getCase(u, id);
  });
}

export function walkAway(u: SessionUser, id: string, reason?: string): CaseView {
  requireCounter(u);
  return tx(() => {
    const { c, store } = caseInScope(u, id);
    assertTransition(c.status, "walked_away");
    const now = nowIso();
    const why = (reason || "").trim().slice(0, 200) || null;
    db().prepare(`UPDATE cases SET status = 'walked_away', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?`).run(why, now, now, id);
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.walked_away", entity: "case", entityId: id, detail: { reason: reason ?? null } });
    return getCase(u, id);
  });
}

const ID_TYPES = ["aadhaar", "pan", "driving_licence", "voter_id", "passport"];

export type LockInput = {
  customer: { name: string; phone: string; idType: string; idLast4: string };
  checks: {
    ownership: boolean;
    factoryReset?: boolean;
    accountsRemoved?: boolean;
    simRemoved: boolean;
    imeiMatches: boolean;
    noFinanceLock: boolean;
    kym: { status: KymStatus; reference?: string | null };
    imeiCheckAck?: boolean;
    /** Required when the storage is the customer's claim (variantSource "customer"): the advisor saw it in Settings › About phone. */
    storageSeen?: boolean;
  };
};

/**
 * Take the trade-in: the customer gets the partner's value + the bonus off the
 * new phone, the store keeps the old phone, and the trade-in value is HELD on
 * the store's credit line until the partner collects (or clears) it.
 */
export function lockTradeIn(u: SessionUser, id: string, input: LockInput): CaseView {
  requireCounter(u);
  const name = String(input?.customer?.name || "").trim();
  const phone = digitsOnly(input?.customer?.phone);
  const idType = String(input?.customer?.idType || "");
  const idLast4 = String(input?.customer?.idLast4 || "").trim().toUpperCase();
  if (name.length < 2) throw new HttpError(400, "Enter the customer's name.");
  if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, "Enter a 10-digit Indian mobile number.");
  if (!ID_TYPES.includes(idType)) throw new HttpError(400, "Choose the customer's ID document.");
  if (!/^[A-Z0-9]{4}$/.test(idLast4)) throw new HttpError(400, "Enter the last 4 characters of the ID number (only those are stored).");
  const ch = input?.checks ?? ({} as LockInput["checks"]);
  const missing = [
    !ch.ownership && "customer confirms they own the phone",
    !ch.simRemoved && "SIM and memory card are removed",
    !ch.imeiMatches && "the IMEI on the phone matches the one recorded",
    !ch.noFinanceLock && "the phone is not on an EMI / finance plan or a company lock",
    !ch.kym?.status && "the government IMEI check (Sanchar Saathi KYM) has been done",
  ].filter(Boolean);
  if (missing.length) throw new HttpError(400, `Confirm before taking the phone: ${missing.join("; ")}.`);
  // Since 22 Oct 2025 a buyer of a used phone must check the national IMEI
  // register before completing the purchase. A flagged phone is never bought.
  const kymStatus = ch.kym.status;
  if (!(kymStatus in KYM_LABEL)) throw new HttpError(400, "Record what the government IMEI check returned.");
  if (kymStatus !== "clear")
    throw new HttpError(409, `The government IMEI register reports this phone as "${KYM_LABEL[kymStatus]}". Do not take it — return it to the customer.`);
  const kymRef = String(ch.kym.reference ?? "").trim().slice(0, 80) || null;

  return tx(() => {
    const { c, store } = caseInScope(u, id);
    const view = toView(c, store);
    assertTransition(c.status, "locked");
    // A claimed storage is enough to SHOW a price; moving money needs it seen —
    // the same rule as the IMEI, one tick, and only when the phone couldn't measure it.
    if (c.variant_source === "customer" && ch.storageSeen !== true)
      throw new HttpError(400, `Confirm before taking the phone: Settings › About phone shows ${c.variant} (the customer typed it — the phone couldn't measure it).`);
    if ((view.imeiCheck === "invalid" || view.imei2Check === "invalid") && !ch.imeiCheckAck)
      throw new HttpError(400, "An IMEI fails its check digit. Re-read it from *#06#, or confirm it is correct.");
    const blockers = view.lockBlockers;
    if (blockers.length) throw new HttpError(409, blockers[0]);

    // One phone, one trade-in — matched on EITHER of its IMEIs, so presenting
    // the second number of a dual-SIM phone does not get it past the check.
    const mine = [c.imei, c.imei2].filter(Boolean) as string[];
    const ph = mine.map(() => "?").join(",");
    const dup = db()
      .prepare(
        `SELECT c.ref, s.name FROM cases c JOIN stores s ON s.id = c.store_id
         WHERE c.id != ? AND c.status IN (${OPEN_TRADE_STATUSES.map(() => "?").join(",")})
           AND (c.imei IN (${ph}) OR c.imei2 IN (${ph})) LIMIT 1`
      )
      .get(c.id, ...OPEN_TRADE_STATUSES, ...mine, ...mine) as { ref: string; name: string } | undefined;
    if (dup) throw new HttpError(409, `This IMEI is already traded in (${dup.ref} at ${dup.name}). One phone, one trade-in.`);

    const T = view.quote!.amount!;
    const check = canHold(storePolicy(store), storeEvents(store.id), T);
    if (!check.ok) throw new HttpError(409, check.reason);
    const B = view.bonus ? (view.bonus.override?.amount ?? view.bonus.amount) : 0;
    const price = view.upgrade!.price;
    const payable = Math.max(0, price - T - B);
    const now = nowIso();
    const customer: Customer = { name: name.slice(0, 80), phone, idType, idLast4 };
    const checks: Checks = {
      ownership: true,
      simRemoved: true,
      imeiMatches: true,
      noFinanceLock: true,
      kym: { status: "clear", reference: kymRef },
      imeiCheckAck: !!ch.imeiCheckAck,
      ...(ch.storageSeen === true ? { storageSeen: true } : {}),
      at: now,
      by: u.name,
    };

    const upd = db()
      .prepare(
        `UPDATE cases SET status = 'locked', customer = ?, checks = ?, trade_value = ?, bonus_value = ?, payable = ?, locked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'quoted'`
      )
      .run(JSON.stringify(customer), JSON.stringify(checks), T, B, payable, now, now, id);
    if (upd.changes !== 1) throw new HttpError(409, "This case changed while you were working on it — reload.");
    postEvents(store.id, [{ kind: "hold", caseId: id, amount: T, at: now, note: `Trade-in ${c.ref}` }], u.id);
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.lock", entity: "case", entityId: id, detail: { tradeValue: T, bonus: B, payable, source: view.quote!.source.kind, kym: checks.kym, storage: { variant: c.variant, source: c.variant_source, seen: checks.storageSeen === true } } });
    return getCase(u, id);
  });
}

export function cancelTradeIn(u: SessionUser, id: string, reason: string): CaseView {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can cancel a trade-in.");
  if ((reason || "").trim().length < 4) throw new HttpError(400, "Say why the trade-in is cancelled.");
  return tx(() => {
    const { c, store } = caseInScope(u, id);
    assertTransition(c.status, "cancelled");
    const now = nowIso();
    const upd = db()
      .prepare(`UPDATE cases SET status = 'cancelled', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'locked'`)
      .run(reason.trim().slice(0, 200), now, now, id);
    if (upd.changes !== 1) throw new HttpError(409, "This case changed while you were working on it — reload.");
    postEvents(store.id, cancelEvents(id, c.trade_value!, now), u.id);
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.cancel", entity: "case", entityId: id, detail: { reason: reason.trim() } });
    return getCase(u, id);
  });
}

/**
 * Record that the customer cleared the phone after accepting the trade-in:
 * signed out of their accounts, factory-reset it from Settings, and it came
 * back to a setup screen that does not ask for their account. Store staff
 * only, while the phone is at the store. Recorded once.
 */
export function recordDataClear(u: SessionUser, id: string, input: Record<string, unknown>): CaseView {
  requireCounter(u);
  const missing = missingDataClearSteps(input);
  if (missing.length) throw new HttpError(400, `Confirm each step first: ${missing.join("; ")}.`);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;
  return tx(() => {
    const { c, store } = caseInScope(u, id);
    if (!DATA_CLEAR_STATUSES.includes(c.status)) throw new HttpError(409, "Data clearing is recorded after the customer accepts the trade-in, while the phone is still at the store.");
    if (c.data_clear) throw new HttpError(409, "Data clearing is already recorded for this phone.");
    const now = nowIso();
    const record: DataClearRecord = {
      label: DATA_CLEAR_LABEL,
      steps: Object.fromEntries(DATA_CLEAR_STEPS.map(([k]) => [k, true])) as DataClearRecord["steps"],
      note,
      by: u.name,
      at: now,
    };
    const upd = db().prepare(`UPDATE cases SET data_clear = ?, updated_at = ? WHERE id = ? AND data_clear IS NULL`).run(JSON.stringify(record), now, id);
    if (upd.changes !== 1) throw new HttpError(409, "This case changed while you were working on it — reload.");
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.data_clear", entity: "case", entityId: id, detail: { note } });
    return getCase(u, id);
  });
}
