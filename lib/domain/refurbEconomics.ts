/**
 * REFURB DECISION — staff only (owner, 2026-10-22: "staff refurb decision", post-repair value from
 * the PRICE LIST's grade price). Five lines per trade-in, worked out once on the server
 * (lib/server/cases.ts toView) and printed as sent by the desk and the SwapUp Store app:
 *
 *   Pre-refurb value   M — the market price for the phone as it is: the case's trade-in quote, the
 *                      answer's own figure (Offer.swap.tradeIn; frozen at lock). Under it, the
 *                      answer's own words and where it came from: "Market price — priced at grade A
 *                      ₹34,960, less 15% back glass cracked" — the grade the answer shows (one grade:
 *                      marketSell.ts tradeInGrade).
 *   Repair cost        the store's own figure when staff entered one (the case's refurbCost), else
 *                      SwapUp's repair estimate for the recorded faults — parts + labour + GST, the
 *                      price-book estimate the customer's repair line is built from, at list price,
 *                      never the customer's covered price (a part with no book price: no figure) —
 *                      else "Nothing to repair" (₹0) when there is no fault.
 *   Post-repair value  the SAME rate card's price for the phone once its faults are repaired: the
 *                      case's condition healed (condition.ts healedCondition: a new back glass is the
 *                      look the grade already priced) and priced through the card (ratecard.ts
 *                      priceFromCard), so it reads the grade column the trade-in did, less only what
 *                      the repair leaves.
 *   Repair uplift      post-repair − pre-refurb − repair cost, said as the decision:
 *                      "Repair before pickup: +₹654" / "Send as-is — repairing costs ₹20,106 more than it adds".
 *   SwapUp offer       what we pay (M + the SwapUp premium) and "+ ₹B bonus with the <new phone>" —
 *                      the answer's own numbers (Offer.swap), never worked out again here; labelled
 *                      "SwapUp offer · we pay you", "As on the answer".
 *
 * It replaced "Store margin" (buy / refurb / sell / margin): the sell price was PriceIQ's, and the
 * owner chose the price list. A missing number stays missing (null) and says why — never a guess,
 * and no uplift until all three figures are known. Shown only while there is a priced trade-in to
 * decide on (refurbDecisionShown); nothing here reaches the customer or the partner (cases.ts
 * forViewer). Pure — no database, no clock.
 */
import { fmtBp, inr, type Rupees } from "./money.ts";
import { BODY_LABEL, BODY_ORDER, FAULT_BY_ID, HEALTHY, PART_LABEL, SCREEN_LABEL, SCREEN_ORDER, healedCondition, type ConditionAnswers, type FaultId } from "./condition.ts";
import { priceFromCard, type QuoteLine, type RateCard } from "./ratecard.ts";
import { MARKET_GRADE_LETTER, type MarketGrade, type MarketGradeLetter } from "./marketSell.ts";
import { defectNote } from "./answer.ts";
import type { RepairEstimate } from "./repair.ts";
import type { Offer, OfferQuote } from "./offer.ts";
import type { CaseStatus } from "./lifecycle.ts";

/* ─────────────────────────── the contract (docs/MOBILE-API.md §3b) ─────────────────────────── */

/** One figure, where it came from, or why there is none. `source` and `why` are never both set. */
export type RefurbLine = { amount: Rupees | null; source: string | null; why: string | null };

export type RefurbEconomics = {
  /** M, the market price for the phone as it is. `grade`: the card's grade column it was read off, when it has one. */
  preRefurb: RefurbLine & { grade: MarketGradeLetter | null };
  /** store = the store's own figure (refurbCost); estimate = SwapUp's repair estimate; none = nothing to repair (₹0). null = no figure. */
  repairCost: RefurbLine & { basis: "store" | "estimate" | "none" | null };
  /** The same card's price for the phone repaired. `grade`: the card's grade column, when it has one. */
  postRepair: RefurbLine & { grade: MarketGradeLetter | null };
  /**
   * post-repair − pre-refurb − repair cost. `verdict`: repair = repairing adds money; as_is = it doesn't;
   * nothing_to_repair = no fault and no store figure (no amount). `text` is the decision, word for word.
   */
  uplift: { amount: Rupees | null; verdict: "repair" | "as_is" | "nothing_to_repair" | null; text: string | null; why: string | null };
  /** What we pay (M + premium). `source`: "As on the answer", then " · + ₹4,649 bonus with the Galaxy S26 Ultra 256GB" with a new phone and a bonus. */
  offer: RefurbLine & { bonus: Rupees | null; newPhone: string | null };
};

export type RefurbInput = {
  /** The answer's money (offer.ts buildOffer): M, what we pay, the bonus and the new phone — each number once. */
  swap: Pick<Offer["swap"], "tradeIn" | "wePay" | "bonus" | "newPhone" | "why" | "tradeInDetail">;
  /** The case's trade-in quote: its trace says where M came from, its source which card priced it. */
  quote: Pick<OfferQuote, "status" | "amount" | "source" | "lines" | "grade"> | null;
  /** The rate card the quote was read off (the server loads it by the quote's rateCardId); null otherwise. */
  card: RateCard | null;
  device: { modelId: string; variant: string | null } | null;
  condition: ConditionAnswers | null;
  faults: FaultId[];
  repair: Pick<RepairEstimate, "status" | "basis" | "customerPays" | "listTotal" | "lines" | "labour" | "gst" | "carePlusFee" | "inspectionFaults" | "missingParts" | "notes"> | null;
  refurbCost: { amount: Rupees; by: string } | null;
};

/* ─────────────────────────── when there is a decision ─────────────────────────── */

/**
 * The statuses with a trade-in still to decide on: at the counter, and traded in until the partner
 * picks it up — "Repair before pickup" is acted on between the lock and the pickup, and M is frozen
 * at lock, so the lines stay true (read-only past the counter). Not once the customer chose the
 * repair, walked away or cancelled (no trade-in), nor once the phone is collected.
 */
export const REFURB_DECISION_STATUSES: readonly CaseStatus[] = ["draft", "quoted", "locked", "in_pickup"];

/**
 * Whether the staff case carries the refurb decision at all: a status with a trade-in to decide on
 * and a priced trade-in. With no trade-in price nothing on the panel can be acted on, and the
 * answer's Swap up side already says why — so no panel, not the same reason under every line.
 */
export function refurbDecisionShown(status: CaseStatus, swap: Pick<Offer["swap"], "tradeIn">): boolean {
  return REFURB_DECISION_STATUSES.includes(status) && swap.tradeIn !== null;
}

/* ─────────────────────────── the words ─────────────────────────── */

export const NOTHING_TO_REPAIR = "Nothing to repair";
/** The answer's own words for M, so the pre-refurb value reads as the same number as the answer's market line. */
export const MARKET_PRICE = "Market price";
/** Under the SwapUp offer: it is the answer's "We pay you", not a third price. */
export const AS_ON_THE_ANSWER = "As on the answer";
const NO_TRADE_IN = "No trade-in price yet.";
/** The trade-in is PriceIQ's, so there is no price-list price to set beside it. */
export const NOT_FROM_PRICE_LIST = "The trade-in isn't from the price list — no post-repair price to compare.";
/** The quote names a rate card the server no longer has. */
export const PRICE_LIST_GONE = "The price list this trade-in came from isn't on file.";
const NO_CONDITION = "Record the condition.";
const NO_ESTIMATE = "No repair estimate — enter the store's repair cost.";

/** "Back glass" → "back glass"; a first word with more capitals ("Wi-Fi") is a name and stays. */
const lowerFirst = (s: string) => (s && !/[A-Z]/.test(s.split(" ")[0].slice(1)) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * A deduction line in the answer's words: "Body: Back glass cracked" → "back glass cracked",
 * "Screen: Cracked glass" → "screen cracked" (answer.ts defectNote), "No original box" → "no original box".
 */
function deductionWords(label: string): string {
  const m = /^(Screen|Body): (.+)$/.exec(label);
  if (!m) return lowerFirst(label);
  const screen = m[1] === "Screen" ? SCREEN_ORDER.find((s) => SCREEN_LABEL[s] === m[2]) : undefined;
  const body = m[1] === "Body" ? BODY_ORDER.find((b) => BODY_LABEL[b] === m[2]) : undefined;
  const said = screen || body ? defectNote({ ...HEALTHY, screen: screen ?? "flawless", body: body ?? "flawless" }) : null;
  return said ?? (m[1] === "Screen" ? `screen ${lowerFirst(m[2])}` : lowerFirst(m[2]));
}

/**
 * A rate card's trace in one line, naming the grade it was priced at — the phone's grade, as the
 * answer shows it: "priced at grade A ₹34,960, less 15% back glass cracked" (a row with grade columns), "priced at the best-condition price ₹24,000, less 12% back glass cracked" (one
 * without). Only the percentages are named; the cash step, a cap or the card's minimum are in the
 * trade-in's details. Nothing taken off: "grade B price" — the figure beside it IS that price, so it
 * isn't said twice.
 */
export function cardTraceLine(lines: QuoteLine[], grade: MarketGrade | null | undefined): string | null {
  const base = lines[0];
  if (!base) return null;
  const off = lines.slice(1).filter((l) => l.bp);
  if (!off.length) return grade ? `grade ${MARKET_GRADE_LETTER[grade]} price` : "best-condition price";
  const at = grade ? `grade ${MARKET_GRADE_LETTER[grade]}` : "the best-condition price";
  return `priced at ${at} ${inr(base.amount)}, less ${joinAnd(off.map((l) => `${fmtBp(l.bp!)} ${deductionWords(l.label)}`))}`;
}

const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "back glass / cover ₹3,470 + labour ₹425 + GST ₹701" — the estimate at list price, as staff read it. */
function estimateLine(r: NonNullable<RefurbInput["repair"]>): string {
  if (r.basis === "manual") return r.notes[0] ?? "Service centre quote";
  const parts = r.lines.map((l) => `${lowerFirst(l.label)}${l.listPrice !== null ? ` ${inr(l.listPrice)}` : ""}`);
  // Nothing covered: the stored labour and GST are the list ones, so each is named with its figure.
  const atList = r.listTotal === r.customerPays;
  const extras = atList ? [r.labour > 0 ? `labour ${inr(r.labour)}` : null, r.gst > 0 ? `GST ${inr(r.gst)}` : null] : ["labour", "GST"];
  return `SwapUp's repair estimate: ${[...parts, ...extras].filter((x): x is string => !!x).join(" + ")}`;
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/* ─────────────────────────── the decision ─────────────────────────── */

export function refurbEconomics(i: RefurbInput): RefurbEconomics {
  const { swap, quote, card, device, condition, faults, repair, refurbCost } = i;
  const M = swap.tradeIn;
  const fromCard = quote?.source.kind === "partner_ratecard";

  // ── Pre-refurb value: the answer's M ──
  const preRefurb: RefurbEconomics["preRefurb"] =
    M === null
      ? { amount: null, grade: null, source: null, why: swap.why ?? NO_TRADE_IN }
      : {
          amount: M,
          grade: fromCard && quote?.grade ? MARKET_GRADE_LETTER[quote.grade] : null,
          source: [MARKET_PRICE, fromCard ? cardTraceLine(quote?.lines ?? [], quote?.grade) : quote?.source.kind === "priceiq" ? (swap.tradeInDetail?.line ?? null) : null]
            .filter((x): x is string => !!x)
            .join(" — "),
          why: null,
        };

  // ── Repair cost: the store's own figure, else SwapUp's estimate at list price, else nothing to repair ──
  let repairCost: RefurbEconomics["repairCost"];
  // The book's estimate counts at list price only — what the parts cost the store, whatever the
  // customer's cover makes them pay. A covered part the book has no price for leaves the list total
  // unknown (null), and the customer's covered price would leave that part out, so there is no
  // figure. The outside quote (manual) has no list total; its figure is the centre's own.
  const estimate = repair?.status !== "quoted" ? null : repair.basis === "manual" ? repair.customerPays : repair.listTotal;
  // A defect in the condition with no fault recorded for it (a dead display, no power, liquid…): there
  // is something to repair, but nothing says what — never "Nothing to repair", and no repaired price.
  const unrecorded = faults.length === 0 && condition ? defectNote(condition) : null;
  if (refurbCost) repairCost = { amount: refurbCost.amount, basis: "store", source: `The store's own figure, entered by ${refurbCost.by}`, why: null };
  else if (repair && estimate !== null) repairCost = { amount: estimate, basis: "estimate", source: estimateLine(repair), why: null };
  else if (unrecorded) repairCost = { amount: null, basis: null, source: null, why: `No fault recorded (${unrecorded}) — record it to price the repair.` };
  else if (faults.length === 0 || repair?.status === "nothing_to_repair") repairCost = { amount: 0, basis: "none", source: NOTHING_TO_REPAIR, why: null };
  else if (repair?.status === "needs_inspection")
    repairCost = {
      amount: null,
      basis: null,
      source: null,
      why: `Bench check needed (${repair.inspectionFaults.map((f) => FAULT_BY_ID[f].label).join(", ")}) — enter the store's repair cost.`,
    };
  // Unpriced: a charged part has no price. Quoted with no list total: a covered one has none.
  else if ((repair?.status === "unpriced" || repair?.status === "quoted") && repair.missingParts.length)
    repairCost = { amount: null, basis: null, source: null, why: `No book price for ${repair.missingParts.map((p) => PART_LABEL[p]).join(", ")} — enter the store's repair cost.` };
  else repairCost = { amount: null, basis: null, source: null, why: NO_ESTIMATE };

  // ── Post-repair value: the same card, the phone repaired the card's way ──
  let postRepair: RefurbEconomics["postRepair"];
  const missingPost = (why: string): RefurbEconomics["postRepair"] => ({ amount: null, grade: null, source: null, why });
  if (M === null) postRepair = missingPost(preRefurb.why ?? NO_TRADE_IN);
  else if (!fromCard) postRepair = missingPost(NOT_FROM_PRICE_LIST);
  else if (!card) postRepair = missingPost(PRICE_LIST_GONE);
  else if (!condition) postRepair = missingPost(NO_CONDITION);
  else if (!device?.variant) postRepair = missingPost(swap.why ?? NO_TRADE_IN);
  else if (unrecorded) postRepair = missingPost(`No fault recorded (${unrecorded}) — record it to work out the repaired price.`);
  else {
    const r = priceFromCard(card, device.modelId, device.variant, healedCondition(condition, faults));
    postRepair =
      r.status === "priced"
        ? { amount: r.amount, grade: r.grade ? MARKET_GRADE_LETTER[r.grade] : null, source: upperFirst(cardTraceLine(r.lines, r.grade) ?? ""), why: null }
        : missingPost(r.reason);
  }

  // ── Repair uplift: the decision ──
  let uplift: RefurbEconomics["uplift"];
  if (repairCost.basis === "none") uplift = { amount: null, verdict: "nothing_to_repair", text: NOTHING_TO_REPAIR, why: null };
  else if (preRefurb.amount !== null && repairCost.amount !== null && postRepair.amount !== null) {
    const u = postRepair.amount - preRefurb.amount - repairCost.amount;
    uplift = {
      amount: u,
      verdict: u > 0 ? "repair" : "as_is",
      text:
        u > 0
          ? `Repair before pickup: +${inr(u)}`
          : u === 0
            ? "Send as-is — repairing only breaks even"
            : `Send as-is — repairing costs ${inr(-u)} more than it adds`,
      why: null,
    };
  } else {
    const missing = [
      preRefurb.amount === null ? "the pre-refurb value" : null,
      repairCost.amount === null ? "the repair cost" : null,
      postRepair.amount === null ? "the post-repair value" : null,
    ].filter((m): m is string => m !== null);
    uplift = { amount: null, verdict: null, text: null, why: `Needs ${joinAnd(missing)}.` };
  }

  // ── SwapUp offer: the answer's we pay and bonus (as the answer, no bonus without a price) ──
  const bonus = swap.wePay !== null && swap.newPhone && swap.bonus !== null && swap.bonus > 0 ? swap.bonus : null;
  const offer: RefurbEconomics["offer"] = {
    amount: swap.wePay,
    bonus,
    newPhone: swap.newPhone?.label ?? null,
    source: swap.wePay === null ? null : bonus !== null && swap.newPhone ? `${AS_ON_THE_ANSWER} · + ${inr(bonus)} bonus with the ${swap.newPhone.label}` : AS_ON_THE_ANSWER,
    why: swap.wePay === null ? (preRefurb.why ?? NO_TRADE_IN) : null,
  };

  return { preRefurb, repairCost, postRepair, uplift, offer };
}
