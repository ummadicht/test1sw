/**
 * The answer card's rules, kept pure so they are tested without a browser
 * (answerAsks.test.ts): which control sits under each ask, when the card quietly
 * re-quotes, what a partner quote typed in here must look like, and which "Swap up"
 * refusal the tile still has to say. Every sentence the customer reads is the
 * server's (lib/domain/offer.ts); this file only picks where it is answered.
 */

import type { Offer, OfferAsk, StorageOption } from "@/lib/domain/offer";
import type { CaseView } from "@/lib/server/cases";
import { RULESET_VERSION } from "../../lib/domain/decision.ts";

/** Where on this page each ask is answered, and the button that goes there. */
export const ASK_STEP: Partial<Record<OfferAsk["kind"], { step: string; button: string }>> = {
  model: { step: "step-phone", button: "Choose model" },
  partner_quote: { step: "step-tradein", button: "Enter partner quote" },
  repair_quote: { step: "step-repair", button: "Enter repair quote" },
  new_phone: { step: "step-upgrade", button: "Choose new phone" },
};

/** What an advisor reads under "Check this is the right phone": the override is the store manager's (cases.ts, 403 otherwise). */
export const ASK_MANAGER = "Ask your manager to confirm it.";

export type AskControl =
  /** One tap each: the storage chips, with the server's note under them (old market data, PriceIQ unreachable). */
  | { kind: "chips"; options: StorageOption[]; note: string | null }
  /**
   * The partner's quote, typed in right on the card — the two cases nothing else on the card can
   * answer without leaving the answer for the trade-in step:
   *   lapsed    a quote read off the partner's app ran out. SwapUp never re-quotes a quote from the
   *             app, so only today's from the app replaces it (the trade-in step opens the same form: partnerQuoteLapsed).
   *   unlisted  the phone measured a size the model's list doesn't have (a 1TB Ultra). No chip can
   *             be right; the quote entered for the phone settles its storage at the size it
   *             measured (updateCase; the trade-in step offers the same: unlistedSize).
   */
  | { kind: "partner_quote_entry"; why: "lapsed" | "unlisted"; size: string | null }
  /** Go to the step that answers it. */
  | { kind: "step"; step: string; button: string }
  /** The camera says it may be another phone: a store manager records why it is the right one. */
  | { kind: "identity_override" }
  | { kind: "ask_manager"; text: string }
  | { kind: "none" };

export function askControl(a: OfferAsk, v: Pick<CaseView, "partnerManual" | "measuredStorage">, isManager: boolean): AskControl {
  switch (a.kind) {
    case "storage":
      if (a.options.length) return { kind: "chips", options: a.options, note: a.note ?? null };
      // No chips: either the phone measured a size that isn't on file, or the model has no sizes at all.
      if (v.measuredStorage) return { kind: "partner_quote_entry", why: "unlisted", size: v.measuredStorage };
      return { kind: "step", step: "step-phone", button: "Choose storage" };
    case "partner_quote":
      // A partner-app quote on the case is always priced, so this ask can only mean it has lapsed.
      if (v.partnerManual) return { kind: "partner_quote_entry", why: "lapsed", size: null };
      break;
    case "blocked":
      return isManager ? { kind: "identity_override" } : { kind: "ask_manager", text: ASK_MANAGER };
  }
  const go = ASK_STEP[a.kind];
  return go ? { kind: "step", ...go } : { kind: "none" };
}

/**
 * The card's one quiet re-quote, as the store app's answer screen does: an open case whose
 * partner quote has run out — then "Quote expired — re-quoting." is true. A plain reprice is
 * enough (reprice re-quotes an expired quote). Non-null = there is something to re-quote;
 * AnswerCard runs it at most ONCE per page open (a ref), so a partner whose fresh quote comes
 * back already out of date is never asked in a loop. Never for a quote read off the partner's
 * app: reprice rebuilds it as entered, so only a new one helps.
 */
export function autoRequoteKey(v: Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer">): string | null {
  const q = v.quote;
  if (!v.offer?.open || !v.quoteExpired || !q || q.source.kind === "partner_manual") return null;
  return `${v.id} ${q.quotedAt} ${q.validUntil ?? ""}`;
}

/**
 * An open case whose stored decision was made under an older ruleset (decide()'s RULESET_VERSION —
 * 2026-10-18.1 weighs what we pay, the market price + the SwapUp premium): one quiet re-price, the
 * same ONCE per page open, with requote:false — it re-decides from the stored quote and never asks
 * the partner again. null otherwise.
 */
export function staleDecisionKey(v: Pick<CaseView, "id" | "offer"> & { decision?: { version: string } | null }): string | null {
  if (!v.offer?.open || !v.decision || v.decision.version === RULESET_VERSION) return null;
  return `${v.id} ruleset ${v.decision.version}`;
}

/** The tile's "Re-quote": wherever the quiet one applies, in case it failed. */
export const requotable = (v: Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer">): boolean => autoRequoteKey(v) !== null;

/**
 * A quote read off the partner's app that has run out. Re-quoting can't renew it (reprice rebuilds
 * it as entered), so the trade-in step opens its form for today's quote instead of offering a Re-quote.
 */
export const partnerQuoteLapsed = (v: Pick<CaseView, "partnerManual" | "quoteExpired" | "quote">): boolean =>
  !!v.partnerManual && v.quoteExpired && v.quote?.source.kind === "partner_manual";

/**
 * The size the phone measured when it isn't on the model's list (a 1TB Ultra on file as
 * 256/512GB), while the case has no storage: the server's storage ask then offers no chip
 * (lib/domain/offer.ts). The trade-in step takes the partner's quote for it, which settles the storage at
 * that size (cases.ts updateCase) — the Phone step can't, its chips are the sizes the phone ruled out. null otherwise.
 */
export function unlistedSize(v: Pick<CaseView, "device" | "measuredStorage" | "offer">): string | null {
  if (!v.device || v.device.variant || !v.measuredStorage) return null;
  return v.offer?.asks.some((a) => a.kind === "storage" && a.options.length === 0) ? v.measuredStorage : null;
}

/** The server's own check on the identity override (cases.ts updateCase): a reason of at least 8 characters, trimmed. */
export const IDENTITY_REASON_MIN = 8;
export const identityReasonOk = (reason: string): boolean => reason.trim().length >= IDENTITY_REASON_MIN;

/** "18,800" or "₹18800" → 18800; anything but whole rupees → null. */
export function wholeRupees(t: string): number | null {
  const s = t.replace(/[,\s₹]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** The server's limit on a partner quote (cases.ts updateCase). */
const MAX_RUPEES = 500_000;

/**
 * Why a partner quote typed on the card can't be saved yet — the server's own sentences
 * (cases.ts updateCase, partnerQuote), the same as the store app's PartnerQuoteSheet — or null.
 */
export function partnerQuoteProblem(amount: string, reference: string, repaired: string): string | null {
  const n = wholeRupees(amount);
  if (n === null || n <= 0 || n > MAX_RUPEES) return "Quote: whole rupees only.";
  if (!/^[A-Z0-9-]{4,40}$/.test(reference.trim().toUpperCase())) return "Enter the app's reference code.";
  if (repaired.trim()) {
    const r = wholeRupees(repaired);
    if (r === null || r < n) return "Repaired value must be at least the quote.";
  }
  return null;
}

/** The tile's own link when no new phone is chosen. */
export const CHOOSE_NEW_PHONE_LINK = "Choose new phone";
/** The server's refusal that says the same as that link ("Choose the new phone."), however it is worded. */
const SAYS_CHOOSE_NEW_PHONE = /^choose (?:the |a )?new phone\.?$/i;

/**
 * Why "Swap up" is refused, said once in the trade-in tile — and not at all when the tile already
 * says it: as its why (no trade-in), as its warn note (a lapsed partner-app quote), or as its
 * "Choose the new phone" link.
 */
export function swapRefusal(o: Offer): string | null {
  const no = o.actions.swap;
  if (!no) return null;
  if (o.swap.total === null && no === o.swap.why) return null;
  if (no === o.swap.tradeInNote) return null;
  if (!o.swap.newPhone && SAYS_CHOOSE_NEW_PHONE.test(no.trim())) return null;
  return no;
}
