/**
 * THE STORE'S CREDIT LINE — how much trade-in value a store may carry.
 *
 * When a customer upgrades, the store gives the trade-in value off the new
 * phone on the spot and keeps the old phone. Until the buyback partner COLLECTS
 * it (or, if the programme says so, CLEARS it after inspection), that value is
 * money the store has advanced and not got back. Every store has a limit on how
 * much of that it may carry; at the limit it stops taking trade-ins until a
 * pickup frees the line.
 *
 * The line is an append-only ledger of signed events, never a balance column,
 * so every rupee of exposure can be traced to a case:
 *
 *   hold          trade-in locked at the counter            exposure +T
 *   release       collected / cleared / cancelled           exposure −T
 *   chargeback    partner paid less than T, or nothing      exposure +shortfall
 *   recovery      the store made good / dispute won         exposure −recovered
 *
 * Invariants checked by `checkLedger` (and by the tests):
 *   • a case is released at most once and never by more than it held;
 *   • a case is recovered by no more than it was charged back;
 *   • exposure is never negative.
 */

import { type Rupees } from "./money.ts";

export type CreditEventKind = "hold" | "release" | "chargeback" | "recovery";

export type CreditEvent = { kind: CreditEventKind; caseId: string; amount: Rupees; at: string; note?: string };

export const SIGN: Record<CreditEventKind, 1 | -1> = { hold: 1, release: -1, chargeback: 1, recovery: -1 };

export type ReleasePoint = "collected" | "cleared";

export type CreditPolicy = {
  limit: Rupees;
  /** When a held trade-in stops counting against the line. */
  releaseOn: ReleasePoint;
  /** Utilisation (0–1) at which the store is told to book a pickup. */
  warnAt: number;
  /** A device held longer than this many days should be collected. */
  maxAgeDays: number;
  /** This many devices waiting is a pickup, whatever their value. */
  pickupAtCount: number;
};

export function exposure(events: CreditEvent[]): Rupees {
  return events.reduce((s, e) => s + SIGN[e.kind] * e.amount, 0);
}

export type CreditPosition = {
  limit: Rupees;
  exposure: Rupees;
  available: Rupees;
  utilisation: number;
  held: Rupees;
  chargebacksOpen: Rupees;
  state: "ok" | "warn" | "full" | "over";
};

export function position(policy: Pick<CreditPolicy, "limit" | "warnAt">, events: CreditEvent[]): CreditPosition {
  let held = 0;
  let cb = 0;
  for (const e of events) {
    if (e.kind === "hold") held += e.amount;
    if (e.kind === "release") held -= e.amount;
    if (e.kind === "chargeback") cb += e.amount;
    if (e.kind === "recovery") cb -= e.amount;
  }
  const exp = held + cb;
  const available = policy.limit - exp;
  const utilisation = policy.limit > 0 ? exp / policy.limit : exp > 0 ? Infinity : 0;
  const state = exp > policy.limit ? "over" : available === 0 && exp > 0 ? "full" : utilisation >= policy.warnAt ? "warn" : "ok";
  return { limit: policy.limit, exposure: exp, available, utilisation, held, chargebacksOpen: cb, state };
}

export type LockCheck =
  | { ok: true; availableAfter: Rupees; utilisationAfter: number; warn: string | null }
  | { ok: false; reason: string; shortBy: Rupees };

/** May the store advance `amount` more? A trade-in either fits under the line or it does not. */
export function canHold(policy: Pick<CreditPolicy, "limit" | "warnAt">, events: CreditEvent[], amount: Rupees): LockCheck {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "Trade-in value must be a positive whole amount.", shortBy: 0 };
  const p = position(policy, events);
  if (amount > p.available) {
    const shortBy = amount - Math.max(0, p.available);
    return {
      ok: false,
      shortBy,
      reason:
        p.available <= 0
          ? "Credit line used up — book a pickup."
          : `Needs ₹${amount.toLocaleString("en-IN")} of credit, only ₹${p.available.toLocaleString("en-IN")} free — book a pickup.`,
    };
  }
  const after = p.exposure + amount;
  const utilisationAfter = policy.limit > 0 ? after / policy.limit : 1;
  return {
    ok: true,
    availableAfter: policy.limit - after,
    utilisationAfter,
    warn: utilisationAfter >= policy.warnAt ? `Line ${Math.round(utilisationAfter * 100)}% used after this — book a pickup soon.` : null,
  };
}

export type HeldDevice = { caseId: string; value: Rupees; heldSince: string };

export type PickupAdvice = { due: boolean; reasons: string[]; oldestDays: number | null };

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** Should this store book a pickup now? Any one reason is enough. */
export function pickupAdvice(policy: CreditPolicy, events: CreditEvent[], held: HeldDevice[], now: string): PickupAdvice {
  const reasons: string[] = [];
  if (held.length === 0) return { due: false, reasons, oldestDays: null };
  const p = position(policy, events);
  const oldestDays = Math.max(...held.map((h) => daysBetween(h.heldSince, now)));
  if (p.utilisation >= policy.warnAt) reasons.push(`Credit line ${Math.round(p.utilisation * 100)}% used (pickup at ${Math.round(policy.warnAt * 100)}%).`);
  if (oldestDays >= policy.maxAgeDays) reasons.push(`Oldest device has waited ${oldestDays} days (limit ${policy.maxAgeDays}).`);
  if (held.length >= policy.pickupAtCount) reasons.push(`${held.length} devices waiting (pickup at ${policy.pickupAtCount}).`);
  return { due: reasons.length > 0, reasons, oldestDays };
}

/** Ledger invariants. Returns the violations; an empty list is a clean ledger. */
export function checkLedger(events: CreditEvent[]): string[] {
  const errs: string[] = [];
  const perCase = new Map<string, { hold: number; release: number; cb: number; rec: number; releases: number }>();
  let running = 0;
  for (const e of events) {
    if (!Number.isInteger(e.amount) || e.amount <= 0) errs.push(`${e.kind} on ${e.caseId} has a non-positive or fractional amount (${e.amount}).`);
    const c = perCase.get(e.caseId) ?? { hold: 0, release: 0, cb: 0, rec: 0, releases: 0 };
    if (e.kind === "hold") c.hold += e.amount;
    if (e.kind === "release") {
      c.release += e.amount;
      c.releases += 1;
    }
    if (e.kind === "chargeback") c.cb += e.amount;
    if (e.kind === "recovery") c.rec += e.amount;
    perCase.set(e.caseId, c);
    running += SIGN[e.kind] * e.amount;
    if (running < 0) errs.push(`Exposure went negative (${running}) at ${e.kind} on ${e.caseId}.`);
  }
  for (const [id, c] of perCase) {
    if (c.releases > 1) errs.push(`Case ${id} was released ${c.releases} times.`);
    if (c.release > c.hold) errs.push(`Case ${id} released ₹${c.release} against a hold of ₹${c.hold}.`);
    if (c.rec > c.cb) errs.push(`Case ${id} recovered ₹${c.rec} against chargebacks of ₹${c.cb}.`);
  }
  return errs;
}
