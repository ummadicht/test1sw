/**
 * THE BUYBACK PARTNER SEAM — Cashify, for this programme.
 *
 * Pricing and buyback come from the partner. SwapUp asks it two questions per
 * case — "what is this phone worth AS IT IS?" (the trade-in) and "what would it
 * be worth REPAIRED?" (so the customer can compare) — and records every answer
 * with where it came from.
 *
 * Three ways to get an answer, in order of preference:
 *
 *   partner_live      the partner's quote API. Used only when its credentials
 *                     AND its contract are configured (see env below). The
 *                     request/response mapping is isolated in `liveQuote` and
 *                     must be confirmed against the partner's own API document
 *                     before it is switched on — SwapUp does not guess another
 *                     company's API.
 *   partner_ratecard  the partner's price sheet, uploaded by the partner's
 *                     operations team on /partner. The usual channel for
 *                     retail partners without an API integration.
 *   sample            a built-in SAMPLE card so the app can be demonstrated.
 *                     Every quote from it is labelled sample on every screen.
 *
 * `mode()` reports which one is in force, and why, so the UI never has to
 * guess whether a number is real.
 *
 * Env for the live API (all required to switch it on):
 *   CASHIFY_API_BASE, CASHIFY_PARTNER_ID, CASHIFY_API_KEY, CASHIFY_CONTRACT_CONFIRMED=1
 */

import { db, parseJson, nowIso } from "./db";
import { priceFromCard, type RateCard, type QuoteLine, type PriceSourceKind } from "../domain/ratecard";
import type { ConditionAnswers } from "../domain/condition";
import type { Rupees } from "../domain/money";

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
};

export type PartnerMode = {
  partnerId: string;
  partnerName: string;
  kind: PriceSourceKind;
  label: string;
  why: string;
  rateCardId: string | null;
};

function liveConfigured(): { ok: boolean; why: string } {
  const need = ["CASHIFY_API_BASE", "CASHIFY_PARTNER_ID", "CASHIFY_API_KEY"].filter((k) => !process.env[k]);
  if (need.length) return { ok: false, why: `Live partner API not configured (${need.join(", ")} not set).` };
  if (process.env.CASHIFY_CONTRACT_CONFIRMED !== "1")
    return { ok: false, why: "Live partner API credentials are set but the API contract has not been confirmed (CASHIFY_CONTRACT_CONFIRMED)." };
  return { ok: true, why: "Live partner API." };
}

type CardRow = { id: string; data: string; created_at: string };

export function activeRateCard(partnerId: string): RateCard | null {
  const row = db()
    .prepare(`SELECT id, data, created_at FROM rate_cards WHERE partner_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`)
    .get(partnerId) as CardRow | undefined;
  return row ? { ...parseJson<RateCard>(row.data, null as unknown as RateCard), id: row.id } : null;
}

export function partnerMode(partnerId: string): PartnerMode {
  const p = db().prepare(`SELECT name FROM orgs WHERE id = ? AND kind = 'partner'`).get(partnerId) as { name: string } | undefined;
  const partnerName = p?.name ?? "Buyback partner";
  const live = liveConfigured();
  if (live.ok) return { partnerId, partnerName, kind: "partner_live", label: `${partnerName} live quote`, why: live.why, rateCardId: null };
  const card = activeRateCard(partnerId);
  if (!card) {
    return { partnerId, partnerName, kind: "sample", label: "No rate card", why: `${live.why} No rate card uploaded either.`, rateCardId: null };
  }
  return {
    partnerId,
    partnerName,
    kind: card.source.kind,
    label: card.source.label,
    why:
      card.source.kind === "sample"
        ? `${live.why} Using the built-in SAMPLE rate card — figures are illustrative, not ${partnerName}'s.`
        : `${live.why} Using ${partnerName}'s rate card effective ${card.source.effectiveFrom}.`,
    rateCardId: card.id,
  };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Ask the partner what a phone is worth. Never throws for a pricing miss —
 * an unpriced or failed quote is an answer the UI shows, not an exception.
 */
export async function partnerQuote(input: {
  partnerId: string;
  modelId: string;
  variant: string;
  answers: ConditionAnswers;
  imei?: string | null;
  validityDaysOverride?: number | null;
  /** A what-if (repaired value) — never binding, never sent as an order. */
  whatIf?: boolean;
}): Promise<PartnerQuote> {
  const mode = partnerMode(input.partnerId);
  const quotedAt = nowIso();
  if (mode.kind === "partner_live") {
    try {
      return await liveQuote(input, mode, quotedAt);
    } catch (e) {
      return {
        status: "error",
        amount: null,
        lines: [],
        source: { kind: "partner_live", label: mode.label },
        partner: mode.partnerName,
        partnerRef: null,
        quotedAt,
        validUntil: null,
        reason: `The partner's quote service did not answer: ${(e as Error).message}`,
      };
    }
  }
  const card = mode.rateCardId ? activeRateCard(input.partnerId) : null;
  if (!card) {
    return {
      status: "unpriced",
      amount: null,
      lines: [],
      source: { kind: "sample", label: "No rate card" },
      partner: mode.partnerName,
      partnerRef: null,
      quotedAt,
      validUntil: null,
      reason: "No partner rate card is loaded, so there is no trade-in price.",
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
  };
}

/**
 * The live call. Deliberately small and explicit: the endpoint path, payload and
 * response fields below are the ONLY place SwapUp touches the partner's API, and
 * must be checked against the partner's document before
 * CASHIFY_CONTRACT_CONFIRMED is set. A response without a numeric price is an
 * error, never a zero.
 */
async function liveQuote(
  input: Parameters<typeof partnerQuote>[0],
  mode: PartnerMode,
  quotedAt: string
): Promise<PartnerQuote> {
  const base = process.env.CASHIFY_API_BASE!.replace(/\/$/, "");
  const path = process.env.CASHIFY_QUOTE_PATH || "/quotes";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CASHIFY_API_KEY}`,
        "x-partner-id": process.env.CASHIFY_PARTNER_ID!,
      },
      body: JSON.stringify({
        model: input.modelId,
        variant: input.variant,
        condition: input.answers,
        imei: input.whatIf ? undefined : input.imei ?? undefined,
        purpose: input.whatIf ? "estimate" : "exchange",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const price = Number(body.price ?? body.amount);
    if (!Number.isFinite(price) || price < 0) throw new Error("response carried no price");
    const amount = Math.floor(price);
    const validUntil = typeof body.valid_until === "string" ? body.valid_until : null;
    return {
      status: "priced",
      amount,
      lines: [{ label: `${mode.partnerName} quote`, amount }],
      source: { kind: "partner_live", label: mode.label },
      partner: mode.partnerName,
      partnerRef: typeof body.quote_id === "string" ? body.quote_id : null,
      quotedAt,
      validUntil: input.whatIf ? null : validUntil,
    };
  } finally {
    clearTimeout(timer);
  }
}
