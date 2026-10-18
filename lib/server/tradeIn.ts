/**
 * THE CASE'S TRADE-IN PRICE — one place decides where it comes from. Owner, 2026-10-18: "prices
 * come from PriceIQ, an uploaded partner rate card, or a quote staff type in; none → No market
 * price yet — enter a quote. Never a made-up price." Best first:
 *
 *   1. partner_manual    a quote staff typed in from the partner's own app — binding as entered,
 *                        never re-asked (cases.ts reprice keeps it; this file is not consulted)
 *   2. priceiq           PriceIQ's lowest refurbished-market listing at the phone's grade, less the
 *                        5%→2% markdown, less SwapUp's % for each defect
 *                        (lib/domain/priceiqTradeIn.ts), asked live (lib/server/priceiq.ts): an
 *                        answer over an hour old is refreshed first, waiting 6 s at most; PriceIQ
 *                        unreachable → its last good answer, labelled; over 90 days old → none
 *   3. partner_ratecard  the partner's uploaded rate card (buyback.ts)
 *   4. none              "No market price yet — enter a quote."
 *
 * When PriceIQ can't price the phone the quote carries `priceiqWhy` — the trace says why, it is
 * never silent. Whatever this returns is the case quote: the lock holds THAT value on the store's
 * credit line.
 */
import { nowIso } from "./db";
import { partnerMode, partnerQuote, type PartnerQuote } from "./buyback";
import { cachedMarket, freshMarket, type MarketAsk } from "./priceiq";
import { priceiqLabel, priceiqTradeIn, SWAPUP_DEDUCTIONS_LABEL, type PriceiqMeta, type PriceiqTradeIn } from "../domain/priceiqTradeIn";
import { gradeAfterRefurb } from "../domain/marketSell";
import { NO_MARKET_PRICE } from "../domain/offer";
import { healedCondition, type ConditionAnswers, type FaultId } from "../domain/condition";

/** How long a PriceIQ trade-in quote binds when the programme sets no quote validity of its own. */
export const PRICEIQ_QUOTE_VALIDITY_DAYS = 3;

type Ask = {
  partnerId: string;
  modelId: string;
  variant: string;
  /** "Samsung" — PriceIQ is asked by brand + model + storage. */
  brand: string;
  /** "Galaxy S23 Ultra" — for the words when PriceIQ has no price. */
  model: string;
  answers: ConditionAnswers;
  imei?: string | null;
  validityDaysOverride?: number | null;
  /** A what-if (a storage chip) — never binding. */
  whatIf?: boolean;
};

const askOf = (input: Pick<Ask, "modelId" | "variant" | "brand" | "model">): MarketAsk => ({ modelId: input.modelId, variant: input.variant, brand: input.brand, model: input.model });

function metaOf(p: Extract<PriceiqTradeIn, { status: "priced" }>, deductions: string | null): PriceiqMeta {
  return {
    grade: p.grade,
    gradeWanted: p.gradeWanted,
    listing: p.listing,
    markdownBp: p.markdownBp,
    defects: p.defects,
    deductions,
    week: p.week,
    listings: p.listings,
    ageDays: p.ageDays,
    stale: p.stale,
    note: p.note,
  };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** PriceIQ's answer for this phone (refreshed when over an hour old), or why it has none. */
export async function priceiqQuote(input: Ask, partnerName: string): Promise<{ quote: PartnerQuote; reason: null } | { quote: null; reason: string }> {
  const read = await freshMarket(askOf(input));
  const p = priceiqTradeIn({ answer: read.answer, noAnswerWhy: read.why, condition: input.answers, label: `${input.model} ${input.variant}`, asOf: nowIso() });
  if (p.status !== "priced") return { quote: null, reason: p.reason };
  const quotedAt = nowIso();
  return {
    reason: null,
    quote: {
      status: "priced",
      amount: p.amount,
      lines: p.lines,
      source: { kind: "priceiq", label: priceiqLabel(p) },
      partner: partnerName,
      partnerRef: null,
      quotedAt,
      validUntil: input.whatIf ? null : addDays(quotedAt, input.validityDaysOverride ?? PRICEIQ_QUOTE_VALIDITY_DAYS),
      priceiq: metaOf(p, SWAPUP_DEDUCTIONS_LABEL),
    },
  };
}

/** The case's trade-in quote, in the order above (a quote typed from the partner's app is handled by the caller). */
export async function tradeInQuote(input: Ask): Promise<PartnerQuote> {
  const mode = partnerMode(input.partnerId);
  const p = await priceiqQuote(input, mode.partnerName);
  if (p.quote) return p.quote;
  const q = await partnerQuote(input);
  if (q.status === "priced") return { ...q, priceiqWhy: p.reason };
  // Nothing priced it — no price at all, never a made-up one: staff enter a quote.
  return {
    status: "unpriced",
    amount: null,
    lines: [],
    source: { kind: "none", label: "No market price" },
    partner: mode.partnerName,
    partnerRef: null,
    quotedAt: q.quotedAt,
    validUntil: null,
    reason: NO_MARKET_PRICE,
    priceiqWhy: p.reason,
  };
}

/**
 * The phone's value REPAIRED, beside a PriceIQ trade-in (the repair-vs-swap comparison), priced
 * the way the trade-in is so the two compare like with like: PriceIQ at the grade it comes out at
 * after refurb (marketSell.ts gradeAfterRefurb), less the same markdown, less a % for every
 * defect the repaired faults DON'T explain (healedCondition — a ticked Wi-Fi issue nobody quotes
 * a repair for stays deducted). Reads the answer the trade-in just refreshed — never asks again.
 * null = PriceIQ has none at that grade or below.
 */
export function priceiqRepaired(input: Pick<Ask, "partnerId" | "modelId" | "variant" | "brand" | "model" | "answers"> & { faults: FaultId[] }, asIs: PartnerQuote): PartnerQuote | null {
  const read = cachedMarket(askOf(input));
  const p = priceiqTradeIn({
    answer: read.answer,
    noAnswerWhy: read.why,
    condition: healedCondition(input.answers, input.faults),
    grade: gradeAfterRefurb(input.answers),
    label: `${input.model} ${input.variant}`,
    asOf: nowIso(),
  });
  if (p.status !== "priced") return null;
  return {
    status: "priced",
    amount: p.amount,
    lines: p.lines,
    source: { kind: "priceiq", label: `PriceIQ · ${p.grade} after refurb${p.defects ? " − defects" : ""}` },
    partner: asIs.partner,
    partnerRef: null,
    quotedAt: asIs.quotedAt,
    validUntil: null,
    priceiq: metaOf(p, p.defects ? SWAPUP_DEDUCTIONS_LABEL : null),
  };
}
