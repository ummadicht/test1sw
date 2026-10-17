/**
 * The answer card's rules, kept pure so they are tested without a browser
 * (answerAsks.test.ts): which control sits under each ask, when the card quietly
 * re-quotes, what a Cashify quote typed in here must look like, and which "Swap up"
 * refusal the tile still has to say. Every sentence the customer reads is the
 * server's (lib/domain/offer.ts); this file only picks where it is answered.
 */

import type { Offer, OfferAsk, StorageOption } from "@/lib/domain/offer";
import type { CaseView } from "@/lib/server/cases";

/** Where on this page each ask is answered, and the button that goes there. */
export const ASK_STEP: Partial<Record<OfferAsk["kind"], { step: string; button: string }>> = {
  model: { step: "step-phone", button: "Choose the model" },
  partner_quote: { step: "step-tradein", button: "Enter the Cashify quote" },
  repair_quote: { step: "step-repair", button: "Enter the repair quote" },
  new_phone: { step: "step-upgrade", button: "Choose the new phone" },
};

/** What an advisor reads under "Check this is the right phone": the override is the store manager's (cases.ts, 403 otherwise). */
export const ASK_MANAGER = "Ask your store manager to confirm it.";

export type AskControl =
  /** One tap each: the storage chips, with the server's sample note under them while any price is a sample. */
  | { kind: "chips"; options: StorageOption[]; note: string | null }
  /**
   * The Cashify quote, typed in right on the card — the two cases nothing else on the card can
   * answer, and whose step 5 is folded away under the answer:
   *   lapsed    a quote read off the Cashify app ran out. SwapUp never re-quotes a quote from the
   *             app, so only today's from the app replaces it (step 5 opens the same form: cashifyLapsed).
   *   unlisted  the phone measured a size the model's list doesn't have (a 1TB Ultra). No chip can
   *             be right; the quote entered for the phone settles its storage at the size it
   *             measured (updateCase; step 5 offers the same: unlistedSize).
   */
  | { kind: "cashify"; why: "lapsed" | "unlisted"; size: string | null }
  /** Open the folded steps at the one that answers it. */
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
      if (v.measuredStorage) return { kind: "cashify", why: "unlisted", size: v.measuredStorage };
      return { kind: "step", step: "step-phone", button: "Choose it in step 1" };
    case "partner_quote":
      // A Cashify-app quote on the case is always priced, so this ask can only mean it has lapsed.
      if (v.partnerManual) return { kind: "cashify", why: "lapsed", size: null };
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
 * back already out of date is never asked in a loop. Never for a quote read off the Cashify
 * app: reprice rebuilds it as entered, so only a new one helps.
 */
export function autoRequoteKey(v: Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer">): string | null {
  const q = v.quote;
  if (!v.offer?.open || !v.quoteExpired || !q || q.source.kind === "partner_manual") return null;
  return `${v.id} ${q.quotedAt} ${q.validUntil ?? ""}`;
}

/** The tile's "Re-quote": wherever the quiet one applies, in case it failed. */
export const requotable = (v: Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer">): boolean => autoRequoteKey(v) !== null;

/**
 * A quote read off the Cashify app that has run out. Re-quoting can't renew it (reprice rebuilds
 * it as entered), so step 5 opens its form for today's quote instead of offering a Re-quote.
 */
export const cashifyLapsed = (v: Pick<CaseView, "partnerManual" | "quoteExpired" | "quote">): boolean =>
  !!v.partnerManual && v.quoteExpired && v.quote?.source.kind === "partner_manual";

/**
 * The size the phone measured when it isn't on the model's list (a 1TB Ultra on file as
 * 256/512GB), while the case has no storage: the server's storage ask then offers no chip
 * (lib/domain/offer.ts). Step 5 takes the Cashify quote for it, which settles the storage at that
 * size (cases.ts updateCase) — step 1 can't, its chips are the sizes the phone ruled out. null otherwise.
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
 * Why a Cashify quote typed on the card can't be saved yet — the server's own sentences
 * (cases.ts updateCase, partnerQuote), the same as the store app's PartnerQuoteSheet — or null.
 */
export function cashifyQuoteProblem(amount: string, reference: string, repaired: string): string | null {
  const n = wholeRupees(amount);
  if (n === null || n <= 0 || n > MAX_RUPEES) return "Enter the partner's quote as a whole rupee amount.";
  if (!/^[A-Z0-9-]{4,40}$/.test(reference.trim().toUpperCase())) return "Enter the reference code the partner's app shows for this quote.";
  if (repaired.trim()) {
    const r = wholeRupees(repaired);
    if (r === null || r < n) return "The repaired value must be a whole rupee amount, at least the as-is quote.";
  }
  return null;
}

/** The tile's own link when no new phone is chosen. */
export const CHOOSE_NEW_PHONE_LINK = "Choose the new phone";

/**
 * Why "Swap up" is refused, said once in the trade-in tile — and not at all when the tile already
 * says it: as its why (no trade-in), as its warn note (a lapsed Cashify quote), or as its
 * "Choose the new phone" link.
 */
export function swapRefusal(o: Offer): string | null {
  const no = o.actions.swap;
  if (!no) return null;
  if (o.swap.total === null && no === o.swap.why) return null;
  if (no === o.swap.tradeInNote) return null;
  if (!o.swap.newPhone && no.replace(/\.$/, "") === CHOOSE_NEW_PHONE_LINK) return null;
  return no;
}
