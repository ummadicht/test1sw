/**
 * THE ANSWER — what the customer is shown after the test, on one screen:
 *
 *     Refurb quote          vs     Trade-in + bonus
 *     what fixing it costs         the partner's as-is price + the upgrade bonus
 *
 * "Why asking questions when we have all tested data … just refurb quote vs
 * bonus + trade in price." Everything here is already on the case: the test
 * filled the model, faults and condition, the price book priced the repair, the
 * partner priced the phone and SwapUp suggested the new one. This file only
 * arranges it and says, in the server's words, what is still missing and why.
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
 * Pure: no database, no clock. The app mirrors these types (src/store/offer.ts)
 * and shows these strings; it owns only the labels.
 */

import type { Decision, Recommendation } from "./decision.ts";
import type { Coverage, ManualQuote, RepairEstimate } from "./repair.ts";
import type { PriceSourceKind } from "./ratecard.ts";

/* ─────────────────────────── the contract (docs/MOBILE-API.md §3c) ─────────────────────────── */

/** Where the case's storage came from. measured = the phone's own disk reading; customer = a claim. */
export type VariantSource = "measured" | "catalogue" | "customer" | "advisor";

/**
 * One storage chip. `sample` = its price comes from the SAMPLE rate card (illustrative, not
 * the partner's): a sample figure is marked wherever it appears. A chip with no price is false.
 */
export type StorageOption = { variant: string; tradeIn: number | null; sample: boolean };

export type OfferAsk =
  | { kind: "blocked"; title: string; text: string }
  | { kind: "model"; title: string; text: string }
  /**
   * `note` — "Sample price — not a real quote." while any priced chip is a sample, else null.
   * `options` is empty when the phone measured a size the model's list doesn't have: no chip
   * may offer a size the phone has ruled out.
   */
  | { kind: "storage"; title: string; text: string; options: StorageOption[]; note: string | null }
  | { kind: "partner_quote"; title: string; text: string }
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
  /** Ordered: blocked, model, storage, partner_quote, repair_quote, new_phone. Empty once the case is closed. */
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
    tradeIn: number | null;
    tradeInNote: string | null;
    bonus: number | null;
    bonusBp: number | null;
    bonusWhy: string | null;
    /** tradeIn + (bonus ?? 0); null when tradeIn is null. */
    total: number | null;
    /** Why tradeIn is null. */
    why: string | null;
    newPhone: { deviceId: string; label: string; price: number; suggested: boolean; why: string | null } | null;
    /** decision.upgrade.pays */
    customerPays: number | null;
    /** decision.upgrade.extraVsRepair (+ = the swap costs more today). */
    vsRepair: number | null;
  };
  /** null = allowed; a string = why not. */
  actions: { repair: string | null; swap: string | null; walkAway: string | null };
  signals: { text: string; points: "repair" | "upgrade"; strength: "strong" | "soft" }[];
  caveats: string[];
};

/* ─────────────────────────── what toView hands in ─────────────────────────── */

/** A what-if trade-in price for one storage size, kept on the case only while its storage is unknown. */
export type StorageQuote = { variant: string; amount: number | null; reason: string | null; sample: boolean };

/** The partner quote, as much of it as the answer reads (lib/server/buyback.ts PartnerQuote fits). */
export type OfferQuote = {
  status: "priced" | "unpriced" | "error";
  amount: number | null;
  source: { kind: PriceSourceKind };
  partnerRef: string | null;
  reason?: string;
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
  bonus: { amount: number; bp: number; override: { bp: number; amount: number } | null } | null;
  decision: Decision | null;
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
  partner_quote: "Enter the Cashify quote",
  repair_quote: "The repair needs a quote",
  new_phone: "Choose the new phone",
} as const;
const MODEL_TEXT = "The test couldn't tell the model. Choose it on the full case.";
// Not in the spec's table — the same asks on a case no test was applied to, or whose suggestion was cleared.
const MODEL_TEXT_UNTESTED = "No model on the case yet. Choose it on the full case.";
const STORAGE_TEXT = "The phone couldn't measure its storage. Settings › About phone › Storage shows it.";
// No test to blame (a desk-only case), or the phone measured a size on the list that was later
// cleared: "couldn't measure" would be untrue, so only what is true — there is no size yet.
const STORAGE_TEXT_UNTESTED = "No storage on the case yet. Settings › About phone › Storage shows it.";
// The phone measured a size the model's list doesn't have. No chip can be right, so none is
// offered: the advisor checks Settings, and prices that size with the partner by hand.
const measuredUnlisted = (size: string) =>
  `The phone measures ${size}, which isn't a size on file. Check Settings › About phone, and enter the Cashify quote on the full case if it's really ${size}.`;
const NO_PARTNER_PRICE = "The partner has no price for this phone.";
// A quote read off the Cashify app is never re-quoted by SwapUp (reprice rebuilds it as entered),
// so once it lapses only a new one from the app can replace it — and the Lock screen refuses it.
const manualExpired = (ref: string) => `Cashify quote (ref ${ref}) expired — enter today's quote.`;
const EXPIRED_BLOCKER = "The partner's quote has expired — re-quote.";

/**
 * The lock's refusal for an expired quote (cases.ts lockBlockers). "Re-quote" is the fix for a
 * rate-card or live quote; a quote read off the Cashify app can't be re-quoted, so it gets the
 * answer's own sentence — the Lock screen and the answer never tell the advisor two things.
 */
export function expiredQuoteBlocker(q: Pick<OfferQuote, "source" | "partnerRef">): string {
  return q.source.kind === "partner_manual" ? manualExpired(q.partnerRef ?? "—") : EXPIRED_BLOCKER;
}
const NEW_PHONE_TEXT = "No new phone in the catalogue matches this one — choose it to see the bonus.";
const NO_DECISION = "Not enough to compare yet";
const NOTHING_WRONG = "The test found nothing wrong with the phone.";
// A desk-only case: no test ran, so none "found nothing" — the case simply has no faults on it.
const NOTHING_RECORDED = "No faults are recorded on the case.";
// The server's own lock blocker, word for word (cases.ts lockBlockers): a swap needs a new phone.
const CHOOSE_NEW_PHONE = "Choose the new phone.";
const CUSTOMER_STORAGE_NOTE = "The customer typed this — the phone couldn't measure it. Check Settings › About phone before the trade-in.";
const NOTHING_TO_REPAIR = "Nothing to repair.";
const CHOOSE_PHONE = "Choose the phone first.";
const TAP_STORAGE = "Tap the storage to see the trade-in.";
const SAMPLE_NOTE = "Sample price — not a real quote.";
const EXPIRED_NOTE = "Quote expired — re-quoting.";
const NO_NEW_PHONE = "Choose the new phone to see the bonus.";
const NO_CAMPAIGN = "No upgrade-bonus campaign applies to this phone today.";
const CLOSED = "This case is closed.";
const NOT_PRICED = "Not priced yet.";
// Not in the spec's table — the last word when nothing above explains a missing number.
const NO_CONDITION = "Answer the condition questions.";
const NO_TRADE_IN = "No trade-in price from the partner yet.";
const NO_REPAIR_PRICE = "The price book can't price this repair — enter the service centre's quote.";

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
  // A Cashify-app quote that has lapsed on an open case: the figure stays on screen for
  // reference, marked, and nothing can go ahead on it until today's quote is entered.
  const stale = open && tradeIn !== null && q?.source.kind === "partner_manual" && i.quoteExpired ? manualExpired(q.partnerRef ?? "—") : null;
  let tradeInNote: string | null = null;
  if (tradeIn !== null && q) {
    if (q.source.kind === "sample") tradeInNote = SAMPLE_NOTE;
    else if (stale) tradeInNote = stale;
    // A quote read off the partner's app is never re-quoted by SwapUp, so "re-quoting" would be untrue for it.
    else if (q.source.kind === "partner_manual") tradeInNote = `Cashify ref ${q.partnerRef ?? "—"}`;
    // A closed case is never re-quoted either: its quote running out after the lock is no news.
    else if (i.quoteExpired && open) tradeInNote = EXPIRED_NOTE;
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
              ? (q.reason ?? NO_PARTNER_PRICE)
              : (i.conditionProblems[0] ?? (!i.hasCondition ? NO_CONDITION : NO_TRADE_IN))));
  const up = i.upgrade;
  const b = up ? i.bonus : null;
  const bonus = b ? (b.override?.amount ?? b.amount) : null;
  const bonusBp = b ? (b.override?.bp ?? b.bp) : null;
  const bonusWhy = !up ? NO_NEW_PHONE : bonus === null ? NO_CAMPAIGN : null;

  // ── What is still missing — one thing each, in order ──
  const asks: OfferAsk[] = [];
  if (open) {
    if (i.quoteBlocked) asks.push({ kind: "blocked", title: ASK_TITLE.blocked, text: i.quoteBlocked });
    if (!device) asks.push({ kind: "model", title: ASK_TITLE.model, text: i.tested === false ? MODEL_TEXT_UNTESTED : MODEL_TEXT });
    if (device && !variant) {
      if (unlisted) asks.push({ kind: "storage", title: ASK_TITLE.storage, text: unlisted, options: [], note: null });
      else {
        const options: StorageOption[] = i.storageQuotes?.length
          ? i.storageQuotes.map((s) => ({ variant: s.variant, tradeIn: s.amount, sample: s.amount !== null && s.sample === true }))
          : device.variants.map((v) => ({ variant: v, tradeIn: null, sample: false }));
        options.sort((a, z) => sizeGb(a.variant) - sizeGb(z.variant));
        // "Couldn't measure" only when a test ran and the phone really read nothing.
        const text = i.tested === false || measured ? STORAGE_TEXT_UNTESTED : STORAGE_TEXT;
        asks.push({ kind: "storage", title: ASK_TITLE.storage, text, options, note: options.some((o) => o.sample) ? SAMPLE_NOTE : null });
      }
    }
    if (device && variant && !i.quoteBlocked && q && (q.status !== "priced" || stale))
      asks.push({ kind: "partner_quote", title: ASK_TITLE.partner_quote, text: stale ?? q.reason ?? NO_PARTNER_PRICE });
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
    // "Not enough to compare yet" says what is missing (e.g. a Cashify quote entered without its repaired value).
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
      tradeIn,
      tradeInNote,
      bonus,
      bonusBp,
      bonusWhy,
      total: tradeIn === null ? null : tradeIn + (bonus ?? 0),
      why: swapWhy,
      newPhone: up ? { deviceId: up.deviceId, label: phoneLabel(up), price: up.price, suggested: up.suggested === true, why: up.why ?? null } : null,
      customerPays: decision?.upgrade?.pays ?? null,
      vsRepair: decision?.upgrade?.extraVsRepair ?? null,
    },
    actions: {
      repair: !open ? CLOSED : nothingToRepair ? NOTHING_TO_REPAIR : repairAmount === null ? repairWhy : status === "draft" ? NOT_PRICED : null,
      // A swap the Lock screen is certain to refuse for a reason it can't fix there is refused
      // here, with that reason: a lapsed Cashify quote, or no new phone to swap up to.
      swap: !open ? CLOSED : tradeIn === null ? swapWhy : stale ? stale : !up ? CHOOSE_NEW_PHONE : status !== "quoted" ? NOT_PRICED : null,
      walkAway: !open ? CLOSED : null,
    },
    signals,
    caveats: [...(decision?.caveats ?? [])],
  };
}
