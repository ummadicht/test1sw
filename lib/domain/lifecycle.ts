/**
 * CASE AND PICKUP LIFECYCLE — where a trade-in is, and what the line owes.
 *
 *   draft ─► quoted ─┬─► repair_chosen                     (customer repairs)
 *                    ├─► walked_away
 *                    └─► locked ─┬─► cancelled            (before pickup — line released)
 *                                └─► in_pickup ─┬─► locked (taken off the batch)
 *                                               └─► collected ─┬─► cleared
 *                                                              ├─► regraded
 *                                                              ├─► rejected     (phone comes back)
 *                                                              └─► not_received (dispute)
 *
 * The rule that keeps the credit line honest: after the partner's verdict the
 * store's exposure on a case equals exactly what it advanced and has not got
 * back, T − V (V = what the partner accepted). `collectionEvents` and
 * `clearanceEvents` produce the ledger events that make that true for either
 * release point, and the tests walk every outcome both ways.
 */

import type { Rupees } from "./money.ts";
import type { CreditEvent, ReleasePoint } from "./credit.ts";
import { RuleError } from "./errors.ts";

export type CaseStatus =
  | "draft"
  | "quoted"
  | "repair_chosen"
  | "walked_away"
  | "locked"
  | "cancelled"
  | "in_pickup"
  | "collected"
  | "cleared"
  | "regraded"
  | "rejected"
  | "not_received";

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  draft: "Assessing",
  quoted: "Quoted",
  repair_chosen: "Chose repair",
  walked_away: "Walked away",
  locked: "Traded in · at store",
  cancelled: "Cancelled",
  in_pickup: "Awaiting pickup",
  collected: "Collected",
  cleared: "Cleared",
  regraded: "Regraded",
  rejected: "Rejected",
  not_received: "Not received",
};

const NEXT: Record<CaseStatus, CaseStatus[]> = {
  draft: ["quoted", "walked_away"],
  quoted: ["quoted", "repair_chosen", "walked_away", "locked"],
  repair_chosen: [],
  walked_away: [],
  locked: ["cancelled", "in_pickup"],
  cancelled: [],
  in_pickup: ["locked", "collected"],
  collected: ["cleared", "regraded", "rejected", "not_received"],
  cleared: [],
  regraded: [],
  rejected: [],
  not_received: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) {
    throw new RuleError(`A case that is "${CASE_STATUS_LABEL[from]}" cannot become "${CASE_STATUS_LABEL[to]}".`);
  }
}

/** Statuses in which the store (or partner) holds a traded-in phone the line still counts. */
export const OPEN_TRADE_STATUSES: CaseStatus[] = ["locked", "in_pickup", "collected"];
/** Statuses in which the phone is physically at the store. */
export const AT_STORE_STATUSES: CaseStatus[] = ["locked", "in_pickup"];

export type ClearanceOutcome = "cleared" | "regraded" | "rejected" | "not_received";

export const OUTCOME_LABEL: Record<ClearanceOutcome, string> = {
  cleared: "Cleared at the quoted value",
  regraded: "Regraded — partner pays less",
  rejected: "Rejected — phone returned to store",
  not_received: "Not received by partner",
};

/** Ledger events for the moment the partner's collector takes the phone. */
export function collectionEvents(releaseOn: ReleasePoint, caseId: string, held: Rupees, at: string): CreditEvent[] {
  return releaseOn === "collected" ? [{ kind: "release", caseId, amount: held, at, note: "Collected by partner" }] : [];
}

/** Cancelling a locked trade-in before pickup gives the whole hold back. */
export function cancelEvents(caseId: string, held: Rupees, at: string): CreditEvent[] {
  return [{ kind: "release", caseId, amount: held, at, note: "Trade-in cancelled before pickup" }];
}

/**
 * Ledger events for the partner's verdict.
 * `accepted` is what the partner pays for the phone: T when cleared, less when
 * regraded, 0 when rejected or not received.
 */
export function clearanceEvents(input: {
  releaseOn: ReleasePoint;
  caseId: string;
  held: Rupees;
  outcome: ClearanceOutcome;
  accepted: Rupees;
  /** Who carries a regrade / rejection shortfall. */
  shortfallLiability: "store" | "partner";
  at: string;
}): { events: CreditEvent[]; accepted: Rupees; shortfall: Rupees } {
  const { releaseOn, caseId, held, outcome, at } = input;
  let accepted = input.accepted;
  if (!Number.isInteger(accepted) || accepted < 0) throw new RuleError("Accepted value must be a whole, non-negative rupee amount.", 400);
  if (outcome === "cleared") accepted = held;
  if (outcome === "rejected" || outcome === "not_received") accepted = 0;
  if (outcome === "regraded") {
    if (accepted >= held) throw new RuleError("A regrade must be below the trade-in — else use Cleared.", 400);
  }
  const shortfall = held - accepted;
  const events: CreditEvent[] = [];
  if (releaseOn === "cleared") events.push({ kind: "release", caseId, amount: held, at, note: "Cleared by partner" });
  // not_received is always the store's exposure until resolved: the store handed
  // it over, so it is a DISPUTE against the partner, settled by a recovery event.
  const storeCarries = outcome === "not_received" || input.shortfallLiability === "store";
  if (shortfall > 0 && storeCarries) {
    events.push({
      kind: "chargeback",
      caseId,
      amount: shortfall,
      at,
      note:
        outcome === "regraded"
          ? `Regraded: partner pays ₹${accepted.toLocaleString("en-IN")} of ₹${held.toLocaleString("en-IN")}`
          : outcome === "rejected"
            ? "Rejected by partner — phone returned"
            : "Partner reports not received — dispute open",
    });
  }
  return { events, accepted, shortfall };
}

export type PickupStatus = "requested" | "scheduled" | "collected" | "reconciled" | "settled" | "cancelled";

export const PICKUP_STATUS_LABEL: Record<PickupStatus, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  collected: "Collected",
  reconciled: "Verified",
  settled: "Settled",
  cancelled: "Cancelled",
};

const PICKUP_NEXT: Record<PickupStatus, PickupStatus[]> = {
  requested: ["scheduled", "collected", "cancelled"],
  scheduled: ["collected", "cancelled"],
  collected: ["reconciled"],
  reconciled: ["settled"],
  settled: [],
  cancelled: [],
};

export function canPickupTransition(from: PickupStatus, to: PickupStatus): boolean {
  return PICKUP_NEXT[from].includes(to);
}
