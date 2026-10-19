/**
 * THE BUYBACK PARTNER SEAM — the programme's buyback partner (its org row).
 *
 * The partner collects and pays for the phones. Where the trade-in PRICE comes from is
 * lib/server/tradeIn.ts, best first: PriceIQ's refurbished market price at the phone's grade,
 * then — this file — the partner's RATE CARD: the price sheet its operations team uploads on
 * /partner/rate-cards. SwapUp has no partner quote API (none exists to call), keeps no built-in
 * prices of its own and takes no typed ones: with no card, the partner simply has no price.
 *
 * Every answer records where it came from, so the UI never has to guess whether a number is real.
 */

import { db, parseJson, nowIso } from "./db";
import { priceFromCard, type RateCard, type QuoteLine, type PriceSourceKind } from "../domain/ratecard";
import type { ConditionAnswers } from "../domain/condition";
import type { Rupees } from "../domain/money";
import type { PriceiqMeta } from "../domain/priceiqTradeIn";
import type { MarketGrade } from "../domain/marketSell";

export type PartnerQuote = {
  status: "priced" | "unpriced" | "error";
  amount: Rupees | null;
  lines: QuoteLine[];
  source: { kind: PriceSourceKind; label: string; rateCardId?: string; effectiveFrom?: string };
  partner: string;
  partnerRef: string | null;
  quotedAt: string;
  validUntil: string | null;
  reason?: string;
  /** source.kind "priceiq": the grade, base, markdown and market age the lines start from (lib/server/tradeIn.ts). */
  priceiq?: PriceiqMeta;
  /** PriceIQ was asked first and had no price: why (a rate-card quote, or no price at all). */
  priceiqWhy?: string;
  /** A rate-card row with grade prices: the grade the price is FOR (ratecard.ts priceFromCard). */
  grade?: MarketGrade;
};

export type PartnerMode = {
  partnerId: string;
  partnerName: string;
  /** partner_ratecard = the partner's uploaded card prices what PriceIQ can't; none = no card loaded. */
  kind: "partner_ratecard" | "none";
  label: string;
  why: string;
  rateCardId: string | null;
};

type CardRow = { id: string; data: string; created_at: string };

/** The partner's active uploaded rate card, or null. */
export function activeRateCard(partnerId: string): RateCard | null {
  const row = db()
    .prepare(`SELECT id, data, created_at FROM rate_cards WHERE partner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`)
    .get(partnerId) as CardRow | undefined;
  if (!row) return null;
  const card = parseJson<RateCard | null>(row.data, null);
  return card && card.source?.kind === "partner_ratecard" ? { ...card, id: row.id } : null;
}

export function partnerMode(partnerId: string): PartnerMode {
  const p = db().prepare(`SELECT name FROM orgs WHERE id = ? AND kind = 'partner'`).get(partnerId) as { name: string } | undefined;
  const partnerName = p?.name ?? "Buyback partner";
  const card = activeRateCard(partnerId);
  if (!card) return { partnerId, partnerName, kind: "none", label: "No rate card", why: "No rate card loaded — a phone PriceIQ can't price gets no trade-in price.", rateCardId: null };
  return { partnerId, partnerName, kind: "partner_ratecard", label: card.source.label, why: `${partnerName}'s rate card from ${card.source.effectiveFrom}.`, rateCardId: card.id };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * The partner's rate-card price for a phone. Never throws for a pricing miss — an unpriced
 * quote is an answer the UI shows, not an exception.
 */
export async function partnerQuote(input: {
  partnerId: string;
  modelId: string;
  variant: string;
  answers: ConditionAnswers;
  imei?: string | null;
  validityDaysOverride?: number | null;
  /** A what-if (repaired value, a storage chip) — never binding. */
  whatIf?: boolean;
}): Promise<PartnerQuote> {
  const mode = partnerMode(input.partnerId);
  const quotedAt = nowIso();
  const card = mode.rateCardId ? activeRateCard(input.partnerId) : null;
  if (!card) {
    return {
      status: "unpriced",
      amount: null,
      lines: [],
      source: { kind: "none", label: "No rate card" },
      partner: mode.partnerName,
      partnerRef: null,
      quotedAt,
      validUntil: null,
      reason: "No partner rate card loaded.",
    };
  }
  const q = priceFromCard(card, input.modelId, input.variant, input.answers);
  const validity = input.validityDaysOverride ?? card.quoteValidityDays;
  const source = { kind: card.source.kind, label: card.source.label, rateCardId: card.id, effectiveFrom: card.source.effectiveFrom };
  if (q.status === "unpriced") {
    return { status: "unpriced", amount: null, lines: [], source, partner: mode.partnerName, partnerRef: null, quotedAt, validUntil: null, reason: q.reason };
  }
  return {
    status: "priced",
    amount: q.amount,
    lines: q.lines,
    source,
    partner: mode.partnerName,
    partnerRef: null,
    quotedAt,
    validUntil: input.whatIf ? null : addDays(quotedAt, validity),
    ...(q.grade ? { grade: q.grade } : {}),
  };
}
