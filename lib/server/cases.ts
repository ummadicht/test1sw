import { query, queryOne, execute, tx, nowIso, todayIso, newId, nextSeq, parseJson, audit, db } from "./db";
import { HttpError, orgSettings, type SessionUser } from "./auth";
import { getOrg, getStore, ownStore, storeInScope, canSeeStore, orgPartnerId, type StoreRow, type OrgRow } from "./scope";
import { partnerQuote, partnerMode, partnerModeSync, rateCardById, type PartnerQuote, type PartnerMode } from "./buyback";
import { tradeInQuote, priceiqRepaired, withoutOffNote } from "./tradeIn";
import { storeEvents, storePolicy, postEvents } from "./credit";
import { activeCampaigns, newDevices } from "./catalog";
import { caseMarketSell, type CaseMarketSell } from "./marketPrices";
import { caseGrading, issueQuietly, type CaseGrading, type ReportReason } from "./gradingReport";
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
import { buildOffer, currentDecision, nothingToRepairOn, EXPIRED_BLOCKER, noPriceWhy, type Offer, type StorageQuote, type VariantSource } from "../domain/offer";
import { customerAnswer, TYPED_PRICE_NOTE, type CustomerAnswer } from "../domain/answer";
import { refurbDecisionShown, refurbEconomics, type RefurbEconomics } from "../domain/refurbEconomics";
import { exchange, premiumOn, NEW_PHONE_TOO_CHEAP, PREMIUM_RULE_VERSION } from "../domain/premium";
import { RuleError } from "../domain/errors";
import { retiredSource } from "../domain/ratecard";
import { storageOnSave } from "../domain/phoneLed";
import { canHold } from "../domain/credit";
import { readImei, KYM_LABEL, type KymStatus } from "../domain/imei";
import { indianMobile } from "../domain/phone";
import { type CaseStatus, assertTransition, OPEN_TRADE_STATUSES, cancelEvents } from "../domain/lifecycle";
import { DATA_CLEAR_LABEL, DATA_CLEAR_STATUSES, DATA_CLEAR_STEPS, dataClearState, missingDataClearSteps, type DataClearRecord, type DataClearState } from "../domain/dataClear";
import {
  type CameraFloor,
  type CaseCameraCheck,
  type FaultSources,
  type RecordedOverride,
  applyCameraFloor,
  blankCameraCheck,
  cameraOverrideProblems,
  CAMERA_REASON_MIN,
  SCREEN_NOT_CHECKED,
  SCREEN_PARTLY_CHECKED,
  partialMarkNote,
  faultsAfterConditionEdit,
  identityBlock,
  reconcileFaultSources,
  standingFloor,
} from "../domain/gradeiqMap";
import { CERT_ROWS, allFineValue, certChoices, certifyAgainstCamera, certifyNeeded, certifyRow, certifySignals, isCertRow, readCertification, type Certification, type CertRow, type CertifySignals } from "../domain/certify";
import { cameraEvidence, type GiqRow } from "./gradeiqBridge";
import type { ImeiLookup } from "./gradeiq";
import {
  BLACKLISTED,
  IMEI_NAMES_NO_MODEL,
  blacklistWarning,
  caseImeiModel,
  caseLookupView,
  gsmaBlacklisted,
  imeiUnlistedSentence,
  lookupFor,
  resolveImei,
  tradeModelRefs,
  withLookup,
  withTacName,
  type KymEarly,
  type StoredImeiLookup,
} from "./imeiResolve";
import { imeiModelNow, imeiSourcesDisagree } from "../domain/tac";

/* ─────────────────────────── types ─────────────────────────── */

export type Customer = { name: string; phone: string; idType: string | null; idLast4: string | null };

// The government IMEI register's statuses and words live with the IMEI (lib/domain/imei.ts).
export { KYM_LABEL, type KymStatus };

/**
 * Where the case's model came from (migration 17): the IMEI (its type code, or the model number
 * GradeIQ's lookup returned — a claim the phone's own code confirms), the phone's model code at
 * Apply, the customer's pick on their phone (a claim), a Phonecheck report, or staff.
 */
export type ModelSource = "imei" | "phone" | "customer" | "phonecheck" | "advisor";
const MODEL_SOURCES = new Set<string>(["imei", "phone", "customer", "phonecheck", "advisor"]);
const readModelSource = (s: string | null): ModelSource | null => (s && MODEL_SOURCES.has(s) ? (s as ModelSource) : null);

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
  /** A quote an older build let staff type in from the partner's app. Never written now (updateCase refuses it), never priced from. */
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
  /** Frozen at lock (migration 16): the SwapUp premium on the market price, its band, and who pays it back. */
  premium_value: number | null;
  premium_bp: number | null;
  premium_funded_by: string | null;
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
  certification: string | null;
  /** Migration 17 (lib/server/imeiResolve.ts): each IMEI's resolution, the early KYM answer, where the model came from. */
  imei_lookup: string | null;
  kym_early: string | null;
  model_source: string | null;
};

/** The store's own cost to put the phone right (the refurb decision's repair cost). Not the customer's repair price. */
export type RefurbCost = { amount: number; by: string; at: string };

export type Clearance = { outcome: string; accepted: number; shortfall: number; reason: string | null; by: string; at: string };

/** One row the advisor certified by eye ("Check the phone" in SwapUp Store), as every view shows it. */
export type CertifiedView = { value: string; label: string; by: string; at: string; withColours: boolean };
export type CertificationView = Partial<Record<CertRow, CertifiedView>>;

/** The stored certification → what a view shows (no staff ids, no bookkeeping). */
export function certificationView(raw: string | null | undefined): CertificationView {
  const c = readCertification(parseJson<unknown>(raw, null));
  const out: CertificationView = {};
  for (const row of CERT_ROWS) {
    const r = c[row];
    if (r) out[row] = { value: r.value, label: r.label, by: r.by, at: r.at, withColours: r.withColours };
  }
  return out;
}

/**
 * "Check the phone" — the one card in SwapUp Store where the advisor certifies by
 * eye what the store camera couldn't decide (lib/domain/certify.ts). Staff only;
 * the same block on the session view and on the CaseView (docs/MOBILE-API.md §8b).
 *   needed         the rows to show: the screen when the camera's sweep didn't check it
 *                  or its grade isn't final; the body when it isn't final; the liquid
 *                  indicator on that same card. [] when the camera decided both: no card
 *   rows           what is certified so far (the case's), by name and time
 *   choices        each row's chips, word for word
 *   colours        always "off" since 0.9.4 (owner, 2026-10-25: after the tests the phone goes
 *                  back to the advisor with the report and the offer — no colour loop). Kept
 *                  for the 0.9.x apps, which read "showing" / "waiting" / "old_app" / "off" and
 *                  never hold the Screen row on "off" (swapup-mobile flow.ts)
 *   notes.screen   under the Screen row, when the card asks for it and the camera's sweep
 *                  didn't check every colour: what the partial sweep still SAW, named ("Screen
 *                  not fully camera-checked — it saw "Vertical green line…" (severe, 97%, on
 *                  white); black, green not captured. Look at it." — gradeiqMap.ts
 *                  partialMarkNote), else "Screen not fully camera-checked — look at it." (a
 *                  sweep ran but missed colours, or its reader was off) or "Screen not
 *                  camera-checked — look at it." (no sweep ran); null otherwise. The advisor's
 *                  own Screen tap decides — an incomplete sweep never puts a screen fault on
 *                  the case (lib/domain/gradeiqMap.ts, SUP-260); a severe mark it saw holds
 *                  the Screen row out of "All fine" (allFineTaps)
 *   testSessionId  the session the taps are made against (send it back with each tap)
 *   canEdit        false once the case is past the counter: shown, not tappable
 */
export type CertifyBlock = {
  needed: CertRow[];
  rows: Record<CertRow, CertifiedView | null>;
  choices: Record<CertRow, { value: string; label: string }[]>;
  colours: "showing" | "waiting" | "old_app" | "off";
  notes: { screen: string | null };
  testSessionId: string | null;
  canEdit: boolean;
};

/**
 * The "Check the phone" block for a case and its (latest) test session. After Apply the case's
 * own camera record says what the camera did; before it, the session's live evidence (`ce`,
 * computed here when not passed). The customer's phone is never asked to show the test colours
 * any more (SUP-260): the card is the advisor's look, made at once.
 */
export function certifyBlock(
  c: { status: string; camera_check: string | null; certification: string | null; faults?: string | null },
  s: (GiqRow & { phone_phase_at?: string | null }) | null,
  ce?: ReturnType<typeof cameraEvidence>
): { block: CertifyBlock; screenHeld: boolean } {
  const cert = certificationView(c.certification);
  const onCase = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  const caseFaults = parseJson<string[]>(c.faults ?? null, []);
  // The same signals the SwapUp grade reads (certify.ts certifySignals), so the card asks
  // exactly what the grade can only settle with a look.
  let cam: CertifySignals | null = null;
  let lcd: CaseCameraCheck["lcd"] | null = null;
  if (onCase && onCase.by !== null && (!s || onCase.testSessionId === s.id)) {
    const final = onCase.state === "ready" && onCase.final;
    const snap = final && s ? (ce ?? cameraEvidence(s)).snap : null;
    lcd = onCase.lcd;
    cam = certifySignals({ final, lcd: onCase.lcd, conclusive: onCase.conclusive, needsHumanReview: onCase.needsHumanReview, suggested: onCase.suggested, components: snap?.components ?? null, faults: caseFaults });
  } else if (s) {
    const e = ce ?? cameraEvidence(s);
    lcd = e.mapping.lcd;
    cam = certifySignals({
      final: e.fin.final,
      lcd: e.mapping.lcd,
      conclusive: e.snap?.conclusive ?? null,
      needsHumanReview: e.snap?.needsHumanReview ?? false,
      suggested: e.mapping.suggested,
      components: e.fin.final ? (e.snap?.components ?? null) : null,
      faults: caseFaults,
    });
  }
  const needed = certifyNeeded(cam);
  const rows = Object.fromEntries(CERT_ROWS.map((row) => [row, cert[row] ?? null])) as CertifyBlock["rows"];
  const atCounter = EDITABLE.includes(c.status as CaseStatus);
  // The Screen row's note: the camera's sweep didn't check every colour, so the advisor looks.
  const screenNote =
    needed.includes("screen") && !lcd?.cameraChecked ? (lcd && lcd.verdict !== null ? (partialMarkNote(lcd.partialMark) ?? SCREEN_PARTLY_CHECKED) : SCREEN_NOT_CHECKED) : null;
  return {
    // A partial sweep that saw a SEVERE mark: "All fine" leaves the Screen to the advisor's own tap.
    screenHeld: needed.includes("screen") && !lcd?.cameraChecked && !!lcd?.partialMark?.severe,
    block: {
      needed,
      rows,
      choices: Object.fromEntries(CERT_ROWS.map((row) => [row, certChoices(row)])) as CertifyBlock["choices"],
      // Owner, 2026-10-25: no colour loop after the tests — the phone is never asked for them.
      colours: "off",
      notes: { screen: screenNote },
      testSessionId: s?.id ?? null,
      canEdit: atCounter,
    },
  };
}

/**
 * The camera floor a "Check the phone" tap stands on — read from the same evidence as the card
 * (certifyBlock): the case's camera record once Apply wrote it for THIS session; before that (the
 * usual tap: the card holds the answer until it is tapped, and a re-test's taps), the session's
 * own camera, the floor its Apply puts on the case. Less what a reason given on the desk
 * overruled (standingFloor — the reasons carry over to a re-test). null = no camera evidence.
 */
export function tapFloor(onCase: CaseCameraCheck | null, s: GiqRow | null): CameraFloor | null {
  if (onCase && onCase.by !== null && (!s || onCase.testSessionId === s.id)) return standingFloor(onCase);
  if (!s) return null;
  return standingFloor({ floor: cameraEvidence(s).mapping.floor, overrides: onCase?.overrides ?? [] });
}

/**
 * The CaseView's "Check the phone": for a case the customer's phone tested (it has a
 * test session) or one already certified — a case described only at the desk gets no
 * card. Its latest session is the one the taps go against.
 */
async function caseCertify(c: CaseRow): Promise<CertifyBlock | null> {
  const s = await queryOne<GiqRow & { phone_phase_at?: string | null }>(
    `SELECT * FROM test_sessions WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [c.id]
  );
  if (!s && !Object.keys(certificationView(c.certification)).length) return null;
  return certifyBlock(c, s ?? null).block;
}

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
  /** Where the model came from — "imei" when the IMEI named it (null: no model, or a case from before). */
  modelSource: ModelSource | null;
  /**
   * THE IMEI FIRST (docs/MOBILE-API.md): what the case's IMEI resolved to, once — make, model, the
   * maker's model number and the GSMA blacklist ("unknown" = not checked, never clean). null = no
   * IMEI, one that fails its check digit, one saved before 0.9.0 — and always for the partner.
   */
  imeiLookup: ImeiLookup | null;
  /** Said as soon as the IMEI is saved (the lock still enforces): "This IMEI is already on trade-in SU-AND-00031." [] for the partner. */
  imeiWarnings: string[];
  /** The government KYM answer the advisor tapped right after the IMEI; Lock pre-fills from it (and still needs "clear"). */
  kymEarly: { status: KymStatus; reference: string | null } | null;
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
  /**
   * What the advisor certified by eye where the store camera couldn't decide — screen, body, liquid
   * indicator — each with the name, the time and whether the customer's phone showed the test colours
   * ({} = nothing certified). Set by {action: "certify"}; it moves the faults and the condition.
   */
  certification: CertificationView;
  /**
   * "Check the phone" (certifyBlock): which rows the advisor still certifies by eye, the taps so
   * far and the chips. Staff only (null for a partner), and null for a case nobody tested with
   * SwapUp Check and nobody certified.
   */
  certify: CertifyBlock | null;
  /** Why there is no trade-in quote although the phone is described (the camera's identity check). */
  quoteBlocked: string | null;
  manualRepair: ManualQuote | null;
  /** The store's own repair cost (the refurb decision) — never read by the advice, the bonus or the partner quote. */
  refurbCost: RefurbCost | null;
  /**
   * PriceIQ's refurbished-market listing less 2–5% (lib/domain/marketSell.ts). No screen of the desk
   * shows it since SUP-92 (the refurb decision prices the repaired phone off the price list); kept
   * for SwapUp Store builds whose "Store margin" card still reads it (docs/MOBILE-API.md §3b).
   */
  marketSell: CaseMarketSell;
  /** The centre does not repair this brand — only an outside quote can be compared. */
  repairNotServiced: string | null;
  repair: RepairEstimate | null;
  quote: PartnerQuote | null;
  quoteExpired: boolean;
  repairedQuote: PartnerQuote | null;
  /** The new phone. Its price is null for the partner (forViewer): with payable, it would give away the premium. */
  upgrade: (Omit<UpgradeChoice, "price"> & { price: number | null }) | null;
  bonus: BonusApplied | null;
  decision: Decision | null;
  checks: Checks | null;
  /** The market price held on the credit line (= what the partner pays back). */
  tradeValue: number | null;
  /** The SwapUp premium credited on top of tradeValue at lock; null before lock, on a case locked before premiums, and for the partner. */
  premiumValue: number | null;
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
   * empty and there is no trade-in price for that size — never a guessed one.
   */
  measuredStorage: string | null;
  /** THE ANSWER — refurb quote vs trade-in + bonus, and the one thing still missing (lib/domain/offer.ts). null for the partner. */
  offer: Offer | null;
  /**
   * REFURB DECISION · STAFF ONLY (lib/domain/refurbEconomics.ts, docs/MOBILE-API.md §3b): pre-refurb
   * value, repair cost, post-repair value off the same rate card, the repair uplift said as the
   * decision, and the SwapUp offer — the answer's own figures. null unless there is a priced trade-in
   * still to decide on (draft, quoted, locked, in_pickup — refurbDecisionShown); null for the partner;
   * never on the customer's status.
   */
  refurbEconomics: RefurbEconomics | null;
  /**
   * THE GRADE (docs/GRADING.md): one grade from every phone check — SwapUp Check and Phonecheck —
   * as the SwapUp grade with its letter ("Good (B)"), the one-line why, and the report link. Staff: the
   * live grade. Partner: only what the version frozen at lock says (null when there is none). Never a price.
   */
  grading: CaseGrading | null;
};

/* ─────────────────────────── reads ─────────────────────────── */

async function row(id: string): Promise<CaseRow | null> {
  return await queryOne<CaseRow>(`SELECT * FROM cases WHERE id = $1`, [id]);
}

export async function getTradeModel(id: string | null): Promise<TradeModel | null> {
  if (!id) return null;
  return await queryOne<TradeModel>(`SELECT * FROM trade_models WHERE id = $1`, [id]);
}

/** The buyback partner sees a case only once it became a trade-in it will collect. */
export const PARTNER_HIDDEN_STATUSES: CaseStatus[] = ["draft", "quoted", "repair_chosen", "walked_away", "cancelled"];

async function caseInScope(u: SessionUser, id: string): Promise<{ c: CaseRow; store: StoreRow }> {
  const c = await row(id);
  if (!c) throw new HttpError(404, "Case not found.");
  const store = await getStore(c.store_id);
  if (!store || !(await canSeeStore(u, store))) throw new HttpError(404, "Case not found.");
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

/**
 * A quote that ran out — or, on a case still at the counter, one from a source SwapUp no longer has
 * (an older build's) or a price staff typed before 0.9.1 (`partner_manual`): re-asked on open (the
 * desk's and the store app's quiet re-quote read this), never locked on. A traded case keeps its own.
 */
function quoteLapsed(c: CaseRow, quote: PartnerQuote | null): boolean {
  return (
    (!!quote?.validUntil && Date.parse(quote.validUntil) < Date.now()) ||
    (!!quote && EDITABLE.includes(c.status) && (retiredSource(quote.source?.kind) || quote.source?.kind === "partner_manual"))
  );
}

function repairNotServicedFor(tm: TradeModel | null, org: Awaited<ReturnType<typeof getOrg>>): string | null {
  return tm && org?.target_brand && tm.brand !== org.target_brand ? `This centre repairs ${org.target_brand} only — enter the customer's outside quote.` : null;
}

/** The case's stored quote as the screens read it: no "PriceIQ isn't connected" note (tradeIn.ts withoutOffNote). */
function storedQuote(raw: string | null): PartnerQuote | null {
  const q = parseJson<PartnerQuote | null>(raw, null);
  return q && withoutOffNote(q);
}

async function offerFor(c: CaseRow, store: StoreRow): Promise<Offer> {
  const tm = await getTradeModel(c.model_id);
  const org = await getOrg(c.org_id);
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const quote = storedQuote(c.quote);
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  const upgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
  const manualRepair = parseJson<ManualQuote | null>(c.manual_repair, null);
  const repair = manualRepair
    ? {
        status: "quoted" as const,
        basis: "manual" as const,
        coverage: c.coverage,
        lines: [],
        inspectionFaults: [],
        missingParts: [],
        labour: 0,
        carePlusFee: 0,
        gst: 0,
        listTotal: manualRepair.amount,
        customerPays: manualRepair.amount,
        notes: [`Manual quote (${manualRepair.by}): ${manualRepair.reason}`],
      }
    : parseJson<RepairEstimate | null>(c.repair, null);
  // With no new phone on an open case, ask the suggestion rule whether the catalogue HAS one,
  // so the ask never says "nothing matches" after staff cleared it or on a desk-only case.
  const newPhoneMatch =
    tm && !upgrade && EDITABLE.includes(c.status)
      ? suggestUpgrade({ brand: tm.brand, model: tm.model, series: tm.series, variant: c.variant }, await newDevices(store.org_id)) !== null
      : false;
  return buildOffer({
    status: c.status,
    device: tm ? { label: `${tm.brand} ${tm.model}`, variant: c.variant, variants: parseJson<string[]>(tm.variants, []) } : null,
    variantSource: c.variant ? readVariantSource(c.variant_source) : null,
    measuredStorage: c.measured_storage ?? null,
    storageQuotes: parseJson<StorageQuote[] | null>(c.storage_quotes, null),
    faultCount: faults.length,
    coverage: c.coverage,
    repair,
    manualRepair,
    repairNotServiced: repairNotServicedFor(tm, org),
    quote,
    quoteExpired: quoteLapsed(c, quote),
    quoteBlocked: identityBlock(camera),
    conditionProblems: condition ? conditionFloor(condition, faults) : [],
    hasCondition: !!condition,
    upgrade,
    bonus: parseJson<BonusApplied | null>(c.bonus, null),
    decision: parseJson<Decision | null>(c.decision, null),
    tested: !!camera,
    newPhoneMatch,
    condition,
    // Past the counter, the figures frozen at lock win over the quote and bonus JSON.
    locked: EDITABLE.includes(c.status) ? null : { trade: c.trade_value, premium: c.premium_value, premiumBp: c.premium_bp, bonus: c.bonus_value, payable: c.payable },
    testProgramme: !!org?.demo,
    imeiUnlisted: await imeiUnlistedOn(c, tm),
  });
}

/**
 * A case at the counter with no model whose IMEI names a phone SwapUp doesn't list: the sentence
 * staff read in place of a price ("The IMEI says Apple iPhone 17 Pro Max — not on SwapUp's list, so
 * it can't be priced here yet."), and the customer's CANT_PRICE — never another phone's price. null otherwise.
 */
async function imeiUnlistedOn(c: CaseRow, tm: TradeModel | null): Promise<string | null> {
  if (tm || !c.imei || !EDITABLE.includes(c.status)) return null;
  const refs = await tradeModelRefs();
  const said = caseImeiModel(c, refs);
  return said.kind === "unlisted" ? imeiUnlistedSentence(said.label) : null;
}

async function toView(c: CaseRow, store: StoreRow, viewer: { partner?: boolean } = {}): Promise<CaseView> {
  const tm = await getTradeModel(c.model_id);
  const advisor = await queryOne<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [c.advisor_id]);
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const quote = storedQuote(c.quote);
  const quoteExpired = quoteLapsed(c, quote);
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  const org = await getOrg(c.org_id);
  const mode = org?.partner_id ? await partnerMode(org.partner_id) : null;
  // A price typed in by an older build (partner_manual, history only) came from no rate card: its
  // line says what it is, never the card's (SUP-9).
  const partner = mode && quote?.source.kind === "partner_manual" ? { ...mode, why: TYPED_PRICE_NOTE } : mode;
  const manualRepair = parseJson<ManualQuote | null>(c.manual_repair, null);
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
    modelSource: tm ? readModelSource(c.model_source) : null,
    // "blacklisted" when GSMA said so for ANY IMEI ever saved on the case (lib/server/imeiResolve.ts).
    imeiLookup: caseLookupView(c),
    imeiWarnings: await imeiWarnings(c, tm),
    kymEarly: kymEarlyView(c.kym_early),
    closedReason: c.closed_reason,
    faults,
    faultSources: reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults),
    coverage: c.coverage,
    condition,
    conditionProblems: condition ? conditionFloor(condition, faults) : [],
    camera: camera ? withoutGradeiqId(camera) : null,
    certification: certificationView(c.certification),
    certify: viewer.partner ? null : await caseCertify(c),
    quoteBlocked: identityBlock(camera),
    manualRepair,
    refurbCost: parseJson<RefurbCost | null>(c.refurb_cost, null),
    marketSell: await caseMarketSell({ modelId: tm?.id ?? null, variant: c.variant, brand: tm?.brand ?? null, model: tm?.model ?? null, condition }),
    repairNotServiced: repairNotServicedFor(tm, org),
    repair: manualRepair
      ? {
          status: "quoted" as const,
          basis: "manual" as const,
          coverage: c.coverage,
          lines: [],
          inspectionFaults: [],
          missingParts: [],
          labour: 0,
          carePlusFee: 0,
          gst: 0,
          listTotal: manualRepair.amount,
          customerPays: manualRepair.amount,
          notes: [`Manual quote (${manualRepair.by}): ${manualRepair.reason}`],
        }
      : parseJson<RepairEstimate | null>(c.repair, null),
    quote,
    quoteExpired,
    repairedQuote: parseJson<PartnerQuote | null>(c.repaired_quote, null),
    upgrade: parseJson<UpgradeChoice | null>(c.upgrade, null),
    bonus: parseJson<BonusApplied | null>(c.bonus, null),
    // The answer's own decision: a stored "Nothing to repair" from before SUP-96 for a phone with a defect is not used.
    decision: currentDecision(parseJson<Decision | null>(c.decision, null), nothingToRepairOn(faults.length, manualRepair, condition)),
    checks: parseJson<Checks | null>(c.checks, null),
    tradeValue: c.trade_value,
    premiumValue: c.premium_value,
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
    refurbEconomics: null,
    grading: await caseGrading(c.id, viewer.partner ? "partner" : "staff"),
  };
  const legacyChecks = parseJson<Checks | null>(c.checks, null);
  view.dataClearState = dataClearState(c.status, view.dataClear, legacyChecks?.factoryReset === true);
  if (c.status === "quoted") {
    view.lockBlockers = lockBlockers(view);
    if (view.quoteBlocked) view.lockBlockers.unshift(view.quoteBlocked);
    // A store that registered itself has no credit line until the programme approves it.
    if (store.status === "pending")
      view.lockBlockers.unshift(`Waiting for approval from ${org?.name ?? "the programme"} — trade-ins start then.`);
    if (store.status === "rejected") view.lockBlockers.unshift("This store is closed — no trade-ins.");
    if (quote?.status === "priced" && quote.amount) {
      view.creditCheck = canHold(await storePolicy(store), await storeEvents(store.id), quote.amount);
      if (!view.creditCheck.ok) view.lockBlockers.push(view.creditCheck.reason);
    }
  }
  // The answer is worked out for every status; `open` says whether it can still be acted on.
  view.offer = await offerFor(c, store);
  // The staff refurb decision, from the answer's own figures and the card the trade-in was read off —
  // only while there is a priced trade-in to decide on (at the counter, or traded in until pickup).
  if (!viewer.partner && refurbDecisionShown(c.status, view.offer.swap)) {
    const cardId = quote?.status === "priced" && quote.source.kind === "partner_ratecard" ? quote.source.rateCardId : null;
    view.refurbEconomics = refurbEconomics({
      swap: view.offer.swap,
      quote,
      card: cardId ? await rateCardById(cardId) : null,
      device: tm ? { modelId: tm.id, variant: c.variant } : null,
      condition,
      faults,
      repair: view.repair,
      refurbCost: view.refurbCost,
    });
  }
  return view;
}

/**
 * One phone, one trade-in — the open trade-in (locked, collected…) that already has either of
 * these IMEIs. The lock refuses on it; the case view warns as soon as the IMEI is saved.
 */
async function imeiOnOpenTradeIn(caseId: string, imeis: (string | null)[]): Promise<{ ref: string; name: string } | undefined> {
  const mine = imeis.filter((x): x is string => !!x);
  if (!mine.length) return undefined;
  const res = await queryOne<{ ref: string; name: string }>(
    `SELECT c.ref, s.name FROM cases c JOIN stores s ON s.id = c.store_id
     WHERE c.id != $1 AND c.status = ANY($2::text[])
       AND (c.imei = ANY($3::text[]) OR c.imei2 = ANY($3::text[])) LIMIT 1`,
    [caseId, OPEN_TRADE_STATUSES, mine]
  );
  return res ?? undefined;
}

/** What the advisor is told the moment the IMEI is on a case at the counter (the lock still decides). */
async function imeiWarnings(c: CaseRow, tm: TradeModel | null): Promise<string[]> {
  if (!EDITABLE.includes(c.status)) return [];
  // A blacklisted number that isn't in the IMEI 1 slot (moved to IMEI 2, or replaced): named, so the
  // stop on a clean-looking IMEI 1 is explained. Said with or without an IMEI on the case now.
  const bad = blacklistWarning(c);
  if (!c.imei) return bad ? [bad] : [];
  const out: string[] = bad ? [bad] : [];
  const dup = await imeiOnOpenTradeIn(c.id, [c.imei, c.imei2]);
  if (dup) out.push(`This IMEI is already on trade-in ${dup.ref}.`);
  // What the IMEI names, read against today's list (a model added since is named now). Another model
  // than the one on the case (staff's, or the phone's code) is said, not changed; a phone SwapUp doesn't
  // list is said as such — it can't be priced here, and never as another phone (SUP-258).
  const kept = withTacName(lookupFor(c.imei_lookup, c.imei));
  const refs = await tradeModelRefs();
  const said = caseImeiModel(c, refs);
  // GSMA's own name and the type code name different phones: both are said (GSMA's decided, or neither).
  const split = imeiSourcesDisagree(kept, refs);
  if (split) out.push(`The IMEI's type code says ${split.tac}; GSMA says ${split.gsma} — check Settings › About phone.`);
  if (said.kind === "listed" && tm && said.modelId !== tm.id) {
    const other = await getTradeModel(said.modelId);
    if (other) out.push(`The IMEI says ${other.brand} ${other.model}; the case has ${tm.brand} ${tm.model} — check Settings › About phone.`);
  } else if (said.kind === "unlisted") {
    // With a model on the case it IS priced: said once, without "can't be priced here".
    out.push(tm ? `The IMEI says ${said.label}, which isn't on SwapUp's list; the case has ${tm.brand} ${tm.model} — check Settings › About phone.` : imeiUnlistedSentence(said.label));
  } else if (kept && !tm && !split && (said.kind === "none" || said.kind === "ambiguous")) {
    out.push(IMEI_NAMES_NO_MODEL);
  }
  return out;
}

function kymEarlyView(raw: string | null): CaseView["kymEarly"] {
  const k = parseJson<KymEarly | null>(raw, null);
  return k && Object.hasOwn(KYM_LABEL, k.status) ? { status: k.status, reference: k.reference ?? null } : null;
}

function lockBlockers(v: CaseView): string[] {
  const out: string[] = [];
  // GSMA's blacklist (for any IMEI ever saved on the case — the view says it): the trade-in stops
  // here. An early KYM answer that isn't clear is not a blocker: it stopped the tests, and at the
  // lock the advisor's own KYM answer — which must be clear — supersedes it (lockTradeIn).
  if (v.imeiLookup?.blacklist === "blacklisted") out.push(BLACKLISTED);
  if (!v.device || !v.device.variant) out.push("Choose the phone's model and storage.");
  if (!v.imei) out.push("Record the IMEI (dial *#06#).");
  if (!v.condition) out.push("Record the condition.");
  if (v.conditionProblems.length) out.push("Condition is better than the faults allow.");
  // Nothing priced it: the quote's own why when it has one ("This phone isn't on the rate card yet.",
  // PriceIQ's) — the answer's words (offer.ts noPriceWhy) — else the plain sentence.
  if (!v.quote || v.quote.status !== "priced" || !v.quote.amount) out.push(noPriceWhy(v.quote?.reason) ?? "No trade-in price yet.");
  // Re-quote fixes it: every quote is the system's (PriceIQ, the rate card).
  else if (v.quoteExpired) out.push(EXPIRED_BLOCKER);
  if (!v.upgrade) out.push("Choose the new phone.");
  // We pay + the bonus must come off the new phone: never a share floored at zero (premium.ts exchange).
  else if (v.quote?.status === "priced" && v.quote.amount) {
    const bonus = v.bonus ? (v.bonus.override?.amount ?? v.bonus.amount) : 0;
    try {
      exchange({ market: v.quote.amount, bonus, newPrice: v.upgrade.price ?? 0 });
    } catch (e) {
      if (!(e instanceof RuleError)) throw e;
      out.push(NEW_PHONE_TOO_CHEAP);
    }
  }
  return out;
}

/**
 * The customer's answer for their phone (GET /api/device/status → answer, docs/MOBILE-API.md §4):
 * the whitelist slice of the case's answer (lib/domain/answer.ts customerAnswer). Read only —
 * built from the stored rows (offerFor): it never re-prices, never asks the partner, PriceIQ or
 * GradeIQ, and never writes, so a phone polling every 5 s can never loop a partner with the IMEI.
 * null when the case is gone.
 */
export async function deviceAnswer(caseId: string): Promise<CustomerAnswer | null> {
  const c = await row(caseId);
  const store = c ? await getStore(c.store_id) : null;
  if (!c || !store) return null;
  const offer = await offerFor(c, store);
  return customerAnswer(offer.answer);
}

export function getCaseSync(u: SessionUser, id: string): CaseView | null {
  if (process.env.DATABASE_URL || process.env.PGHOST) return null;
  try {
    const sqlite = db();
    const c = sqlite.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
    if (!c) return null;
    const store = sqlite.prepare("SELECT * FROM stores WHERE id = ?").get(c.store_id) as StoreRow | undefined;
    if (!store) return null;
    if (u.role === "partner" && PARTNER_HIDDEN_STATUSES.includes(c.status)) return null;
    const tm = c.model_id ? (sqlite.prepare("SELECT * FROM trade_models WHERE id = ?").get(c.model_id) as TradeModel | undefined) ?? null : null;
    const advisor = sqlite.prepare("SELECT name FROM users WHERE id = ?").get(c.advisor_id) as { name?: string } | undefined;
    const faults = parseJson<FaultId[]>(c.faults, []);
    const condition = parseJson<ConditionAnswers | null>(c.condition, null);
    const quote = storedQuote(c.quote);
    const quoteExpired = quoteLapsed(c, quote);
    const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
    const org = sqlite.prepare("SELECT * FROM orgs WHERE id = ?").get(c.org_id) as OrgRow | undefined;
    const mode = org?.partner_id ? partnerModeSync(org.partner_id) : null;
    const partner = mode && quote?.source.kind === "partner_manual" ? { ...mode, why: TYPED_PRICE_NOTE } : mode;
    const manualRepair = parseJson<ManualQuote | null>(c.manual_repair, null);

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
      modelSource: tm ? readModelSource(c.model_source) : null,
      imeiLookup: caseLookupView(c),
      imeiWarnings: [],
      kymEarly: kymEarlyView(c.kym_early),
      closedReason: c.closed_reason,
      faults,
      faultSources: reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults),
      coverage: c.coverage,
      condition,
      conditionProblems: condition ? conditionFloor(condition, faults) : [],
      camera: camera ? withoutGradeiqId(camera) : null,
      certification: certificationView(c.certification),
      certify: null,
      quoteBlocked: identityBlock(camera),
      manualRepair,
      refurbCost: parseJson<RefurbCost | null>(c.refurb_cost, null),
      marketSell: { amount: null, why: null, source: null },
      repairNotServiced: repairNotServicedFor(tm, org),
      repair: manualRepair
        ? {
            status: "quoted" as const,
            basis: "manual" as const,
            coverage: c.coverage,
            lines: [],
            inspectionFaults: [],
            missingParts: [],
            labour: 0,
            carePlusFee: 0,
            gst: 0,
            listTotal: manualRepair.amount,
            customerPays: manualRepair.amount,
            notes: [`Manual quote (${manualRepair.by}): ${manualRepair.reason}`],
          }
        : parseJson<RepairEstimate | null>(c.repair, null),
      quote,
      quoteExpired,
      repairedQuote: parseJson<PartnerQuote | null>(c.repaired_quote, null),
      upgrade: parseJson<UpgradeChoice | null>(c.upgrade, null),
      bonus: parseJson<BonusApplied | null>(c.bonus, null),
      decision: currentDecision(parseJson<Decision | null>(c.decision, null), nothingToRepairOn(faults.length, manualRepair, condition)),
      checks: parseJson<Checks | null>(c.checks, null),
      tradeValue: c.trade_value,
      premiumValue: c.premium_value,
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
      refurbEconomics: null,
      grading: null,
    };
    const legacyChecks = parseJson<Checks | null>(c.checks, null);
    view.dataClearState = dataClearState(c.status, view.dataClear, legacyChecks?.factoryReset === true);
    if (c.status === "quoted") {
      view.lockBlockers = lockBlockers(view);
      if (view.quoteBlocked) view.lockBlockers.unshift(view.quoteBlocked);
    }
    const upgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
    const newPhoneMatch = tm && !upgrade && EDITABLE.includes(c.status);
    view.offer = buildOffer({
      status: c.status,
      device: tm ? { label: `${tm.brand} ${tm.model}`, variant: c.variant, variants: parseJson<string[]>(tm.variants, []) } : null,
      variantSource: c.variant ? readVariantSource(c.variant_source) : null,
      measuredStorage: c.measured_storage ?? null,
      storageQuotes: parseJson<StorageQuote[] | null>(c.storage_quotes, null),
      faultCount: faults.length,
      coverage: c.coverage,
      repair: view.repair,
      manualRepair,
      repairNotServiced: repairNotServicedFor(tm, org),
      quote,
      quoteExpired,
      quoteBlocked: identityBlock(camera),
      conditionProblems: condition ? conditionFloor(condition, faults) : [],
      hasCondition: !!condition,
      upgrade,
      bonus: parseJson<BonusApplied | null>(c.bonus, null),
      decision: parseJson<Decision | null>(c.decision, null),
      tested: !!camera,
      newPhoneMatch,
      condition,
      locked: EDITABLE.includes(c.status) ? null : { trade: c.trade_value, premium: c.premium_value, premiumBp: c.premium_bp, bonus: c.bonus_value, payable: c.payable },
      testProgramme: !!org?.demo,
      imeiUnlisted: null,
    });
    return forViewer(u, view);
  } catch (e) {
    console.error("getCaseSync error:", e);
    return null;
  }
}

export function getCase(u: SessionUser, id: string): Promise<CaseView> & CaseView {
  const sync = getCaseSync(u, id);
  const p = (async () => {
    const { c, store } = await caseInScope(u, id);
    return forViewer(u, await toView(c, store, { partner: u.role === "partner" }));
  })();
  if (sync) {
    return Object.assign(p, sync);
  }
  return p as any;
}

/**
 * What the buyback partner may see of a case. The store's own money is its
 * business: its repair cost and refurb decision ("Refurb decision · staff only"), the
 * answer it gave its customer (refurb quote vs trade-in + bonus) and PriceIQ's
 * refurbished-market listing (`marketSell`). Applied on every read path
 * (getCase), so no list or action response can carry them to a partner.
 *
 * Nor does the partner get the store camera's OWN grade: GradeIQ's letter
 * (Premium–D), its best–worst range and its flags are staff-only, never priced
 * (lib/domain/gradeiqMap.ts) — beside the report's A–D they would read as a
 * second SwapUp grade. The partner's grade is the report frozen at lock
 * (`grading`). The camera's faults and findings stay: they are on the case.
 */
export function forViewer(u: SessionUser, view: CaseView): CaseView {
  if (u.role !== "partner") return view;
  return {
    ...view,
    // The seller's identity (name, phone, ID) is the store's — the partner matches phones by case ref and IMEI (SUP-105).
    customer: null,
    refurbCost: null,
    offer: null,
    refurbEconomics: null,
    // GradeIQ's lookup and the counter's IMEI warnings are the store's (contract I3).
    imeiLookup: null,
    imeiWarnings: [],
    // The premium is the programme's, not the partner's — and the new phone's price with what the
    // customer paid would give it away (new phone − payable − trade-in − bonus).
    premiumValue: null,
    payable: null,
    upgrade: view.upgrade ? { ...view.upgrade, price: null } : null,
    marketSell: { amount: null, why: "Not shown to the partner.", source: view.marketSell.source },
    camera: view.camera ? { ...view.camera, grade: null, gradeRange: null, flags: [] } : null,
    // The answer the store gave its customer — the decision and its repair figures — is the store's.
    decision: null,
    repair: null,
    manualRepair: null,
    quote: partnerQuoteView(view.quote),
    // A PriceIQ "worth once repaired" is the store's own SELL price; only the partner's own repaired value is its business.
    repairedQuote: view.repairedQuote && view.repairedQuote.source.kind !== "priceiq" ? partnerQuoteView(view.repairedQuote) : null,
  };
}

/**
 * A quote as the partner sees it. A PriceIQ trade-in starts from the refurbished-market
 * listing — the store's SELL price — so its trace collapses to the one trade-in line, and
 * PriceIQ's base and markdown never leave the server. (By design a defect-free PriceIQ
 * trade-in IS listing − markdown, so the amount alone still implies the sell price.)
 */
export function partnerQuoteView(q: PartnerQuote | null): PartnerQuote | null {
  if (!q) return null;
  const { priceiq: _p, priceiqWhy: _w, ...rest } = q;
  if (q.source.kind !== "priceiq") return rest;
  return { ...rest, lines: q.amount === null ? [] : [{ label: "Trade-in", amount: q.amount }], source: { ...q.source, label: "Trade-in" } };
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

export async function listCases(
  u: SessionUser,
  opts: { storeId?: string | null; status?: CaseStatus[] | null; q?: string | null; limit?: number; pickupId?: string | null } = {}
): Promise<CaseListItem[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  let pIdx = 1;
  if (u.role === "advisor" || u.role === "store_manager") {
    where.push(`c.store_id = $${pIdx++}`);
    args.push(u.storeId);
  } else if (u.role === "org_admin") {
    where.push(`c.org_id = $${pIdx++}`);
    args.push(u.orgId);
  } else if (u.role === "partner") {
    where.push(`c.org_id IN (SELECT id FROM orgs WHERE kind = 'client' AND partner_id = $${pIdx++})`);
    args.push(u.orgId);
    where.push(`c.status NOT IN (${PARTNER_HIDDEN_STATUSES.map((x) => `'${x}'`).join(",")})`);
  }
  if (opts.storeId) {
    await storeInScope(u, opts.storeId);
    where.push(`c.store_id = $${pIdx++}`);
    args.push(opts.storeId);
  }
  if (opts.pickupId) {
    where.push(`c.pickup_id = $${pIdx++}`);
    args.push(opts.pickupId);
  }
  if (opts.status?.length) {
    where.push(`c.status = ANY($${pIdx++}::text[])`);
    args.push(opts.status);
  }
  if (opts.q) {
    if (u.role === "partner") {
      where.push(`(c.ref ILIKE $${pIdx} OR c.imei ILIKE $${pIdx} OR t.model ILIKE $${pIdx})`);
    } else {
      where.push(`(c.ref ILIKE $${pIdx} OR c.imei ILIKE $${pIdx} OR c.customer ILIKE $${pIdx} OR t.model ILIKE $${pIdx})`);
    }
    const like = `%${opts.q.trim()}%`;
    args.push(like);
    pIdx++;
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await query<CaseRow & { store_name: string; brand: string | null; model_name: string | null }>(
    `SELECT c.*, s.name AS store_name, t.brand, t.model AS model_name
     FROM cases c JOIN stores s ON s.id = c.store_id LEFT JOIN trade_models t ON t.id = c.model_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY c.updated_at DESC LIMIT ${limit}`,
    args
  );
  return rows.map((r) => {
    const cust = parseJson<Customer | null>(r.customer, null);
    const up = parseJson<UpgradeChoice | null>(r.upgrade, null);
    // The answer's decision, as the case page reads it (offer.ts currentDecision): never a stale "Straight trade-in".
    const dec = currentDecision(
      parseJson<Decision | null>(r.decision, null),
      nothingToRepairOn(parseJson<FaultId[]>(r.faults, []).length, parseJson<ManualQuote | null>(r.manual_repair, null), parseJson<ConditionAnswers | null>(r.condition, null))
    );
    return {
      id: r.id,
      ref: r.ref,
      status: r.status,
      storeId: r.store_id,
      storeName: r.store_name,
      // The seller's name is never sent to the buyback partner (SUP-105).
      customerName: u.role === "partner" ? null : (cust?.name ?? null),
      device: r.model_name ? `${r.brand} ${r.model_name}${r.variant ? " " + r.variant : ""}` : null,
      imei: r.imei,
      tradeValue: r.trade_value ?? parseJson<PartnerQuote | null>(r.quote, null)?.amount ?? null,
      bonusValue: u.role === "partner" ? null : r.bonus_value,
      newDevice: u.role === "partner" ? null : (up?.label ?? null),
      // The store's answer to its customer is not the partner's business.
      recommendation: u.role === "partner" ? null : (dec?.recommendation ?? null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lockedAt: r.locked_at,
      demo: !!r.demo,
      dataClear: dataClearState(r.status, parseJson<DataClearRecord | null>(r.data_clear, null), parseJson<Checks | null>(r.checks, null)?.factoryReset === true),
    };
  });
}

/** Accepted phones still at this store whose data clearing is not recorded. */
export async function dataClearDueIds(storeId: string): Promise<Set<string>> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM cases WHERE store_id = $1 AND status = ANY($2::text[])
       AND data_clear IS NULL AND COALESCE((checks::jsonb #>> '{factoryReset}'), '0') NOT IN ('1', 'true')`,
    [storeId, DATA_CLEAR_STATUSES]
  );
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

export function createCase(
  u: SessionUser,
  input: { customerName?: string; customerPhone?: string; via?: "demo" | "counter" } = {}
): Promise<CaseView> & { id: string; ref: string } {
  requireCounter(u);
  const id = newId("case");
  const now = nowIso();
  const customer =
    input.customerName || input.customerPhone
      ? JSON.stringify({ name: (input.customerName || "").trim().slice(0, 80), phone: storedMobile(input.customerPhone), idType: null, idLast4: null })
      : null;

  let ref = "";
  let syncInserted = false;

  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    try {
      const sqlite = db();
      if (!u.storeId) throw new HttpError(403, "This account is not attached to a store.");
      const store = sqlite.prepare("SELECT * FROM stores WHERE id = ?").get(u.storeId) as StoreRow | undefined;
      if (store) {
        const seqRow = sqlite.prepare(
          "INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = counters.value + 1 RETURNING value"
        ).get(`case:${store.id}`) as { value?: number } | undefined;
        const seq = seqRow?.value ? Number(seqRow.value) : 1;
        ref = `SU-${store.code}-${String(seq).padStart(5, "0")}`;
        sqlite.prepare(
          `INSERT INTO cases (id, ref, org_id, store_id, advisor_id, status, customer, faults, coverage, demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, '[]', 'none', 0, ?, ?)`
        ).run(id, ref, store.org_id, store.id, u.id, customer, now, now);
        sqlite.prepare(
          `INSERT INTO audit (at, user_id, org_id, store_id, action, entity, entity_id, detail)
           VALUES (?, ?, ?, ?, 'case.create', 'case', ?, ?)`
        ).run(now, u.id, store.org_id, store.id, id, input.via ? JSON.stringify({ via: input.via === "counter" ? "counter code (customer-started)" : "standing demo code" }) : null);
        syncInserted = true;
      }
    } catch {
      // Fallback to asyncOp
    }
  }

  const asyncOp = (async () => {
    if (!syncInserted) {
      const store = await ownStore(u);
      const seq = await nextSeq(`case:${store.id}`);
      ref = `SU-${store.code}-${String(seq).padStart(5, "0")}`;
      await execute(
        `INSERT INTO cases (id, ref, org_id, store_id, advisor_id, status, customer, faults, coverage, demo, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,'[]','none',$7,$8,$9)`,
        [id, ref, store.org_id, store.id, u.id, customer, 0, now, now]
      );
      await audit({ userId: u.id, orgId: store.org_id, storeId: store.id, action: "case.create", entity: "case", entityId: id, ...(input.via ? { detail: { via: input.via === "counter" ? "counter code (customer-started)" : "standing demo code" } } : {}) });
    }
    return await getCase(u, id);
  })();

  return Object.assign(asyncOp, { id, ref });
}


const digitsOnly = (s?: string | null) => (s || "").replace(/\D/g, "");

/**
 * The store camera's word on a case and where each fault came from — written
 * by Apply on a SwapUp Check session, just before the case is updated and
 * re-priced (so an identity mismatch already blocks that re-price).
 */
export async function recordCameraCheck(caseId: string, check: CaseCameraCheck, sources: FaultSources): Promise<void> {
  await execute(
    `UPDATE cases SET camera_check = $1, fault_sources = $2, updated_at = $3 WHERE id = $4 AND status IN ('draft','quoted')`,
    [JSON.stringify(check), JSON.stringify(sources), nowIso(), caseId]
  );
}

/**
 * Where each fault came from, written on its own — by a Phonecheck attach,
 * BEFORE its updateCase (which reconciles from what is stored), the same way
 * Apply writes it with recordCameraCheck. Only while the case is at the counter.
 */
export async function recordFaultSources(caseId: string, sources: FaultSources): Promise<void> {
  await execute(
    `UPDATE cases SET fault_sources = $1, updated_at = $2 WHERE id = $3 AND status IN ('draft','quoted')`,
    [JSON.stringify(sources), nowIso(), caseId]
  );
}

/**
 * Staff unlocked the camera without the customer's phone echoing: the override is
 * kept on the case's camera record with its name and reason. It no longer marks
 * the LCD "not camera-checked" here — Apply decides, from what the sweep actually
 * did (a complete sweep proves the loop by its frames; lib/domain/gradeiqMap.ts).
 */
export async function markLcdOverride(caseId: string, info: { by: string; userId: string; reason: string; at: string; testSessionId: string }): Promise<void> {
  // Only while the case is at the counter — a locked trade-in's record is not rewritten.
  const row0 = await queryOne<{ camera_check: string | null }>(
    `SELECT camera_check FROM cases WHERE id = $1 AND status IN ('draft','quoted')`,
    [caseId]
  );
  if (!row0) return;
  const prev = parseJson<CaseCameraCheck | null>(row0.camera_check, null) ?? { ...blankCameraCheck(info.at), testSessionId: info.testSessionId };
  const next: CaseCameraCheck = { ...prev, lcdOverride: { by: info.by, reason: info.reason, at: info.at } };
  await execute(
    `UPDATE cases SET camera_check = $1, updated_at = $2 WHERE id = $3 AND status IN ('draft','quoted')`,
    [JSON.stringify(next), nowIso(), caseId]
  );
}

/** The phone's test colours count for a certification while its last word was "colours", this recently. */
const COLOURS_FRESH_MS = 10 * 60_000;

/**
 * "All fine — screen OK, body like new" (owner, 2026-10-19: "Skip and get on advisor app fast"):
 * the three taps of "Check the phone" in one, by the same rules — the liquid indicator "Can't see",
 * because nobody looked at it (honest: not inspected). What it actually taps on a case: allFineTaps —
 * and on a row the store camera confirmed worse, the camera's own chip (certify.ts allFineValue).
 */
export const ALL_FINE: readonly { row: CertRow; value: string }[] = [
  { row: "screen", value: "ok" },
  { row: "body", value: "like_new" },
  { row: "liquid", value: "cant_see" },
];

/**
 * What "All fine" taps on this case: ALL_FINE in order, only on the rows nobody has tapped yet. As
 * SwapUp Store's own button (swapup-mobile src/store/certify.ts allFineTaps) skips a liquid row
 * already tapped, here every row already certified keeps its tap: it was looked at, so an advisor's
 * liquid "Tripped" (and the water damage it put on the case) or a "Cracked" screen is never
 * overwritten by "fine" — the desk button doesn't show the rows it would change. The liquid
 * indicator only where the card asks for it (certifyNeeded). On an untapped card: the three taps.
 */
export function allFineTaps(
  c: { status: string; camera_check: string | null; certification: string | null; faults?: string | null },
  s: (GiqRow & { phone_phase_at?: string | null }) | null
): { row: CertRow; value: string }[] {
  const { block, screenHeld } = certifyBlock(c, s);
  const { needed, rows } = block;
  // A severe mark the partial screen sweep saw is never answered "fine" in one tap: the Screen is tapped by itself.
  return ALL_FINE.filter((t) => !rows[t.row] && (t.row !== "liquid" || needed.includes("liquid")) && (t.row !== "screen" || !screenHeld));
}

/**
 * THE ADVISOR CERTIFIES one row of "Check the phone" (lib/domain/certify.ts) —
 * one tap: the screen (the advisor's own look — since 0.9.4 the phone is never asked
 * for the test colours, and nothing waits for them), the body, or the liquid
 * indicator — or every row still untapped at once with
 * `allFine: true` (allFineTaps). By name (the signed-in staff member), with the time and whether
 * the phone was showing the colours. The faults, their sources, the condition
 * and the certification move in ONE transaction; then the report follows and
 * the case is re-priced outside it, as an edit is. Tapping the same value again
 * changes nothing. A tap better than what the store camera confirmed (tapFloor — before
 * Apply too) is refused 409 with the camera's sentence (certifyAgainstCamera) and nothing
 * is written — as the desk's condition save is; the reason is given there. "All fine" is
 * never refused: on a row the camera confirmed worse it taps the camera's own chip
 * (allFineValue). Store staff only, while the case is at the counter.
 */
export async function certifyCase(
  u: SessionUser,
  id: string,
  input: { row?: unknown; value?: unknown; testSessionId?: unknown; allFine?: unknown; legacyStore?: boolean },
): Promise<CaseView> {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff certify a phone.");
  const { c, store } = await caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) throw new HttpError(409, "The case is past the counter.");
  const allFine = input?.allFine === true;
  if (!allFine && !isCertRow(input?.row)) throw new HttpError(400, "Say which row: screen, body or liquid.");
  let session: { id: string; phone_phase: string | null; phone_phase_at: string | null } | undefined;
  if (input.testSessionId !== undefined && input.testSessionId !== null) {
    if (typeof input.testSessionId !== "string") throw new HttpError(400, "Send the test session's id.");
    session = (await queryOne<{ id: string; phone_phase: string | null; phone_phase_at: string | null }>(
      `SELECT id, phone_phase, phone_phase_at FROM test_sessions WHERE id = $1 AND case_id = $2`,
      [input.testSessionId, c.id]
    )) ?? undefined;
    if (!session) throw new HttpError(404, "Test session not found.");
  } else {
    session = (await queryOne<{ id: string; phone_phase: string | null; phone_phase_at: string | null }>(
      `SELECT id, phone_phase, phone_phase_at FROM test_sessions WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [c.id]
    )) ?? undefined;
  }
  const withColours = session?.phone_phase === "colours" && !!session.phone_phase_at && Date.now() - Date.parse(session.phone_phase_at) < COLOURS_FRESH_MS;
  // The session in full: "All fine" reads its card from it (allFineTaps), and the Screen's wait below.
  const full = session ? (await queryOne<GiqRow & { phone_phase_at?: string | null }>(`SELECT * FROM test_sessions WHERE id = $1`, [session.id])) : null;
  const taps: readonly { row: CertRow; value: string }[] = allFine
    ? allFineTaps(c, full)
    : [{ row: input.row as CertRow, value: typeof input.value === "string" ? input.value.trim().toLowerCase() : "" }];

  const out = await tx(async (client) => {
    const freshRes = await client.query(`SELECT * FROM cases WHERE id = $1`, [id]);
    const fresh = freshRes.rows[0] as CaseRow | undefined;
    if (!fresh || !EDITABLE.includes(fresh.status)) throw new HttpError(409, "The case is past the counter.");
    const prevFaults = parseJson<FaultId[]>(fresh.faults, []);
    const prevCondition = parseJson<ConditionAnswers | null>(fresh.condition, null);
    // What the camera confirmed for this session (before Apply too), less what a reason given on the
    // desk overruled ("Why it's better").
    const floor = tapFloor(parseJson<CaseCameraCheck | null>(fresh.camera_check, null), full);
    const prevCert = readCertification(parseJson<unknown>(fresh.certification, null));
    // Each tap on what the one before left — exactly as the taps one by one would.
    let r = { faults: prevFaults, sources: reconcileFaultSources(parseJson<FaultSources>(fresh.fault_sources, {}), prevFaults), condition: prevCondition, certification: prevCert as Certification };
    const at = nowIso();
    const done: { row: CertRow; value: string; prev: string | null; faultsAdded: FaultId[]; faultsRemoved: FaultId[] }[] = [];
    // "All fine" on what is stored now: a row tapped since (SwapUp Store, another desk) keeps its tap;
    // a row the camera confirmed worse gets the camera's own chip — nothing beyond what it saw.
    for (const t of allFine ? taps.filter((x) => !prevCert[x.row]).map((x) => ({ row: x.row, value: allFineValue(x.row, x.value, floor) })) : taps) {
      // Better than the camera confirmed: refused with the camera's sentence, as the desk's condition
      // save is (updateCase) — never recorded and quietly floored. Nothing is written. Except for a
      // SwapUp Store build from before 0.9.3 (no X-SwapUp-App): it sends "All fine" as single taps and
      // can't show a refusal mid-way, so its tap is recorded AS SENT and the condition is floored to the
      // camera, with the report's "camera stands" disclosure (DS10) — exactly what 0.9.2 did. Never the
      // camera's chip in the advisor's name: that would certify a finding they denied.
      const refused = input.legacyStore === true ? null : certifyAgainstCamera(t.row, t.value, floor);
      if (refused) throw new HttpError(409, refused);
      const step = certifyRow({ ...r, cameraFloor: floor }, { row: t.row, value: t.value, by: u.name, userId: u.id, at, withColours, testSessionId: session?.id ?? null });
      if ("error" in step) throw new HttpError(400, step.error);
      if (!step.changed) continue;
      done.push({ row: t.row, value: t.value, prev: r.certification[t.row]?.value ?? null, faultsAdded: step.faultsAdded, faultsRemoved: step.faultsRemoved });
      r = { faults: step.faults, sources: step.sources, condition: step.condition, certification: step.certification };
    }
    if (!done.length) return { changed: false, describes: false };
    const describes = JSON.stringify(r.faults) !== JSON.stringify(prevFaults) || JSON.stringify(r.condition) !== JSON.stringify(prevCondition);
    const now = nowIso();
    // Before Apply the case has no condition, and a tap doesn't invent one (Apply folds it in).
    await client.query(
      `UPDATE cases SET faults = $1, fault_sources = $2, condition = $3, certification = $4, partner_manual = CASE WHEN $5 THEN NULL ELSE partner_manual END, updated_at = $6
       WHERE id = $7 AND status IN ('draft','quoted')`,
      [JSON.stringify(r.faults), JSON.stringify(r.sources), r.condition ? JSON.stringify(r.condition) : null, JSON.stringify(r.certification), describes, now, id]
    );
    for (const d of done)
      await audit({
        userId: u.id,
        orgId: c.org_id,
        storeId: store.id,
        action: "case.certify",
        entity: "case",
        entityId: id,
        detail: { row: d.row, value: d.value, prev: d.prev, withColours, testSessionId: session?.id ?? null, faultsAdded: d.faultsAdded, faultsRemoved: d.faultsRemoved, ...(allFine ? { allFine: true } : {}) },
      });
    return { changed: true, describes };
  });
  if (!out.changed) return await getCase(u, id);
  // The report follows (a new version when its body moved), then the re-price — as updateCase does.
  await issueQuietly(id, "certified", u.id);
  return await reprice(u, id, { requote: out.describes });
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
  /** The government KYM answer, tapped right after the IMEI (contract I3); null clears it. */
  kymEarly?: { status?: unknown; reference?: unknown } | null;
  faults?: string[];
  coverage?: Coverage;
  condition?: unknown;
  /** Fill condition from the faults (keeps accessories/age). */
  conditionFromFaults?: boolean;
  customer?: { name?: string; phone?: string } | null;
  manualRepair?: { amount: number; reason: string } | null;
  /** The store's refurb cost (BUY vs SELL). Changes no price: the partner is not re-asked. */
  refurbCost?: { amount: number } | null;
  /**
   * Retired (owner, 2026-10-19): the trade-in price is the system's, never typed in. Anything but
   * null is refused (400) before the case is read; null changes nothing. Old SwapUp Store builds still send it.
   */
  partnerQuote?: unknown;
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

/** The refusal of a typed trade-in price (CasePatch.partnerQuote), word for word. */
export const PRICE_NOT_TYPED = "Prices can't be typed in — change what's wrong to change the price.";

/**
 * What only the server's own callers may say about a change — never the public
 * PATCH route, so staff can't record their own storage as "measured".
 *   variantSource    where patch.variant came from (Apply: the phone measured it,
 *                    the model has one size, or the customer typed it). Default "advisor".
 *   autoUpgrade      suggest the new phone (Apply), unless staff already chose one.
 *   measuredStorage  the size the phone read off its own disk (Apply), or null when
 *                    it didn't measure. Left out = unchanged.
 *   reportReason     the grading report's reason for a new version (lib/server/gradingReport.ts).
 */
export type UpdateInternal = {
  variantSource?: "measured" | "catalogue" | "customer";
  /** Where patch.modelId came from (Apply: the IMEI, the phone's code or the customer's pick; a Phonecheck attach). Default "advisor". */
  modelSource?: "imei" | "phone" | "customer" | "phonecheck";
  autoUpgrade?: boolean;
  measuredStorage?: string | null;
  /** Why the grading report gets a new version, when it does (default "edited"): Apply says "swapup_check", a Phonecheck attach "phonecheck". */
  reportReason?: ReportReason;
};

/**
 * The IMEI this patch saves, resolved — when it is new on the case and passes its check digit
 * (a misread is never paid for). Once per case + IMEI: an IMEI the case had before is answered
 * from cases.imei_lookup, with no call (fresh: false). Saving the IMEI the case already has → null.
 */
async function resolveNewImei(u: SessionUser, id: string, raw: unknown, withImei2: boolean): Promise<{ rec: StoredImeiLookup; fresh: boolean } | null> {
  if (typeof raw !== "string" || !raw) return null;
  const r = readImei(raw);
  if (!r.ok || r.checkDigit !== "valid") return null;
  const { c } = await caseInScope(u, id);
  if (!EDITABLE.includes(c.status) || r.imei === c.imei) return null;
  // The case's IMEI 2 as IMEI 1 with no IMEI 2 sent: updateCase refuses it — never paid for.
  if (!withImei2 && r.imei === c.imei2) return null;
  const cached = lookupFor(c.imei_lookup, r.imei);
  if (cached) return { rec: cached, fresh: false };
  return { rec: await resolveImei(r.imei, await tradeModelRefs(), nowIso()), fresh: true };
}

/**
 * Save what the advisor has learned about the device, then re-price.
 * Partner calls happen OUTSIDE any transaction.
 */
export async function updateCase(u: SessionUser, id: string, patch: CasePatch, internal: UpdateInternal = {}): Promise<CaseView> {
  requireCounter(u);
  // A typed trade-in price is refused before anything is read or written (no IMEI lookup, no half
  // save): what's wrong with the phone is the only thing that changes its price.
  if (patch.partnerQuote !== undefined && patch.partnerQuote !== null) throw new HttpError(400, PRICE_NOT_TYPED);
  // THE IMEI FIRST: a new IMEI is resolved once (lib/server/imeiResolve.ts) — the free TAC model and
  // GradeIQ's lookup (≤ 10 s) — BEFORE the case is read for the save, so no network call sits
  // between that read and the write.
  const resolved = await resolveNewImei(u, id, patch.imei, patch.imei2 !== undefined);
  const { c, store } = await caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) throw new HttpError(409, "The case is past the counter.");

  const sets: Record<string, unknown> = {};
  let pricingChanged = false;

  let imeiModel: string | null | undefined;
  if (patch.modelId === undefined && resolved) {
    const said = imeiModelNow(withTacName(resolved.rec), await tradeModelRefs());
    const claim = c.model_source === "customer";
    if (said.kind === "listed") {
      if (!c.model_id || claim || (c.model_source === "imei" && said.modelId !== c.model_id)) imeiModel = said.modelId;
    } else if (c.model_id && (c.model_source === "imei" || (claim && said.kind === "unlisted"))) imeiModel = null;
  }
  const modelPatch = patch.modelId !== undefined ? patch.modelId : imeiModel;
  if (modelPatch !== undefined) {
    const tm = modelPatch ? await getTradeModel(modelPatch) : null;
    if (modelPatch && !tm) throw new HttpError(400, "Unknown model.");
    sets.model_id = tm?.id ?? null;
    if (tm?.id !== c.model_id) {
      sets.variant = null;
      sets.variant_source = null;
    }
    pricingChanged = true;
  }
  const modelChanged = "model_id" in sets && sets.model_id !== c.model_id;
  if (modelChanged) sets.model_source = sets.model_id ? (patch.modelId !== undefined ? (internal.modelSource ?? "advisor") : "imei") : null;
  else if (patch.modelId && internal.modelSource === "phone" && c.model_source !== "phone") sets.model_source = "phone";
  else if (sets.model_id && c.model_source === "customer" && (imeiModel !== undefined || internal.modelSource === "imei")) sets.model_source = "imei";
  let variantChanged = false;
  if (patch.variant !== undefined) {
    const tm = await getTradeModel((sets.model_id as string | undefined) ?? c.model_id);
    const variants = tm ? parseJson<string[]>(tm.variants, []) : [];
    if (patch.variant && !variants.includes(patch.variant)) throw new HttpError(400, "No such storage for this model.");
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
      if (patch.imei2 === undefined && r.imei !== c.imei && r.imei === c.imei2)
        throw new HttpError(400, "IMEI 1 can't be the same as IMEI 2 — that number is this case's IMEI 2.");
      sets.imei = r.imei;
      sets.imei_check = r.checkDigit;
    }
    if (patch.imei2 === undefined && sets.imei !== c.imei && (c.imei2 || c.imei2_check)) {
      sets.imei2 = null;
      sets.imei2_check = null;
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
      if (first && r.imei === first) throw new HttpError(400, "IMEI 2 can't be the same as IMEI 1.");
      sets.imei2 = r.imei;
      sets.imei2_check = r.checkDigit;
    }
  }
  if (resolved && sets.imei === resolved.rec.imei) {
    sets.imei_lookup = withLookup(c.imei_lookup, resolved.rec);
    if (resolved.fresh)
      await audit({
        userId: u.id,
        orgId: c.org_id,
        storeId: store.id,
        action: "case.imei_lookup",
        entity: "case",
        entityId: id,
        detail: { source: resolved.rec.source, blacklist: resolved.rec.blacklist, modelId: resolved.rec.modelId, modelKind: resolved.rec.modelKind ?? null, modelNumber: resolved.rec.modelNumber, ...(imeiModel !== undefined ? { setModel: imeiModel } : {}) },
      });
  }
  const numbersChanged = ("imei" in sets && sets.imei !== c.imei) || ("imei2" in sets && sets.imei2 !== c.imei2);
  if (numbersChanged && patch.kymEarly === undefined && c.kym_early) sets.kym_early = null;
  if (patch.kymEarly !== undefined) {
    if (patch.kymEarly === null) sets.kym_early = null;
    else {
      if (typeof patch.kymEarly !== "object" || Array.isArray(patch.kymEarly)) throw new HttpError(400, "Send the KYM answer as {status, reference}.");
      if (!("imei" in sets ? sets.imei : c.imei)) throw new HttpError(400, "Record the IMEI first (dial *#06#).");
      const status = String(patch.kymEarly.status ?? "");
      if (!Object.hasOwn(KYM_LABEL, status)) throw new HttpError(400, "Record the KYM IMEI check result.");
      const reference = String(patch.kymEarly.reference ?? "").trim().slice(0, 80) || null;
      sets.kym_early = JSON.stringify({ status: status as KymStatus, reference, by: u.name, at: nowIso() } satisfies KymEarly);
      await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.kym_early", entity: "case", entityId: id, detail: { status, reference } });
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
  }
  if (patch.condition !== undefined) {
    const next = patch.condition === null ? null : cleanCondition(patch.condition);
    sets.condition = next === null ? null : JSON.stringify(next);
    pricingChanged = true;
    if (next && patch.faults === undefined) {
      const r = faultsAfterConditionEdit(faults, reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults), next);
      if (r.faults !== faults) {
        faults = r.faults;
        sets.faults = JSON.stringify(faults);
        sets.fault_sources = JSON.stringify(r.sources);
      }
    }
  }
  const camera = parseJson<CaseCameraCheck | null>(c.camera_check, null);
  if (patch.conditionFromFaults) {
    const prev = parseJson<ConditionAnswers | null>((sets.condition as string | undefined) ?? c.condition, null);
    const base = prev ? { accessories: prev.accessories, age: prev.age } : { accessories: { charger: true, box: false, bill: false }, age: "gt11m" as const };
    const filled = conditionFromFaults(faults, base);
    sets.condition = JSON.stringify(camera ? applyCameraFloor(filled, camera.floor) : filled);
    pricingChanged = true;
  }
  if ("faults" in sets && !("fault_sources" in sets)) sets.fault_sources = JSON.stringify(reconcileFaultSources(parseJson<FaultSources>(c.fault_sources, {}), faults));
  if (camera && (patch.faults !== undefined || patch.condition !== undefined || patch.conditionFromFaults || patch.cameraOverride)) {
    const answers = parseJson<ConditionAnswers | null>((sets.condition as string | undefined) ?? c.condition, null);
    const covered = new Set(camera.overrides.flatMap((o) => o.items));
    const problems = cameraOverrideProblems(answers, faults, camera).filter((p) => !covered.has(p.key));
    const reason = String(patch.cameraOverride?.reason ?? "").trim().slice(0, 300);
    const next: CaseCameraCheck = { ...camera, overrides: [...camera.overrides] };
    let changed = false;
    if (problems.length) {
      if (reason.length < CAMERA_REASON_MIN) throw new HttpError(409, problems[0].why);
      next.overrides.push({ by: u.name, userId: u.id, reason, at: nowIso(), items: problems.map((p) => p.key) });
      changed = true;
    }
    if (patch.cameraOverride?.identity && identityBlock(camera)) {
      if (u.role !== "store_manager") throw new HttpError(403, "Only a store manager can override the camera's identity check.");
      if (reason.length < CAMERA_REASON_MIN) throw new HttpError(400, "Say how you checked it's this phone.");
      next.identityOverride = { by: u.name, userId: u.id, reason, at: nowIso(), items: ["identity"] } satisfies RecordedOverride;
      changed = true;
      pricingChanged = true;
    }
    if (changed) {
      sets.camera_check = JSON.stringify(next);
      await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.camera_override", entity: "case", entityId: id, detail: { reason, items: problems.map((p) => p.key), identity: !!next.identityOverride && !camera.identityOverride } });
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
      if (reason.length < 8) throw new HttpError(400, "Say where the quote comes from.");
      sets.manual_repair = JSON.stringify({ amount, reason, by: u.name } satisfies ManualQuote);
    }
  }
  if (patch.refurbCost !== undefined) {
    if (patch.refurbCost === null) sets.refurb_cost = null;
    else {
      const amount = Number(patch.refurbCost.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 500_000) throw new HttpError(400, "Refurb cost must be a whole rupee amount up to ₹5,00,000.");
      sets.refurb_cost = JSON.stringify({ amount, by: u.name, at: nowIso() } satisfies RefurbCost);
    }
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.refurb_cost", entity: "case", entityId: id, detail: { amount: patch.refurbCost?.amount ?? null } });
  }
  const describes = modelPatch !== undefined || variantChanged || patch.faults !== undefined || patch.condition !== undefined || patch.conditionFromFaults;
  if (describes && c.partner_manual) sets.partner_manual = null;
  if (patch.upgradeDeviceId !== undefined) {
    if (!patch.upgradeDeviceId) sets.upgrade = null;
    else {
      const d = await queryOne<{ id: string; brand: string; model: string; series: string; variant: string; price: number; support_end_year: number | null }>(
        `SELECT * FROM new_devices WHERE id = $1 AND org_id = $2 AND active = 1`,
        [patch.upgradeDeviceId, store.org_id]
      );
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

  const prevUpgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
  const phoneChanged = modelChanged || variantChanged;
  const autoUpgrade = patch.upgradeDeviceId === undefined && (internal.autoUpgrade || phoneChanged) && (!prevUpgrade || prevUpgrade.suggested === true);
  if (autoUpgrade) {
    const tm = await getTradeModel("model_id" in sets ? (sets.model_id as string | null) : c.model_id);
    const measured = "measured_storage" in sets ? (sets.measured_storage as string | null) : c.measured_storage;
    const variant = ("variant" in sets ? (sets.variant as string | null) : c.variant) ?? measured;
    const catalogue = await newDevices(store.org_id);
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
    const setClauses = cols.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
    await execute(
      `UPDATE cases SET ${setClauses} WHERE id = $${cols.length + 1} AND status IN ('draft','quoted')`,
      [...cols.map((k) => sets[k]), id]
    );
  }
  await issueQuietly(id, internal.reportReason ?? "edited", u.id);
  return await reprice(u, id, { requote: pricingChanged });
}

/**
 * Recompute everything derived: repair estimate, partner quotes (when pricing
 * inputs changed or the quote is missing/expired), bonus and decision.
 */
export async function reprice(u: SessionUser, id: string, opts: { requote?: boolean } = {}): Promise<CaseView> {
  const { c, store } = await caseInScope(u, id);
  if (!EDITABLE.includes(c.status)) return await toView(c, store);
  const org = (await getOrg(c.org_id))!;
  const settings = await orgSettings(org.id);
  const tm = await getTradeModel(c.model_id);
  const faults = parseJson<FaultId[]>(c.faults, []);
  const condition = parseJson<ConditionAnswers | null>(c.condition, null);
  const manual = parseJson<ManualQuote | null>(c.manual_repair, null);

  // 1. Repair estimate — needs only the model and the faults. Defaults to ₹5,000 when no specific repair quote is present.
  let repair: RepairEstimate | null = null;
  const serviced = !tm || !org.target_brand || tm.brand === org.target_brand;
  if (tm && (manual || (faults.length && serviced))) {
    const rawBook = await query<{ model_id: string; part: string; price: number; source: string }>(
      `SELECT model_id, part, price, source FROM repair_book WHERE org_id = $1 AND model_id = $2`,
      [org.id, tm.id]
    );
    const book = rawBook.map((r) => ({ modelId: r.model_id, part: r.part, price: r.price, source: parseJson(r.source, { kind: "client", label: "Price book" }) }) as RepairBookEntry);
    const rp = settings.repairPolicy;
    const policy = {
      labour: rp.labourByTier[tm.service_tier] ?? rp.labourByTier.other ?? 0,
      carePlusFee: tm.care_plus_fee ?? rp.carePlusFeeDefault,
      gstBp: rp.gstBp,
    };
    repair = estimateRepair({ book, modelId: tm.id, faults, coverage: c.coverage, policy, manual });
  }

  // 2. The trade-in quote and the repaired value — only with a complete, consistent description of
  //    the phone. Always the system's: tradeIn.ts asks, best first.
  let quote = storedQuote(c.quote);
  let repairedQuote = parseJson<PartnerQuote | null>(c.repaired_quote, null);
  const consistent = !!condition && conditionFloor(condition, faults).length === 0;
  // A quote from a source that no longer exists (an older build's) is re-asked like a lapsed one.
  const expired = (!!quote?.validUntil && Date.parse(quote.validUntil) < Date.now()) || (!!quote && retiredSource(quote.source?.kind));
  const partnerId = await orgPartnerId(org.id);
  // The camera says this is not the phone on the case: no price until a store manager resolves it.
  const blocked = identityBlock(parseJson<CaseCameraCheck | null>(c.camera_check, null));
  if (!tm || !c.variant || !condition || !consistent || blocked) {
    quote = null;
    repairedQuote = null;
  } else if (opts.requote || !quote || expired || quote.source.kind === "partner_manual" || quote.status !== "priced") {
    // Asked again whenever there is no good price to stand on: the description changed, none yet,
    // expired, an older build's typed quote, or nothing priced it last time (a rate card uploaded
    // since reaches the case on its next re-price, with nobody touching it).
    // PriceIQ less the markdown and defects, else the partner's rate card, else no price (tradeIn.ts).
    quote = await tradeInQuote({
      partnerId,
      modelId: tm.id,
      variant: c.variant,
      brand: tm.brand,
      model: tm.model,
      answers: condition,
      imei: c.imei,
      validityDaysOverride: settings.quoteValidityDays,
    });
    if (!faults.length) repairedQuote = quote.status === "priced" ? { ...quote, validUntil: null } : quote;
    else if (quote.source.kind === "priceiq") {
      // Beside a PriceIQ trade-in, the repaired value is PriceIQ's too: the grade after refurb, less
      // the markdown. Where it has none, the partner's rate card may supply one, else there is none.
      repairedQuote = await priceiqRepaired({ partnerId, modelId: tm.id, variant: c.variant, brand: tm.brand, model: tm.model, answers: condition, faults }, quote);
      if (!repairedQuote) {
        const what = await partnerQuote({ partnerId, modelId: tm.id, variant: c.variant, answers: healedCondition(condition, faults), whatIf: true });
        repairedQuote = what.status === "priced" ? what : null;
      }
    } else {
      const what = await partnerQuote({ partnerId, modelId: tm.id, variant: c.variant, answers: healedCondition(condition, faults), whatIf: true });
      repairedQuote = what.status === "priced" ? what : null;
    }
  }

  // 2b. Storage unknown: the partner's what-if price for EACH size, so the answer
  //     asks with one row of priced chips instead of a form — never a guessed
  //     size. Kept only while the storage is unknown; asked again only when the
  //     description changed (requote), there are none yet, or none of them is priced
  //     (as the case quote: a card uploaded since prices them). Never for a phone that
  //     measured a size off the model's list: every size on it is one the phone has
  //     ruled out, so there is nothing to offer and nothing to ask the partner.
  let storageQuotes = parseJson<StorageQuote[] | null>(c.storage_quotes, null);
  const sizes = tm ? parseJson<string[]>(tm.variants, []) : [];
  const measuredOffList = !!c.measured_storage && !sizes.includes(c.measured_storage);
  if (tm && !c.variant && condition && consistent && !blocked && !measuredOffList) {
    if (opts.requote || !storageQuotes || storageQuotes.every((s) => s.amount === null)) {
      // Each size priced the way the trade-in itself will be, so the chip and the answer agree —
      // asked together, so a slow PriceIQ costs the counter one wait, not one per size.
      const out: StorageQuote[] = await Promise.all(
        sizes.map(async (v) => {
          const w = await tradeInQuote({ partnerId, modelId: tm.id, variant: v, brand: tm.brand, model: tm.model, answers: condition, whatIf: true });
          const priced = w.status === "priced" && w.amount !== null;
          return {
            variant: v,
            amount: priced ? w.amount : null,
            reason: priced ? null : (w.reason ?? null),
            ...(priced && w.priceiq?.note ? { note: w.priceiq.note } : {}),
            // Why PriceIQ had no price for this size, while it is connected: then no chip's "no price" is final (SUP-32).
            ...(!priced && w.priceiqWhy ? { priceiqWhy: w.priceiqWhy } : {}),
          };
        })
      );
      storageQuotes = out.length ? out : null;
    }
  } else storageQuotes = null;

  // 3. Bonus — from the best active campaign for this upgrade. Its basis is the MARKET price, so a
  //    trade-in-value campaign never compounds the SwapUp premium.
  const upgrade = parseJson<UpgradeChoice | null>(c.upgrade, null);
  const market = quote?.status === "priced" ? quote.amount : null;
  const repairedVal = repairedQuote?.status === "priced" ? repairedQuote.amount : null;
  const repairPays = repair?.status === "quoted" ? repair.customerPays : null;
  const repairRatio = repairPays !== null && repairedVal ? repairPays / repairedVal : null;
  let bonus: BonusApplied | null = parseJson<BonusApplied | null>(c.bonus, null);
  if (upgrade && tm) {
    const campaigns: Campaign[] = await activeCampaigns(org.id);
    const best = bestCampaign(campaigns, {
      today: todayIso(),
      oldBrand: tm.brand,
      oldAgeYears: tm.release_year ? Math.max(0, thisYear() - tm.release_year) : null,
      targetSeries: upgrade.series,
      newPrice: upgrade.price,
      tradeInValue: market ?? 0,
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

  // 4. Decision — the as-is value is what the customer is paid: the market price + the SwapUp
  //    premium (premium.ts, the rule exchange() and the lock use). The bonus is for display only.
  const bonusAmount = bonus ? (bonus.override?.amount ?? bonus.amount) : 0;
  const premium = premiumOn(market)?.amount ?? 0;
  const wePay = market === null ? null : market + premium;
  const decision = decide({
    repairPays,
    repairCovered: repair?.status === "quoted" && repair.customerPays === 0 && repair.coverage !== "none" && repair.basis === "book",
    repairedValue: repairedVal,
    asIsValue: wePay,
    premium,
    valueSource: quote?.source.kind ?? null,
    upgrade: upgrade ? { label: upgrade.label, newPrice: upgrade.price, bonus: bonusAmount, supportEndYear: upgrade.supportEndYear } : null,
    old: { ageYears: tm?.release_year ? Math.max(0, thisYear() - tm.release_year) : null, supportEndYear: tm?.support_end_year ?? null },
    thisYear: thisYear(),
    // Default repair estimate (₹5,000) is always available for customer comparison.
    nothingToRepair: false,
    faultCount: faults.length,
    systemicFault: faults.some((f) => ["water_damage", "no_power", "no_network", "frame_damage"].includes(f)),
    swollenBattery: faults.includes("battery_swollen"),
    thresholds: settings.thresholds,
  });

  const status: CaseStatus = market !== null || repairPays !== null ? "quoted" : "draft";
  await execute(
    `UPDATE cases SET repair = $1, quote = $2, repaired_quote = $3, storage_quotes = $4, bonus = $5, decision = $6, status = $7, updated_at = $8
     WHERE id = $9 AND status IN ('draft','quoted')`,
    [
      repair ? JSON.stringify(repair) : null,
      quote ? JSON.stringify(quote) : null,
      repairedQuote ? JSON.stringify(repairedQuote) : null,
      storageQuotes ? JSON.stringify(storageQuotes) : null,
      bonus ? JSON.stringify(bonus) : null,
      JSON.stringify(decision),
      status,
      nowIso(),
      id
    ]
  );
  return await getCase(u, id);
}

export async function setBonusOverride(u: SessionUser, id: string, input: { bp: number | null; reason?: string }): Promise<CaseView> {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can change the bonus.");
  const { c, store } = await caseInScope(u, id);
  if (c.status !== "quoted") throw new HttpError(409, "The bonus can only be changed before the trade-in is locked.");
  const bonus = parseJson<BonusApplied | null>(c.bonus, null);
  if (!bonus) throw new HttpError(409, "Choose the new phone first.");
  const campaigns = await activeCampaigns(c.org_id);
  const campaign = campaigns.find((x) => x.id === bonus.campaignId);
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
  await execute(`UPDATE cases SET bonus = $1, updated_at = $2 WHERE id = $3`, [JSON.stringify(bonus), nowIso(), id]);
  await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.bonus_override", entity: "case", entityId: id, detail: bonus.override });
  // The decision shows the bonus; recompute it without asking the partner again.
  return await reprice(u, id, { requote: false });
}

export async function chooseRepair(u: SessionUser, id: string): Promise<CaseView> {
  requireCounter(u);
  return await tx(async (client) => {
    const { c, store } = await caseInScope(u, id);
    assertTransition(c.status, "repair_chosen");
    const now = nowIso();
    await client.query(`UPDATE cases SET status = 'repair_chosen', closed_at = $1, updated_at = $2 WHERE id = $3`, [now, now, id]);
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.repair_chosen", entity: "case", entityId: id });
    return await getCase(u, id);
  });
}

export async function walkAway(u: SessionUser, id: string, reason?: string): Promise<CaseView> {
  requireCounter(u);
  return await tx(async (client) => {
    const { c, store } = await caseInScope(u, id);
    assertTransition(c.status, "walked_away");
    const now = nowIso();
    const why = (reason || "").trim().slice(0, 200) || null;
    await client.query(`UPDATE cases SET status = 'walked_away', closed_reason = $1, closed_at = $2, updated_at = $3 WHERE id = $4`, [why, now, now, id]);
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.walked_away", entity: "case", entityId: id, detail: { reason: reason ?? null } });
    return await getCase(u, id);
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
 * Take the trade-in: the customer gets the market price + the SwapUp premium +
 * the bonus off the new phone, the store keeps the old phone, and the MARKET
 * price is HELD on the store's credit line until the partner collects (or
 * clears) it. The premium, like the bonus, is the programme's: frozen here
 * (premium_value, premium_bp, premium_funded_by) and claimed on /admin/claims,
 * never a hold and never a chargeback.
 */
export async function lockTradeIn(u: SessionUser, id: string, input: LockInput): Promise<CaseView> {
  requireCounter(u);
  // Reported lost or stolen (GSMA, for any IMEI the case ever had): refused before anything else is
  // asked, whatever the lock says. The early KYM answer is not asked here: the lock's own is.
  const inScope = await caseInScope(u, id);
  if (gsmaBlacklisted(inScope.c)) throw new HttpError(409, BLACKLISTED, { reason: "blacklisted" });
  const name = String(input?.customer?.name || "").trim();
  const phone = digitsOnly(input?.customer?.phone);
  const idType = String(input?.customer?.idType || "");
  const idLast4 = String(input?.customer?.idLast4 || "").trim().toUpperCase();
  if (name.length < 2) throw new HttpError(400, "Enter the customer's name.");
  if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, "Enter a 10-digit Indian mobile number.");
  if (!ID_TYPES.includes(idType)) throw new HttpError(400, "Choose the customer's ID document.");
  if (!/^[A-Z0-9]{4}$/.test(idLast4)) throw new HttpError(400, "Enter the ID's last 4 characters.");
  const ch = input?.checks ?? ({} as LockInput["checks"]);
  const missing = [
    !ch.ownership && "owner confirmed",
    !ch.simRemoved && "SIM and memory card out",
    !ch.imeiMatches && "IMEI matches",
    !ch.noFinanceLock && "no EMI or company lock",
    !ch.kym?.status && "KYM IMEI check done",
  ].filter(Boolean);
  if (missing.length) throw new HttpError(400, `Confirm first: ${missing.join(", ")}.`);
  // Since 22 Oct 2025 a buyer of a used phone must check the national IMEI
  // register before completing the purchase. A flagged phone is never bought.
  // This answer supersedes the early one (kymEarly, tapped right after the IMEI):
  // a mis-tap there is corrected here, and the lock's answer is stored back.
  const kymStatus = ch.kym.status;
  if (!(kymStatus in KYM_LABEL)) throw new HttpError(400, "Record the KYM IMEI check result.");
  if (kymStatus !== "clear")
    throw new HttpError(409, `IMEI register says "${KYM_LABEL[kymStatus]}" — do not take it.`);
  const kymRef = String(ch.kym.reference ?? "").trim().slice(0, 80) || null;

  return await tx(async (client) => {
    const { c, store } = await caseInScope(u, id);
    if (gsmaBlacklisted(c)) throw new HttpError(409, BLACKLISTED, { reason: "blacklisted" });
    const view = await toView(c, store);
    assertTransition(c.status, "locked");
    // A claimed storage is enough to SHOW a price; moving money needs it seen —
    // the same rule as the IMEI, one tick, and only when the phone couldn't measure it.
    if (c.variant_source === "customer" && ch.storageSeen !== true)
      throw new HttpError(400, `Confirm Settings › About phone shows ${c.variant}.`);
    if ((view.imeiCheck === "invalid" || view.imei2Check === "invalid") && !ch.imeiCheckAck)
      throw new HttpError(400, "IMEI fails its check digit — re-read *#06# or confirm it.");
    const blockers = view.lockBlockers;
    if (blockers.length) throw new HttpError(409, blockers[0]);

    // One phone, one trade-in — matched on EITHER of its IMEIs, so presenting
    // the second number of a dual-SIM phone does not get it past the check.
    const dup = await imeiOnOpenTradeIn(c.id, [c.imei, c.imei2]);
    if (dup) throw new HttpError(409, `IMEI already traded in (${dup.ref}, ${dup.name}).`);

    const M = view.quote!.amount!;
    const check = canHold(await storePolicy(store), await storeEvents(store.id), M);
    if (!check.ok) throw new HttpError(409, check.reason);
    const B = view.bonus ? (view.bonus.override?.amount ?? view.bonus.amount) : 0;
    const price = parseJson<UpgradeChoice | null>(c.upgrade, null)!.price;
    // The one formula (premium.ts): we pay M + P, hold M, the customer pays the rest — never floored.
    let x: ReturnType<typeof exchange>;
    try {
      x = exchange({ market: M, bonus: B, newPrice: price });
    } catch (e) {
      if (e instanceof RuleError) throw new HttpError(409, e.message);
      throw e;
    }
    const payable = x.customerPays;
    const org = await getOrg(c.org_id);
    const premiumFundedBy = org?.name ?? "The programme";
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

    // The early KYM answer, superseded by the lock's (clear) one — stored back, so the record
    // never says "duplicate" on a phone taken as clear. None tapped early → none written.
    const early = parseJson<KymEarly | null>(c.kym_early, null);
    const supersede = !!early && (early.status !== "clear" || (early.reference ?? null) !== kymRef);
    const kymEarly = supersede ? JSON.stringify({ status: "clear", reference: kymRef, by: u.name, at: now } satisfies KymEarly) : c.kym_early;

    const upd = await client.query(
      `UPDATE cases SET status = 'locked', customer = $1, checks = $2, kym_early = $3, trade_value = $4, premium_value = $5, premium_bp = $6, premium_funded_by = $7, bonus_value = $8, payable = $9, locked_at = $10, updated_at = $11
       WHERE id = $12 AND status = 'quoted'`,
      [JSON.stringify(customer), JSON.stringify(checks), kymEarly, M, x.premium, x.premiumBp, premiumFundedBy, B, payable, now, now, id]
    );
    if ((upd.rowCount ?? 0) !== 1) throw new HttpError(409, "This case changed — reload.");
    if (supersede)
      await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.kym_early", entity: "case", entityId: id, detail: { status: "clear", reference: kymRef, supersedes: early!.status, at: "lock" } });
    await postEvents(store.id, [{ kind: "hold", caseId: id, amount: x.hold, at: now, note: `Trade-in ${c.ref}` }], u.id);
    // The report as it stands at hand-over, frozen: the partner's evidence at pickup and clearance.
    // Inside this transaction, so it is exactly the phone that was locked (issuing reads only the database).
    await issueQuietly(id, "traded_in", u.id, { final: true });
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.lock", entity: "case", entityId: id, detail: { tradeValue: M, premium: { amount: x.premium, bp: x.premiumBp, rule: PREMIUM_RULE_VERSION, fundedBy: premiumFundedBy }, wePay: x.wePay, bonus: B, payable, source: view.quote!.source.kind, kym: checks.kym, storage: { variant: c.variant, source: c.variant_source, seen: checks.storageSeen === true } } });
    return await getCase(u, id);
  });
}

export async function cancelTradeIn(u: SessionUser, id: string, reason: string): Promise<CaseView> {
  if (!["store_manager", "org_admin", "platform"].includes(u.role)) throw new HttpError(403, "Only a store manager can cancel a trade-in.");
  if ((reason || "").trim().length < 4) throw new HttpError(400, "Say why the trade-in is cancelled.");
  return await tx(async (client) => {
    const { c, store } = await caseInScope(u, id);
    assertTransition(c.status, "cancelled");
    const now = nowIso();
    const upd = await client.query(
      `UPDATE cases SET status = 'cancelled', closed_reason = $1, closed_at = $2, updated_at = $3 WHERE id = $4 AND status = 'locked'`,
      [reason.trim().slice(0, 200), now, now, id]
    );
    if ((upd.rowCount ?? 0) !== 1) throw new HttpError(409, "This case changed — reload.");
    await postEvents(store.id, cancelEvents(id, c.trade_value!, now), u.id);
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.cancel", entity: "case", entityId: id, detail: { reason: reason.trim() } });
    return await getCase(u, id);
  });
}

/**
 * Record that the customer cleared the phone after accepting the trade-in:
 * signed out of their accounts, factory-reset it from Settings, and it came
 * back to a setup screen that does not ask for their account. Store staff
 * only, while the phone is at the store. Recorded once.
 */
export async function recordDataClear(u: SessionUser, id: string, input: Record<string, unknown>): Promise<CaseView> {
  requireCounter(u);
  const missing = missingDataClearSteps(input);
  if (missing.length) throw new HttpError(400, `Confirm first: ${missing.join("; ")}.`);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || null : null;
  return await tx(async (client) => {
    const { c, store } = await caseInScope(u, id);
    if (!DATA_CLEAR_STATUSES.includes(c.status)) throw new HttpError(409, "Record data clearing after the trade-in, at the store.");
    if (c.data_clear) throw new HttpError(409, "Data clearing is already recorded for this phone.");
    const now = nowIso();
    const record: DataClearRecord = {
      label: DATA_CLEAR_LABEL,
      steps: Object.fromEntries(DATA_CLEAR_STEPS.map(([k]) => [k, true])) as DataClearRecord["steps"],
      note,
      by: u.name,
      at: now,
    };
    const upd = await client.query(
      `UPDATE cases SET data_clear = $1, updated_at = $2 WHERE id = $3 AND data_clear IS NULL`,
      [JSON.stringify(record), now, id]
    );
    if ((upd.rowCount ?? 0) !== 1) throw new HttpError(409, "This case changed — reload.");
    await audit({ userId: u.id, orgId: c.org_id, storeId: store.id, action: "case.data_clear", entity: "case", entityId: id, detail: { note } });
    return await getCase(u, id);
  });
}
