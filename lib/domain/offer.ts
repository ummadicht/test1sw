/**
 * THE ANSWER — what the customer is shown after the test, on one screen:
 *
 *     Refurb quote          vs     Trade-in + bonus
 *     what fixing it costs         the as-is price + the upgrade bonus
 *
 * "Why asking questions when we have all tested data … just refurb quote vs
 * bonus + trade in price." Everything here is already on the case: the test
 * filled the model, faults and condition, the price book priced the repair, the
 * trade-in was priced by the system (PriceIQ's refurbished-market price at the grade
 * less the 5%→2% markdown and a % per defect, else the partner's uploaded rate card —
 * lib/server/tradeIn.ts; none of them → "No market price yet", with the reason) and
 * SwapUp suggested the new one. Staff never type a trade-in price: what's wrong with
 * the phone is the only thing that changes it.
 * This file only arranges it and says, in the server's words, what is still
 * missing and why. `swap.tradeInDetail` says how the trade-in was reached.
 *
 * "Refurb quote" is the CUSTOMER's repair price (repair.customerPays, a bench
 * quote, or ₹0 under cover) — the figure decide() compares and the bonus's
 * repair-ratio rule reads. It is never the store's own refurb cost: that is the
 * store's margin, staff-only, and has no place beside the customer's choice.
 *
 * Nothing here decides anything. The verdict is decide()'s headline, unchanged;
 * the bonus is shown and never a reason. When a number is missing, `asks` says
 * which ONE thing would fill it — never a form, never a guessed size.
 *
 * "We pay you" is the market price (the trade-in quote) plus the SwapUp premium
 * (lib/domain/premium.ts); `swap.customerPays` is exchange()'s, the same formula the
 * lock charges. `answer` is the same answer in the lines every screen prints
 * (lib/domain/answer.ts).
 *
 * Pure: no database, no clock. The app mirrors these types (src/store/offer.ts)
 * and shows these strings; it owns only the labels.
 */

import { SWOLLEN_BATTERY_CAVEAT, type Decision, type Recommendation } from "./decision.ts";
import type { Coverage, ManualQuote, RepairEstimate } from "./repair.ts";
import type { PriceSourceKind, QuoteLine } from "./ratecard.ts";
import type { ConditionAnswers } from "./condition.ts";
import type { MarketGrade } from "./marketSell.ts";
import { fmtBp } from "./money.ts";
import { tradeInLine, type PriceiqMeta } from "./priceiqTradeIn.ts";
import { exchange, premiumOn, NEW_PHONE_TOO_CHEAP } from "./premium.ts";
import { buildAnswer, TRADED_STATUSES, type Answer } from "./answer.ts";

/* ─────────────────────────── the contract (docs/MOBILE-API.md §3c) ─────────────────────────── */

/** Where the case's storage came from. measured = the phone's own disk reading; customer = a claim. */
export type VariantSource = "measured" | "catalogue" | "customer" | "advisor";

/** One storage chip: the what-if trade-in at that size, priced the way the trade-in will be; null = nothing prices it. */
export type StorageOption = { variant: string; tradeIn: number | null };

export type OfferAsk =
  | { kind: "blocked"; title: string; text: string }
  | { kind: "model"; title: string; text: string }
  /**
   * `note` — the market data's age ("Refurbished market price, week 2026-W35, 52 days old.") or
   * "PriceIQ unreachable, last answer …" when a chip's price carries it, else null.
   * `options` is empty when the phone measured a size the model's list doesn't have: no chip
   * may offer a size the phone has ruled out.
   */
  | { kind: "storage"; title: string; text: string; options: StorageOption[]; note: string | null }
  /** Nothing priced the phone: text only, the reason why (the rate card, PriceIQ). Never a form — no price is typed in. */
  | { kind: "no_price"; title: string; text: string }
  | { kind: "repair_quote"; title: string; text: string }
  | { kind: "new_phone"; title: string; text: string };

export type Offer = {
  /** The case is still at the counter (draft or quoted). */
  open: boolean;
  headline: string;
  /** One sentence under the headline. */
  reason: string | null;
  /** decision.recommendation — null when there is no decision. */
  recommendation: Recommendation | null;
  /** repair → "repair"; upgrade | no_repair → "swap"; either | cannot_say → null. */
  recommended: "repair" | "swap" | null;
  /** Ordered: blocked, model, storage, no_price, repair_quote, new_phone. Empty once the case is closed. */
  asks: OfferAsk[];
  storage: { variant: string | null; source: VariantSource | null; note: string | null };
  /** THE refurb quote — what the customer pays to fix it. */
  repair: {
    amount: number | null;
    covered: boolean;
    basis: "book" | "manual" | null;
    detail: string | null;
    why: string | null;
    nothingToRepair: boolean;
    coverage: Coverage;
  };
  swap: {
    /** The market price M — the buyback partner's quote (locked: trade_value). */
    tradeIn: number | null;
    tradeInNote: string | null;
    /** The SwapUp premium on M (premium.ts); null without M, or on a case locked before premiums. */
    premium: { amount: number; bp: number } | null;
    /** What we pay for the phone: tradeIn + premium; null when tradeIn is null. */
    wePay: number | null;
    bonus: number | null;
    bonusBp: number | null;
    bonusWhy: string | null;
    /** wePay + (bonus ?? 0); null when tradeIn is null. */
    total: number | null;
    /** Why tradeIn is null. */
    why: string | null;
    /**
     * How the trade-in was reached, for the tile's one line and its closed "Show details". null without
     * a trade-in.
     *   line   PriceIQ only: "PriceIQ Good ₹51,399 − 2% − 2 defects" (+ " · none at Superb" when a lower
     *          grade was used). null for any other source.
     *   lines  each step after the base, in order: the markdown, one line per defect with its %, then any
     *          cap, minimum or rounding — "Rear camera faulty · 18% · −₹9,251". A rate-card quote lists its
     *          best-condition price first. Empty for a single-figure quote.
     *   note   why PriceIQ didn't price it, when the partner's rate card did instead.
     */
    tradeInDetail: { line: string | null; lines: { label: string; pct: string | null; amount: number }[]; note: string | null } | null;
    newPhone: { deviceId: string; label: string; price: number; suggested: boolean; why: string | null } | null;
    /** newPrice − wePay − bonus (premium.ts exchange; locked: payable). null without both phones priced, or when the new phone costs less than we pay + the bonus. */
    customerPays: number | null;
    /** customerPays − the refurb quote (+ = the swap costs more today). */
    vsRepair: number | null;
  };
  /** null = allowed; a string = why not. */
  actions: { repair: string | null; swap: string | null; walkAway: string | null };
  signals: { text: string; points: "repair" | "upgrade"; strength: "strong" | "soft" }[];
  /** A safety warning shown in the open under the headline, never behind "Why this answer" (a swollen battery). */
  safety: string | null;
  /** Every other caveat — behind "Why this answer" / "?". */
  caveats: string[];
  /** The answer in the lines every screen prints as sent (lib/domain/answer.ts). */
  answer: Answer;
};

/* ─────────────────────────── what toView hands in ─────────────────────────── */

/**
 * A what-if trade-in price for one storage size, kept on the case only while its storage is
 * unknown. `note`: the PriceIQ quote's age / unreachable note (PriceiqMeta.note), else absent.
 */
export type StorageQuote = { variant: string; amount: number | null; reason: string | null; note?: string | null };

/** The partner quote, as much of it as the answer reads (lib/server/buyback.ts PartnerQuote fits). */
export type OfferQuote = {
  status: "priced" | "unpriced" | "error";
  amount: number | null;
  source: { kind: PriceSourceKind };
  partnerRef: string | null;
  reason?: string;
  /** The trace — base, markdown, each deduction (ratecard.ts QuoteLine). Optional: an older quote may lack it. */
  lines?: QuoteLine[];
  /** source.kind "priceiq": what the one line says (lib/domain/priceiqTradeIn.ts). */
  priceiq?: PriceiqMeta;
  /** A rate-card quote where PriceIQ was asked first: why it had no price. */
  priceiqWhy?: string;
  /** A rate-card row with grade prices: the grade the price is for. */
  grade?: MarketGrade;
};

export type OfferInput = {
  status: string;
  /** The old phone. `variants` = the model's storage sizes. null = no model on the case. */
  device: { label: string; variant: string | null; variants: string[] } | null;
  variantSource: VariantSource | null;
  /**
   * The size the phone measured (its own disk reading, at Apply), whatever the model's list
   * says. null = it didn't measure (the browser build, a failed read, a desk-only case).
   * A reading that isn't on the list (a 1TB Ultra on file as 256/512GB) is the one case the
   * answer can't price at any chip: it says so instead. Default null.
   */
  measuredStorage?: string | null;
  storageQuotes: StorageQuote[] | null;
  faultCount: number;
  coverage: Coverage;
  repair: RepairEstimate | null;
  manualRepair: Pick<ManualQuote, "amount" | "reason"> | null;
  repairNotServiced: string | null;
  quote: OfferQuote | null;
  quoteExpired: boolean;
  /** The camera's identity check: why there is no trade-in price although the phone is described. */
  quoteBlocked: string | null;
  conditionProblems: string[];
  hasCondition: boolean;
  /** The chosen new phone (cases.ts UpgradeChoice fits). With `model` and `variant`, the answer names it without the brand. */
  upgrade: { deviceId: string; label: string; model?: string; variant?: string; price: number; suggested?: boolean; why?: string } | null;
  /** cases.ts BonusApplied fits; `clampedBy`/`basisAmount` say when the campaign's ₹ cap set the amount. */
  bonus: { amount: number; bp: number; override: { bp: number; amount: number } | null; clampedBy?: string | null; basisAmount?: number } | null;
  decision: Decision | null;
  /** The case's condition, for the answer's grade line. Default null (no grade line). */
  condition?: ConditionAnswers | null;
  /** A case past the counter: what was frozen at lock (trade_value, premium_value, premium_bp, bonus_value, payable). They win over the quote and bonus JSON. */
  locked?: { trade: number | null; premium: number | null; premiumBp: number | null; bonus: number | null; payable: number | null } | null;
  /** The programme is a test one (org.demo): every surface says "Test programme — no real money". */
  testProgramme?: boolean;
  /**
   * The asks' words must be true for THIS case, not only for a tested one.
   *   tested         a phone test was applied to the case (false = a desk-only case: no test to blame
   *                  for a missing model or storage, and no test that "found nothing wrong"). Default true.
   *   newPhoneMatch  with no new phone chosen: does the catalogue have one for this phone (the
   *                  suggestion rule)? true = staff cleared it or no suggestion ran, so "nothing
   *                  matches" would be untrue. Default false.
   */
  tested?: boolean;
  newPhoneMatch?: boolean;
};

/* ─────────────────────────── the words (spec §3.2, word for word) ─────────────────────────── */

const ASK_TITLE = {
  blocked: "Check this is the right phone",
  model: "Which phone is it?",
  storage: "Which storage is it?",
  no_price: "No market price yet",
  repair_quote: "The repair needs a quote",
  new_phone: "Choose the new phone",
} as const;
const MODEL_TEXT = "The test couldn't tell — choose it on the full case.";
// Not in the spec's table — the same asks on a case no test was applied to, or whose suggestion was cleared.
const MODEL_TEXT_UNTESTED = "Choose it on the full case.";
const STORAGE_TEXT = "The phone couldn't measure it — see Settings › About phone.";
// No test to blame (a desk-only case), or the phone measured a size on the list that was later
// cleared: "couldn't measure" would be untrue, so only what is true — there is no size yet.
const STORAGE_TEXT_UNTESTED = "See Settings › About phone › Storage.";
// The phone measured a size the model's list doesn't have. No chip can be right, so none is
// offered, and nothing prices that size: never a guessed one.
const measuredUnlisted = (size: string) => `Phone measures ${size}, not on file — no trade-in price for that size.`;
/** Owner, 2026-10-18: nothing priced the phone — never a made-up price. 2026-10-19: and never a typed one. */
export const NO_MARKET_PRICE = "No market price yet.";
/**
 * The line under "No market price yet" is WHY (the card doesn't list it, no card, PriceIQ's why) —
 * never those words again. A quote with no why of its own (none stored, or one from before 0.9.1,
 * whose stored words seed.ts cut to NO_MARKET_PRICE) has none: null, and the open case says
 * REQUOTE_FOR_WHY instead (a re-quote gives the price or the why).
 */
export const noPriceWhy = (reason: string | null | undefined): string | null => (reason?.trim() && reason !== NO_MARKET_PRICE ? reason : null);
const REQUOTE_FOR_WHY = "Re-quote to see why.";
/** The lock's refusal for an expired quote (cases.ts lockBlockers): every quote is the system's, so re-quoting renews it. */
export const EXPIRED_BLOCKER = "The trade-in price has expired — re-quote.";
const NEW_PHONE_TEXT = "No catalogue match — choose one to see the bonus.";
const NO_DECISION = "Not enough to compare yet";
const NOTHING_WRONG = "The test found nothing wrong.";
// A desk-only case: no test ran, so none "found nothing" — the case simply has no faults on it.
const NOTHING_RECORDED = "No faults on the case.";
// The server's own lock blocker, word for word (cases.ts lockBlockers): a swap needs a new phone.
const CHOOSE_NEW_PHONE = "Choose the new phone.";
const CUSTOMER_STORAGE_NOTE = "Customer typed this — check Settings › About phone.";
const NOTHING_TO_REPAIR = "Nothing to repair.";
const CHOOSE_PHONE = "Choose the phone first.";
const TAP_STORAGE = "Tap the storage to see the trade-in.";
const EXPIRED_NOTE = "Quote expired — re-quoting.";
const NO_NEW_PHONE = "Choose the new phone to see the bonus.";
const NO_CAMPAIGN = "No bonus campaign today.";
const CLOSED = "This case is closed.";
const NOT_PRICED = "Not priced yet.";
// Not in the spec's table — the last word when nothing above explains a missing number.
const NO_CONDITION = "Record the condition.";
const NO_TRADE_IN = "No trade-in price yet.";
const NO_REPAIR_PRICE = "No book price — enter the service centre's quote.";

/** "256GB" → 256, "1TB" → 1024, for putting the storage chips in order. Unreadable → after the rest. */
function sizeGb(variant: string): number {
  const m = /(\d+)\s*(GB|TB)\s*$/i.exec(variant);
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * (m[2].toUpperCase() === "TB" ? 1024 : 1);
}

/**
 * The new phone as the customer reads it: "Galaxy S26 Ultra 256GB". The catalogue is one
 * brand's at a service centre, so "Samsung" only lengthens a line that must fit half a
 * phone's width. The stored label (with the brand) stays as it is for the desk and the audit.
 */
function phoneLabel(up: NonNullable<OfferInput["upgrade"]>): string {
  return up.model && up.variant ? `${up.model} ${up.variant}` : up.label;
}

/**
 * How the trade-in was reached (Offer.swap.tradeInDetail). A PriceIQ quote's base is in its one line,
 * so the details start at the markdown: each number once. No partner's name: the lines are SwapUp's
 * words (ratecard.ts, priceiqTradeIn.ts), and a single-figure partner quote has no breakdown to show.
 */
function tradeInDetail(q: OfferQuote): NonNullable<Offer["swap"]["tradeInDetail"]> {
  const p = q.source.kind === "priceiq" ? (q.priceiq ?? null) : null;
  const all = q.lines ?? [];
  const steps = p ? all.slice(1) : all.length > 1 ? all : [];
  return {
    line: p ? tradeInLine(p) : null,
    lines: steps.map((l) => ({ label: l.label, pct: l.bp ? fmtBp(l.bp) : null, amount: l.amount })),
    note: q.priceiqWhy ?? null,
  };
}

/* ─────────────────────────── the answer ─────────────────────────── */

export function buildOffer(i: OfferInput): Offer {
  const open = i.status === "draft" || i.status === "quoted";
  const device = i.device;
  const variant = device?.variant ?? null;
  const nothingToRepair = i.faultCount === 0 && !i.manualRepair;
  const decision = i.decision;

  // ── The refurb quote ──
  const r = i.repair;
  const repairAmount = r?.status === "quoted" ? r.customerPays : null;
  const covered = r?.status === "quoted" && r.customerPays === 0 && r.coverage !== "none" && r.basis === "book";
  const repairNote = r?.notes[0] ?? i.repairNotServiced;
  let detail: string | null = null;
  if (r && repairAmount !== null) {
    if (covered) detail = r.coverage === "warranty" ? "Covered by warranty" : "Covered by Care+";
    else if (r.basis === "manual") detail = `Quote: ${(i.manualRepair?.reason ?? r.notes[0] ?? "").trim()}`;
    else {
      const parts = [
        ...r.lines.map((l) => l.label),
        ...(r.labour > 0 ? ["labour"] : []),
        ...(r.gst > 0 ? ["GST"] : []),
        ...(r.carePlusFee > 0 ? ["Care+ fee"] : []),
      ];
      detail = parts.length ? parts.join(" + ") : null;
    }
  }
  const repairWhy = repairAmount !== null ? null : nothingToRepair ? NOTHING_TO_REPAIR : !device ? CHOOSE_PHONE : (repairNote ?? NO_REPAIR_PRICE);

  // ── Trade-in + bonus ──
  const q = i.quote;
  const priced = !!device && !!variant && !i.quoteBlocked && q?.status === "priced" && q.amount !== null;
  const tradeIn = priced ? q!.amount : null;
  let tradeInNote: string | null = null;
  if (tradeIn !== null && q) {
    // A closed case is never re-quoted: its quote running out after the lock is no news.
    if (i.quoteExpired && open) tradeInNote = EXPIRED_NOTE;
    // Old market data (over 14 days) is shown with its age; a last good answer says PriceIQ didn't answer.
    else if (q.source.kind === "priceiq" && q.priceiq?.note) tradeInNote = q.priceiq.note;
  }
  // The phone measured a size that isn't on the model's list: say so, never a chip for another size.
  const measured = i.measuredStorage ?? null;
  const unlisted = device && !variant && measured && !device.variants.includes(measured) ? measuredUnlisted(measured) : null;
  const swapWhy =
    tradeIn !== null
      ? null
      : (i.quoteBlocked ??
        (!device
          ? CHOOSE_PHONE
          : !variant
            ? (unlisted ?? TAP_STORAGE)
            : q && q.status !== "priced"
              ? (noPriceWhy(q.reason) ?? (open ? REQUOTE_FOR_WHY : null))
              : (i.conditionProblems[0] ?? (!i.hasCondition ? NO_CONDITION : NO_TRADE_IN))));
  const up = i.upgrade;
  const b = up ? i.bonus : null;
  const bonus = b ? (b.override?.amount ?? b.amount) : null;
  const bonusBp = b ? (b.override?.bp ?? b.bp) : null;
  const bonusWhy = !up ? NO_NEW_PHONE : bonus === null ? NO_CAMPAIGN : null;
  // The campaign's ₹ cap set the amount (an override is capped the same way).
  const capped = !!b && (b.override ? b.basisAmount !== undefined && b.override.amount < Math.floor((b.basisAmount * b.override.bp) / 10_000) : b.clampedBy === "cap");

  // ── We pay: the market price + the SwapUp premium; once traded, the figures frozen at lock ──
  const frozen = i.locked && i.locked.trade !== null && TRADED_STATUSES.concat("cancelled").includes(i.status) ? i.locked : null;
  const market = frozen ? frozen.trade : tradeIn;
  const p = frozen ? (frozen.premium && frozen.premium > 0 ? { amount: frozen.premium, bp: frozen.premiumBp ?? 0 } : null) : premiumOn(market);
  const premium = market === null || !p ? null : { amount: p.amount, bp: p.bp };
  const wePay = market === null ? null : market + (premium?.amount ?? 0);
  const B = frozen ? (frozen.bonus ?? 0) : (bonus ?? 0);
  // What the customer pays for the new phone — the one formula the lock charges (premium.ts exchange).
  let customerPays: number | null = null;
  let tooCheap = false;
  if (frozen) customerPays = frozen.payable;
  else if (market !== null && up) {
    try {
      customerPays = exchange({ market, bonus: B, newPrice: up.price }).customerPays;
    } catch {
      tooCheap = true;
    }
  }

  // ── What is still missing — one thing each, in order ──
  const asks: OfferAsk[] = [];
  if (open) {
    if (i.quoteBlocked) asks.push({ kind: "blocked", title: ASK_TITLE.blocked, text: i.quoteBlocked });
    if (!device) asks.push({ kind: "model", title: ASK_TITLE.model, text: i.tested === false ? MODEL_TEXT_UNTESTED : MODEL_TEXT });
    if (device && !variant) {
      if (unlisted) asks.push({ kind: "storage", title: ASK_TITLE.storage, text: unlisted, options: [], note: null });
      else {
        const options: StorageOption[] = i.storageQuotes?.length
          ? i.storageQuotes.map((s) => ({ variant: s.variant, tradeIn: s.amount }))
          : device.variants.map((v) => ({ variant: v, tradeIn: null }));
        options.sort((a, z) => sizeGb(a.variant) - sizeGb(z.variant));
        // "Couldn't measure" only when a test ran and the phone really read nothing.
        const text = i.tested === false || measured ? STORAGE_TEXT_UNTESTED : STORAGE_TEXT;
        const note = i.storageQuotes?.find((s) => s.amount !== null && s.note)?.note ?? null;
        asks.push({ kind: "storage", title: ASK_TITLE.storage, text, options, note });
      }
    }
    // Nothing priced it: the reason, said once under the title — no form, no button.
    if (device && variant && !i.quoteBlocked && q && q.status !== "priced")
      asks.push({ kind: "no_price", title: ASK_TITLE.no_price, text: noPriceWhy(q.reason) ?? REQUOTE_FOR_WHY });
    if (device && !nothingToRepair && repairAmount === null && (r?.status === "needs_inspection" || r?.status === "unpriced" || (!r && i.repairNotServiced)))
      asks.push({ kind: "repair_quote", title: ASK_TITLE.repair_quote, text: repairNote ?? NO_REPAIR_PRICE });
    if (device && !up) asks.push({ kind: "new_phone", title: ASK_TITLE.new_phone, text: i.newPhoneMatch ? NO_NEW_PHONE : NEW_PHONE_TEXT });
  }

  // ── The verdict ──
  const first = asks.find((a) => a.kind !== "new_phone") ?? null;
  const recommendation = decision?.recommendation ?? null;
  const recommended = recommendation === "repair" ? "repair" : recommendation === "upgrade" || recommendation === "no_repair" ? "swap" : null;
  const signals = (decision?.signals ?? []).map((s) => ({ text: s.text, points: s.points, strength: s.strength }));
  const way = recommendation === "repair" || recommendation === "upgrade" ? recommendation : null;
  const reason =
    first?.text ??
    signals.find((s) => way && s.points === way && s.strength === "strong")?.text ??
    signals[0]?.text ??
    (recommendation === "no_repair" ? (i.tested === false ? NOTHING_RECORDED : NOTHING_WRONG) : null) ??
    // "Not enough to compare yet" says what is missing (e.g. no repaired value yet).
    (recommendation === "cannot_say" ? (decision?.missing[0] ?? null) : null);

  const status = i.status;
  return {
    open,
    headline: first?.title ?? decision?.headline ?? NO_DECISION,
    reason,
    recommendation,
    recommended,
    asks,
    storage: {
      variant,
      source: variant ? i.variantSource : null,
      note: variant && i.variantSource === "customer" ? CUSTOMER_STORAGE_NOTE : null,
    },
    repair: {
      amount: repairAmount,
      covered,
      basis: repairAmount !== null ? (r?.basis ?? null) : null,
      detail,
      why: repairWhy,
      nothingToRepair,
      coverage: i.coverage,
    },
    swap: {
      tradeIn: market,
      tradeInNote,
      premium,
      wePay,
      bonus: frozen ? (B > 0 ? B : null) : bonus,
      bonusBp,
      bonusWhy,
      total: wePay === null ? null : wePay + B,
      why: swapWhy,
      tradeInDetail: tradeIn !== null && q ? tradeInDetail(q) : null,
      newPhone: up ? { deviceId: up.deviceId, label: phoneLabel(up), price: up.price, suggested: up.suggested === true, why: up.why ?? null } : null,
      customerPays,
      vsRepair: customerPays !== null && repairAmount !== null ? customerPays - repairAmount : null,
    },
    actions: {
      repair: !open ? CLOSED : nothingToRepair ? NOTHING_TO_REPAIR : repairAmount === null ? repairWhy : status === "draft" ? NOT_PRICED : null,
      // A swap the Lock screen is certain to refuse for a reason it can't fix there is refused
      // here, with that reason: no new phone to swap up to.
      swap: !open
        ? CLOSED
        : tradeIn === null
          ? swapWhy
          : !up
            ? CHOOSE_NEW_PHONE
            : tooCheap
              ? NEW_PHONE_TOO_CHEAP
              : status !== "quoted"
                ? NOT_PRICED
                : null,
      walkAway: !open ? CLOSED : null,
    },
    signals,
    safety: decision?.caveats.includes(SWOLLEN_BATTERY_CAVEAT) ? SWOLLEN_BATTERY_CAVEAT : null,
    caveats: (decision?.caveats ?? []).filter((c) => c !== SWOLLEN_BATTERY_CAVEAT),
    answer: buildAnswer({
      status,
      condition: i.condition ?? null,
      market:
        market === null
          ? null
          : {
              amount: market,
              source: q?.source.kind ?? "none",
              priceGrade: q?.source.kind === "priceiq" ? (q.priceiq?.grade ?? null) : (q?.grade ?? null),
              // A rate card's grade column: the grade's own price before deductions — the trace's first
              // line is that base ("Market price grade A · <card>", ratecard.ts priceFromCard).
              gradePrice:
                q?.source.kind === "partner_ratecard" && q?.grade && typeof q?.lines?.[0]?.amount === "number" ? q.lines[0].amount : null,
            },
      quoteExpired: i.quoteExpired,
      quoteBlocked: !!i.quoteBlocked,
      repair: { amount: repairAmount, covered, coverage: i.coverage, nothingToRepair },
      newPhone: up ? { label: phoneLabel(up), price: up.price } : null,
      bonus: bonus !== null ? { amount: bonus, bp: bonusBp ?? 0, cap: capped ? bonus : null } : null,
      bonusWhy,
      recommendation,
      locked: frozen,
      testProgramme: i.testProgramme === true,
    }),
  };
}
