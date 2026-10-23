/**
 * The answer card's rules, kept pure so they are tested without a browser
 * (answerAsks.test.ts): which control sits under each ask, when the card quietly
 * re-quotes, which "Swap up" refusal the tile still has to say, and when a condition
 * save waits for the reason the camera asks for. Every sentence the customer reads is
 * the server's (lib/domain/offer.ts); this file only picks where it is answered. No
 * price is ever typed in here: the trade-in is the system's, moved only by what's wrong.
 */

import type { Offer, OfferAsk, StorageOption } from "@/lib/domain/offer";
import type { CasePatch, CaseView } from "@/lib/server/cases";
import { RULESET_VERSION } from "../../lib/domain/decision.ts";
import { CAMERA_REASON_MIN, needsCameraReason } from "../../lib/domain/gradeiqMap.ts";

export { CAMERA_REASON_MIN };

/** Where on this page each ask is answered, and the button that goes there. `no_price` has none: it is text only. */
export const ASK_STEP: Partial<Record<OfferAsk["kind"], { step: string; button: string }>> = {
  model: { step: "step-phone", button: "Choose model" },
  repair_quote: { step: "step-repair", button: "Enter repair quote" },
  new_phone: { step: "step-upgrade", button: "Choose new phone" },
};

/** What an advisor reads under "Check this is the right phone": the override is the store manager's (cases.ts, 403 otherwise). */
export const ASK_MANAGER = "Ask your manager to confirm it.";

export type AskControl =
  /** One tap each: the storage chips, with the server's note under them (old market data, PriceIQ unreachable). */
  | { kind: "chips"; options: StorageOption[]; note: string | null }
  /** Go to the step that answers it. */
  | { kind: "step"; step: string; button: string }
  /** The camera says it may be another phone: a store manager records why it is the right one. */
  | { kind: "identity_override" }
  | { kind: "ask_manager"; text: string }
  | { kind: "none" };

export function askControl(a: OfferAsk, v: Pick<CaseView, "measuredStorage">, isManager: boolean): AskControl {
  switch (a.kind) {
    case "storage":
      if (a.options.length) return { kind: "chips", options: a.options, note: a.note ?? null };
      // No chips: the phone measured a size that isn't on file (its text says so — no price for that
      // size, never a guessed one), or the model has no sizes at all.
      if (v.measuredStorage) return { kind: "none" };
      return { kind: "step", step: "step-phone", button: "Choose storage" };
    case "blocked":
      return isManager ? { kind: "identity_override" } : { kind: "ask_manager", text: ASK_MANAGER };
  }
  const go = ASK_STEP[a.kind];
  return go ? { kind: "step", ...go } : { kind: "none" };
}

/** What the quiet re-quote reads off the case. */
type RequoteView = Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer" | "condition" | "conditionProblems" | "quoteBlocked">;

/**
 * The card's one quiet re-quote, as the store app's answer screen does: an open case whose
 * quote has run out — then "Quote expired — re-quoting." is true — or that nothing priced last
 * time (a rate card uploaded since prices it, with nobody touching the case); or, with the
 * storage not known yet, whose storage chips none has a price (the same card prices them) — only
 * where reprice can price chips at all: a condition recorded, consistent with the faults, and no
 * identity block (cases.ts reprice; a new case before "What's wrong" has no condition, so asking
 * would change nothing). A plain reprice is enough (reprice re-asks all three). Non-null = there
 * is something to re-quote; AnswerCard runs it at most ONCE per page open (a ref), so a quote that
 * comes back already out of date, or still unpriced, is never asked for in a loop.
 */
export function autoRequoteKey(v: RequoteView): string | null {
  if (!v.offer?.open) return null;
  const q = v.quote;
  if (q && (v.quoteExpired || q.status !== "priced")) return `${v.id} ${q.quotedAt} ${q.validUntil ?? ""}`;
  const priceable = !!v.condition && !v.conditionProblems.length && !v.quoteBlocked;
  const chips = v.offer.asks.find((a) => a.kind === "storage");
  if (priceable && chips?.kind === "storage" && chips.options.length > 0 && chips.options.every((o) => o.tradeIn === null)) return `${v.id} chips`;
  return null;
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

/**
 * Where the trade-in step offers its ONE "Re-quote": on the step itself when the price has expired
 * or nothing priced the phone (the thing to do now), else behind "Show details" while the price is
 * good. null = no quote to ask again, or a viewer who can't change the case.
 */
export function requoteSpot(v: Pick<CaseView, "quote" | "quoteExpired">, editable: boolean): "step" | "details" | null {
  const q = v.quote;
  if (!editable || !q) return null;
  return v.quoteExpired || q.status !== "priced" || q.amount === null ? "step" : "details";
}

/** The tile's "Re-quote": wherever the quiet one applies, in case it failed. */
export const requotable = (v: RequoteView): boolean => autoRequoteKey(v) !== null;

/**
 * The size the phone measured when it isn't on the model's list (a 1TB Ultra on file as
 * 256/512GB), while the case has no storage: the server's storage ask then offers no chip
 * (lib/domain/offer.ts) and the trade-in step says there is no trade-in price for that size —
 * the Phone step's chips are the sizes the phone ruled out. null otherwise.
 */
export function unlistedSize(v: Pick<CaseView, "device" | "measuredStorage" | "offer">): string | null {
  if (!v.device || v.device.variant || !v.measuredStorage) return null;
  return v.offer?.asks.some((a) => a.kind === "storage" && a.options.length === 0) ? v.measuredStorage : null;
}

/**
 * The server's own check on a reason given against the camera (cases.ts updateCase, CAMERA_REASON_MIN):
 * at least 8 characters, trimmed — for a correction of what it confirmed and for the identity override alike.
 */
export const cameraReasonOk = (reason: string): boolean => reason.trim().length >= CAMERA_REASON_MIN;
export const IDENTITY_REASON_MIN = CAMERA_REASON_MIN;
export const identityReasonOk = cameraReasonOk;

/**
 * A condition save the server refused because the camera confirmed the phone worse (409, "Camera
 * confirmed "Cracked screen", photo 2 — removing it needs a reason."): the change is kept, with that
 * sentence, for ONE reason field (CaseWorkspace). null = nothing to hold — the save went through,
 * failed for another reason, or was not a fault or condition change (the identity override has its own).
 */
export function heldForReason(patch: CasePatch, error: string | null): { patch: CasePatch; why: string } | null {
  const describes = patch.faults !== undefined || patch.condition !== undefined || !!patch.conditionFromFaults;
  return describes && !patch.cameraOverride && needsCameraReason(error) ? { patch, why: error! } : null;
}

/** The held change, sent again with the advisor's reason — the shape updateCase reads (kept with their name). */
export const withCameraReason = (patch: CasePatch, reason: string): CasePatch => ({ ...patch, cameraOverride: { reason: reason.trim() } });

/**
 * That resend failed (a dropped connection, a 502): the held change stays, so its reason field
 * stays open with the typed reason and says the server's sentence. Any other save replaces the
 * held change (heldForReason) — a resend that went through clears it.
 */
export const keepsHeld = (patch: CasePatch, error: string | null): boolean => !!error && !!patch.cameraOverride?.reason && !patch.cameraOverride.identity;

/** The tile's own link when no new phone is chosen. */
export const CHOOSE_NEW_PHONE_LINK = "Choose new phone";
/** The server's refusal that says the same as that link ("Choose the new phone."), however it is worded. */
const SAYS_CHOOSE_NEW_PHONE = /^choose (?:the |a )?new phone\.?$/i;

/**
 * Why the tile has no "We pay", said once: not when the headline's sentence under it already says
 * it (a phone not on the rate card, a measured size not on file — "No market price yet" over
 * "This phone isn't on the rate card yet.").
 */
export function swapWhy(o: Offer): string | null {
  return o.swap.total === null && o.swap.why !== o.reason ? o.swap.why : null;
}

/**
 * Why "Swap up" is refused, said once in the trade-in tile — and not at all when the card already
 * says it: as the headline's sentence, as the tile's why (no trade-in), as its warn note, or as its
 * "Choose the new phone" link.
 */
export function swapRefusal(o: Offer): string | null {
  const no = o.actions.swap;
  if (!no) return null;
  if (no === o.reason) return null;
  if (o.swap.total === null && no === o.swap.why) return null;
  if (no === o.swap.tradeInNote) return null;
  if (!o.swap.newPhone && SAYS_CHOOSE_NEW_PHONE.test(no.trim())) return null;
  return no;
}
