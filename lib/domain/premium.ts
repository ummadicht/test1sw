/**
 * THE SWAPUP PREMIUM — what SwapUp pays on top of the market price.
 *
 * Owner, 2026-10-18: "Market price for grade C is ₹25,000 … We pay you ₹26,000 + ₹6,199 bonus if
 * you exchange with a new device". The market price M is what the buyback partner pays for this
 * phone in this condition (the case's trade-in quote). SwapUp pays the customer M + P, where P is
 * a percentage of M in the sell markdown's own bands (marketSell.ts SELL_MARKDOWN — "same shape"):
 *
 *   market price      premium
 *   up to ₹15,000       5%
 *   up to ₹30,000       4%
 *   up to ₹50,000       3%
 *   above ₹50,000       2%
 *
 * floored to the rupee (money.ts: never a rupee the ledger cannot pay), and then never LESS than
 * the band edge below pays (owner, Q1 resolved): just above ₹15,000 the literal 4% would pay
 * ₹15,601 on ₹15,001 against ₹15,750 on ₹15,000, so the premium is lifted to what the edge pays.
 * "We pay you" never falls when the market price rises.
 *
 * Money (lib/server/cases.ts lockTradeIn): the credit line HOLDS the market price only — what the
 * partner pays back. The premium, like the bonus, is the programme's: a claim on /admin/claims,
 * never a hold and never a chargeback. `exchange` is the one formula reprice, the answer and the
 * lock all use. Pure — no database, no clock.
 */
import { markdownBp, SELL_MARKDOWN } from "./marketSell.ts";
import { pctOf, type BasisPoints, type Rupees } from "./money.ts";
import { RuleError } from "./errors.ts";

export const PREMIUM_RULE_VERSION = "2026-10-18.1";
/** Owner, 2026-10-18: the sell markdown's bands, on the market price. Upper edges inclusive. One table. */
export const PREMIUM_BANDS = SELL_MARKDOWN;

/** The lock's (and the swap's) refusal when the new phone costs less than we pay plus the bonus. */
export const NEW_PHONE_TOO_CHEAP = "The new phone costs less than we pay plus the bonus — choose another phone.";

/** 500 / 400 / 300 / 200 bp: the band's own percentage for a positive market price. */
export function premiumBp(market: Rupees): BasisPoints {
  return markdownBp(market);
}

const isPrice = (n: unknown): n is Rupees => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The highest band edge strictly below `market`, or null in the first band. */
function edgeBelow(market: Rupees): Rupees | null {
  let edge: Rupees | null = null;
  for (const b of PREMIUM_BANDS) if (b.upTo !== null && b.upTo < market) edge = b.upTo;
  return edge;
}

/**
 * The premium on a market price: the band's % floored to the rupee, lifted to what the edge below
 * pays when that is more (`edge` names that edge; null when the band's own % stands). `bp` is always
 * the band's. null when there is no market price (null, undefined, ≤ 0, not a whole rupee).
 */
export function premiumOn(market: Rupees | null | undefined): { amount: Rupees; bp: BasisPoints; rule: string; edge: Rupees | null } | null {
  if (!isPrice(market)) return null;
  const bp = premiumBp(market);
  const own = pctOf(market, bp);
  const e = edgeBelow(market);
  const atEdge = e === null ? null : e + premiumOn(e)!.amount;
  if (atEdge !== null && atEdge > market + own) return { amount: atEdge - market, bp, rule: PREMIUM_RULE_VERSION, edge: e };
  return { amount: own, bp, rule: PREMIUM_RULE_VERSION, edge: null };
}

/**
 * The money of one exchange. Throws RuleError without a market price (the lock never runs without
 * one) and when the new phone costs less than we pay + the bonus: the customer's share is never
 * floored at zero, so nothing promised goes unpaid.
 */
export function exchange(i: { market: Rupees; bonus: Rupees; newPrice: Rupees }): {
  premium: Rupees;
  premiumBp: BasisPoints;
  /** market + premium */
  wePay: Rupees;
  /** = market: what the store's credit line holds */
  hold: Rupees;
  /** premium + bonus: what the programme pays the store back */
  claim: Rupees;
  /** newPrice − wePay − bonus */
  customerPays: Rupees;
} {
  const p = premiumOn(i.market);
  if (!p) throw new RuleError("No market price yet.");
  const bonus = Math.max(0, Math.floor(i.bonus || 0));
  const wePay = i.market + p.amount;
  const customerPays = i.newPrice - wePay - bonus;
  if (!(customerPays >= 0)) throw new RuleError(NEW_PHONE_TOO_CHEAP);
  return { premium: p.amount, premiumBp: p.bp, wePay, hold: i.market, claim: p.amount + bonus, customerPays };
}
