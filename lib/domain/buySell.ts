/**
 * BUY vs SELL — the store's side of a trade-in, in four lines:
 *
 *   Buy          what the store pays the customer: the partner's as-is quote
 *   Refurb cost  what putting it right costs the store: the advisor's own figure
 *                (the case's refurbCost — NOT manualRepair, which is the
 *                customer's repair price and drives the advice), else SwapUp's
 *                repair estimate at list price; ₹0 when there is nothing to repair
 *   Sell         what it sells for refurbished: PriceIQ's refurbished market
 *                price at the grade after refurb less 2–5% (marketSell.ts); when
 *                PriceIQ has none, the partner's price for the phone repaired
 *   Margin       Sell − Buy − Refurb (negative = the store loses money)
 *
 * A missing number stays missing (null) and says why; nothing is guessed, and
 * there is no margin until all three numbers are known. The desk and the
 * SwapUp Store app (src/store/buySell.ts) read the same case fields the same way,
 * in the same words — `sellSource` is the one line under the sell price.
 *
 * Pure — no database, no clock.
 */
import type { Rupees } from "./money.ts";

type QuoteLike = { status: "priced" | "unpriced" | "error"; amount: Rupees | null; reason?: string } | null | undefined;
type RepairLike =
  | { status: "quoted" | "needs_inspection" | "unpriced" | "nothing_to_repair"; customerPays: Rupees | null; listTotal?: Rupees | null }
  | null
  | undefined;
type MarketLike =
  | { amount: Rupees | null; why: string | null; grade?: string; gradeWanted?: string; listing?: Rupees; markdownBp?: number; week?: string; ageDays?: number; stale?: boolean }
  | null
  | undefined;

export type BuySell = {
  buy: Rupees | null;
  buyWhy: string | null;
  refurb: Rupees | null;
  /** quote = entered by staff; estimate = SwapUp's price-book estimate; none = nothing to repair. null = no figure. */
  refurbBasis: "quote" | "estimate" | "none" | null;
  refurbWhy: string | null;
  sell: Rupees | null;
  /** market = PriceIQ's refurbished-market listing less the markdown; partner = the partner's repaired price. */
  sellBasis: "market" | "partner" | null;
  /** Where the sell price comes from, in one line: "Refurbished market price ₹21,999 (Good) − 4% · PriceIQ". null with no sell price. */
  sellSource: string | null;
  sellWhy: string | null;
  margin: Rupees | null;
  marginWhy: string | null;
};

export function buySell(input: {
  quote: QuoteLike;
  repairedQuote: QuoteLike;
  refurbCost: { amount: Rupees } | null | undefined;
  repair: RepairLike;
  faultCount: number;
  market: MarketLike;
  partner?: string;
}): BuySell {
  const partner = input.partner || "the partner";
  const { quote, repairedQuote: rq, refurbCost, repair, market } = input;

  // Buy — the partner's price for the phone as it is.
  let buy: Rupees | null = null;
  let buyWhy: string | null = null;
  if (quote?.status === "priced" && quote.amount !== null) buy = quote.amount;
  else if (!quote) buyWhy = "No quote yet.";
  else if (quote.status === "error") buyWhy = `No answer from ${partner}.`;
  else buyWhy = `No price from ${partner} for this phone.`;

  // Refurb cost — staff's figure wins; else the estimate at list price; else nothing to repair.
  let refurb: Rupees | null = null;
  let refurbBasis: BuySell["refurbBasis"] = null;
  let refurbWhy: string | null = null;
  const estimate = repair?.status === "quoted" ? (repair.listTotal ?? repair.customerPays) : null;
  if (refurbCost) {
    refurb = refurbCost.amount;
    refurbBasis = "quote";
  } else if (estimate !== null && estimate !== undefined) {
    refurb = estimate;
    refurbBasis = "estimate";
  } else if (input.faultCount === 0 || repair?.status === "nothing_to_repair") {
    refurb = 0;
    refurbBasis = "none";
  } else if (repair?.status === "needs_inspection") refurbWhy = "Needs a bench diagnosis — enter the refurb cost.";
  else if (repair?.status === "unpriced") refurbWhy = "A part has no price — enter the refurb cost.";
  else refurbWhy = "No repair estimate — enter the refurb cost.";

  // Sell — PriceIQ's refurbished-market listing less the markdown; else the partner's repaired price.
  let sell: Rupees | null = null;
  let sellBasis: BuySell["sellBasis"] = null;
  let sellSource: string | null = null;
  let sellWhy: string | null = null;
  if (market && market.amount !== null) {
    sell = market.amount;
    sellBasis = "market";
    sellSource = marketSource(market);
  } else if (rq?.status === "priced" && rq.amount !== null) {
    sell = rq.amount;
    sellBasis = "partner";
    sellSource = SELL_FROM_PARTNER;
  } else sellWhy = market?.why ?? (quote ? `No repaired price from ${partner}.` : "No quote yet.");

  const missing = [buy === null ? "the buy price" : null, refurb === null ? "the refurb cost" : null, sell === null ? "the sell price" : null].filter(
    (m): m is string => m !== null
  );
  const margin = buy !== null && refurb !== null && sell !== null ? sell - buy - refurb : null;
  const marginWhy = missing.length ? `Needs ${joinAnd(missing)}.` : null;

  return { buy, buyWhy, refurb, refurbBasis, refurbWhy, sell, sellBasis, sellSource, sellWhy, margin, marginWhy };
}

export const SELL_FROM_PARTNER = "Partner's repaired price";

const rupees = (n: Rupees) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * "Refurbished market price ₹21,999 (Good) − 4% · PriceIQ", plus " · week 2026-W35, 52 days old"
 * when the market data is over 14 days old, and " · none at Superb" when the market listed none at
 * the grade the phone should get and a lower one was used.
 */
export function marketSource(m: { grade?: string; gradeWanted?: string; listing?: Rupees; markdownBp?: number; week?: string; ageDays?: number; stale?: boolean }): string {
  const price = typeof m.listing === "number" ? ` ${rupees(m.listing)}` : "";
  const grade = m.grade ? ` (${m.grade})` : "";
  const off = typeof m.markdownBp === "number" ? ` − ${m.markdownBp / 100}%` : "";
  const age = m.stale && typeof m.ageDays === "number" ? ` · week ${m.week ?? "?"}, ${m.ageDays} days old` : "";
  const lower = m.gradeWanted && m.grade && m.gradeWanted !== m.grade ? ` · none at ${m.gradeWanted}` : "";
  return `Refurbished market price${price}${grade}${off} · PriceIQ${age}${lower}`;
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
