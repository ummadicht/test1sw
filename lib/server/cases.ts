import { db, tx, nowIso, todayIso, newId, nextSeq, parseJson, audit } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { getOrg, getStore, ownStore, storeInScope, canSeeStore, orgPartnerId, type StoreRow } from "./scope";
import { partnerQuote, partnerMode, type PartnerQuote, type PartnerMode } from "./buyback";
import { storeEvents, storePolicy, postEvents } from "./credit";
import { activeCampaigns } from "./catalog";
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
import { canHold } from "../domain/credit";
import { readImei } from "../domain/imei";
import { type CaseStatus, assertTransition, OPEN_TRADE_STATUSES, cancelEvents } from "../domain/lifecycle";

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
  factoryReset: boolean;
  accountsRemoved: boolean;
  simRemoved: boolean;
  imeiMatches: boolean;
  noFinanceLock: boolean;
  kym: { status: KymStatus; reference: string | null };
  imeiCheckAck?: boolean;
  at: string;
  by: string;
};

export type UpgradeChoice = { deviceId: string; label: string; model: string; series: string; variant: string; price: number; supportEndYear: number | null };

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
};

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
  coverage: Coverage;
  condition: ConditionAnswers | null;
  conditionProblems: string[];
  manualRepair: ManualQuote | null;
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

function toView(c: CaseRow, store: StoreRow): CaseView {
  const tm = getTradeModel(c.model_id);
  const advisor = db().prepare(`SELECT name FROM users WHERE id = ?`).get(c.advisor_id) as { name: string } | undefined;
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const quote = parseJson<PartnerQuote | null>(c.quote, null);
  const quoteExpired = !!quote?.validUntil && Date.parse(quote.validUntil) < Date.now();
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
    coverage: c.coverage,
    condition,
    conditionProblems: condition ? conditionFloor(condition, faults) : [],
    manualRepair: parseJson<ManualQuote | null>(c.manual_repair, null),
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
  };
  if (c.status === "quoted") {
    view.lockBlockers = lockBlockers(view, !!org?.demo);
    // A store that registered itself has no credit line until the programme approves it.
    if (store.status === "pending")
      view.lockBlockers.unshift(`This store is waiting for approval from ${org?.name ?? "the programme"}. Phone tests and quotes work; taking trade-ins starts once it is approved and given a credit line.`);
    if (store.status === "rejected") view.lockBlockers.unshift("This store is closed in SwapUp, so it can't take trade-ins.");
    if (quote?.status === "priced" && quote.amount) {
      view.creditCheck = canHold(storePolicy(store), storeEvents(store.id), quote.amount);
      if (!view.creditCheck.ok) view.lockBlockers.push(view.creditCheck.reason);
    }
  }
  return view;
}

function lockBlockers(v: CaseView, orgIsDemo: boolean): string[] {
  const out: string[] = [];
  if (!v.device || !v.device.variant) out.push("Choose the phone's model and storage.");
  if (!v.imei) out.push("Record the IMEI (dial *#06#).");
  if (!v.condition) out.push("Answer the condition questions.");
  if (v.conditionProblems.length) out.push("The condition is recorded better than the faults allow.");
  if (!v.quote || v.quote.status !== "priced" || !v.quote.amount) out.push("No trade-in price from the partner.");
  else if (v.quoteExpired) out.push("The partner's quote has expired — re-quote.");
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
    };
  });
}

/* ─────────────────────────── writes ─────────────────────────── */

const COUNTER_ROLES = ["advisor", "store_manager"] as const;

function requireCounter(u: SessionUser): void {
  if (!(COUNTER_ROLES as readonly string[]).includes(u.role)) throw new HttpError(403, "Only store staff work cases at the counter.");
}

export function createCase(u: SessionUser, input: { customerName?: string; customerPhone?: string; demo?: boolean } = {}): CaseView {
  requireCounter(u);
  const store = ownStore(u);
  const id = newId("case");
  const ref = `SU-${store.code}-${String(nextSeq(`case:${store.id}`)).padStart(5, "0")}`;
  const now = nowIso();
  const customer =
    input.customerName || input.customerPhone
      ? JSON.stringify({ name: (input.customerName || "").trim().slice(0, 80), phone: digitsOnly(input.customerPhone).slice(0, 10), idType: null, idLast4: null })
      : null;
  db()
    .prepare(
      `INSERT INTO cases (id, ref, org_id, store_id, advisor_id, status, customer, faults, coverage, demo, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,'[]','none',?,?,?)`
    )
    .run(id, ref, store.org_id, store.id, u.id, customer, input.demo ? 1 : 0, now, now);
  audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "case.create", entity: "case", entityId: id });
  return getCase(u, id);
}

const digitsOnly = (s?: string | null) => (s || "").replace(/\D/g, "");

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
  /** The partner's quote read off its own app (amount + reference code). */
  partnerQuote?: { amount: number; reference: string; validDays?: number; repairedAmount?: number | null } | null;
  upgradeDeviceId?: string | null;
};

const EDITABLE: CaseStatus[] = ["draft", "quoted"];

/**
 * Save what the advisor has learned about the device, then re-price.
 * Partner calls happen OUTSIDE any transaction.
 */
export async function updateCase(u: SessionUser, id: string, patch: CasePatch): Promise<CaseView> {
  requireCounter(u);
  const { c, store } = caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) throw new HttpError(409, "This case is past the counter and can no longer be edited.");

  const sets: Record<string, unknown> = {};
  let pricingChanged = false;

  if (patch.modelId !== undefined) {
    const tm = patch.modelId ? getTradeModel(patch.modelId) : null;
    if (patch.modelId && !tm) throw new HttpError(400, "Unknown model.");
    sets.model_id = tm?.id ?? null;
    if (tm?.id !== c.model_id) sets.variant = null;
    pricingChanged = true;
  }
  if (patch.variant !== undefined) {
    const tm = getTradeModel((sets.model_id as string | undefined) ?? c.model_id);
    const variants = tm ? parseJson<string[]>(tm.variants, []) : [];
    if (patch.variant && !variants.includes(patch.variant)) throw new HttpError(400, "That storage variant does not exist for this model.");
    sets.variant = patch.variant || null;
    pricingChanged = true;
  }
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
    sets.coverage = patch.coverage;
    pricingChanged = true;
  }
  if (patch.condition !== undefined) {
    sets.condition = patch.condition === null ? null : JSON.stringify(cleanCondition(patch.condition));
    pricingChanged = true;
  }
  if (patch.conditionFromFaults) {
    const prev = parseJson<ConditionAnswers | null>((sets.condition as string | undefined) ?? c.condition, null);
    const base = prev ? { accessories: prev.accessories, age: prev.age } : { accessories: { charger: true, box: false, bill: false }, age: "gt11m" as const };
    sets.condition = JSON.stringify(conditionFromFaults(faults, base));
    pricingChanged = true;
  }
  if (patch.customer !== undefined) {
    const prev = parseJson<Customer | null>(c.customer, null);
    sets.customer = patch.customer
      ? JSON.stringify({
          name: (patch.customer.name ?? prev?.name ?? "").trim().slice(0, 80),
          phone: digitsOnly(patch.customer.phone ?? prev?.phone).slice(0, 10),
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
    pricingChanged = true;
  }
  // A partner quote read off its app describes ONE device in ONE condition. If
  // the description changes, that quote no longer belongs to this phone.
  const describes = patch.modelId !== undefined || patch.variant !== undefined || patch.faults !== undefined || patch.condition !== undefined || patch.conditionFromFaults;
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
      } satisfies UpgradeChoice);
    }
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
  if (!tm || !c.variant || !condition || !consistent) {
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
      `UPDATE cases SET repair = ?, quote = ?, repaired_quote = ?, bonus = ?, decision = ?, status = ?, updated_at = ?
       WHERE id = ? AND status IN ('draft','quoted')`
    )
    .run(
      repair ? JSON.stringify(repair) : null,
      quote ? JSON.stringify(quote) : null,
      repairedQuote ? JSON.stringify(repairedQuote) : null,
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
    factoryReset: boolean;
    accountsRemoved: boolean;
    simRemoved: boolean;
    imeiMatches: boolean;
    noFinanceLock: boolean;
    kym: { status: KymStatus; reference?: string | null };
    imeiCheckAck?: boolean;
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
    !ch.factoryReset && "phone is factory reset",
    !ch.accountsRemoved && "Samsung / Google accounts are signed out",
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
      factoryReset: true,
      accountsRemoved: true,
      simRemoved: true,
      imeiMatches: true,
      noFinanceLock: true,
      kym: { status: "clear", reference: kymRef },
      imeiCheckAck: !!ch.imeiCheckAck,
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
    audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.lock", entity: "case", entityId: id, detail: { tradeValue: T, bonus: B, payable, source: view.quote!.source.kind, kym: checks.kym } });
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
