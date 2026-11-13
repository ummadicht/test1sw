/**
 * THE BUYBACK PARTNER SEAM — the programme's buyback partner (its org row).
 */

import { queryOne, parseJson, nowIso, db } from "./db";
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
  priceiq?: PriceiqMeta;
  priceiqWhy?: string;
  grade?: MarketGrade;
};

export type PartnerMode = {
  partnerId: string;
  partnerName: string;
  kind: "partner_ratecard" | "none";
  label: string;
  why: string;
  rateCardId: string | null;
};

type CardRow = { id: string; data: string; created_at: string };

export function activeRateCardSync(partnerId: string): RateCard | null {
  if (process.env.DATABASE_URL || process.env.PGHOST) return null;
  try {
    const row = db().prepare(
      `SELECT id, data, created_at FROM rate_cards WHERE partner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`
    ).get(partnerId) as CardRow | undefined;
    if (!row) return null;
    const card = parseJson<RateCard | null>(row.data, null);
    return card && card.source?.kind === "partner_ratecard" ? { ...card, id: row.id } : null;
  } catch {
    return null;
  }
}

/** The partner's active uploaded rate card, or null. */
export function activeRateCard(partnerId: string): Promise<RateCard | null> & (RateCard | null) {
  const sync = activeRateCardSync(partnerId);
  const p = (async () => {
    if (sync !== null) return sync;
    const row = await queryOne<CardRow>(
      `SELECT id, data, created_at FROM rate_cards WHERE partner_id = $1 AND active = 1 ORDER BY created_at DESC LIMIT 1`,
      [partnerId]
    );
    if (!row) return null;
    const card = parseJson<RateCard | null>(row.data, null);
    return card && card.source?.kind === "partner_ratecard" ? { ...card, id: row.id } : null;
  })();
  if (sync !== null) {
    return Object.assign(p, sync);
  }
  return p as any;
}

/**
 * A rate card by its id, active or not.
 */
export async function rateCardById(id: string): Promise<RateCard | null> {
  const row = await queryOne<{ id: string; data: string }>(
    `SELECT id, data FROM rate_cards WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  const card = parseJson<RateCard | null>(row.data, null);
  return card && card.source?.kind === "partner_ratecard" ? { ...card, id: row.id } : null;
}

export function partnerModeSync(partnerId: string): PartnerMode | null {
  if (process.env.DATABASE_URL || process.env.PGHOST) return null;
  try {
    const p = db().prepare(`SELECT name FROM orgs WHERE id = ? AND kind = 'partner'`).get(partnerId) as { name?: string } | undefined;
    const partnerName = p?.name ?? "Buyback partner";
    const card = activeRateCardSync(partnerId);
    if (!card) return { partnerId, partnerName, kind: "none", label: "No rate card", why: "No rate card loaded — a phone PriceIQ can't price gets no trade-in price.", rateCardId: null };
    return { partnerId, partnerName, kind: "partner_ratecard", label: card.source.label, why: `The buyback partner's rate card from ${card.source.effectiveFrom}.`, rateCardId: card.id };
  } catch {
    return null;
  }
}

export function partnerMode(partnerId: string): Promise<PartnerMode> & PartnerMode {
  const sync = partnerModeSync(partnerId);
  const p: Promise<PartnerMode> = (async (): Promise<PartnerMode> => {
    if (sync) return sync;
    const p = await queryOne<{ name: string }>(
      `SELECT name FROM orgs WHERE id = $1 AND kind = 'partner'`,
      [partnerId]
    );
    const partnerName = p?.name ?? "Buyback partner";
    const card = await activeRateCard(partnerId);
    if (!card) return { partnerId, partnerName, kind: "none", label: "No rate card", why: "No rate card loaded — a phone PriceIQ can't price gets no trade-in price.", rateCardId: null };
    return { partnerId, partnerName, kind: "partner_ratecard", label: card.source.label, why: `The buyback partner's rate card from ${card.source.effectiveFrom}.`, rateCardId: card.id };
  })();
  if (sync) {
    return Object.assign(p, sync);
  }
  return p as Promise<PartnerMode> & PartnerMode;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * The partner's rate-card price for a phone.
 */
export async function partnerQuote(input: {
  partnerId: string;
  modelId: string;
  variant: string;
  answers: ConditionAnswers;
  imei?: string | null;
  validityDaysOverride?: number | null;
  whatIf?: boolean;
}): Promise<PartnerQuote> {
  const mode = await partnerMode(input.partnerId);
  const quotedAt = nowIso();
  const card = mode.rateCardId ? await activeRateCard(input.partnerId) : null;
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
