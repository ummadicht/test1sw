/**
 * DATA CLEARING — after the customer accepts the trade-in.
 *
 * The customer clears their own phone, from its own Settings, while still at
 * the counter: they sign out of their Samsung and Google accounts (which turns
 * off the theft lock that would otherwise stop the next owner setting it up),
 * then factory-reset it. The store records what it saw: the phone restarted to
 * its setup screen, and setup did not ask for the previous owner's account.
 *
 * This is a record of a factory reset done by the customer, observed by the
 * store — not a certified erasure, and it never says it is.
 */

import type { CaseStatus } from "./lifecycle.ts";

export const DATA_CLEAR_LABEL = "Customer's factory reset, seen by the store — not a certified erasure";

/** While the phone is still at the store. Before acceptance the phone is the customer's; after pickup it is gone. */
export const DATA_CLEAR_STATUSES: CaseStatus[] = ["locked", "in_pickup"];

export const DATA_CLEAR_STEPS = [
  ["accountsSignedOut", "Customer signed out of Samsung and Google"],
  ["resetDone", "Customer factory-reset it from Settings"],
  ["setupScreenSeen", "Phone restarted to its Welcome screen"],
  ["noPreviousAccount", "Setup didn't ask for the old owner's account"],
] as const;

export type DataClearStep = (typeof DATA_CLEAR_STEPS)[number][0];

export type DataClearRecord = {
  label: string;
  steps: Record<DataClearStep, true>;
  note: string | null;
  by: string;
  at: string;
};

/**
 * done            — recorded after acceptance
 * attested        — an older case: the reset was ticked at hand-over, before this step existed
 * due             — accepted, phone at the store, not recorded yet
 * not_applicable  — not accepted (yet), or the phone already left / went back
 */
export type DataClearState = "done" | "attested" | "due" | "not_applicable";

export function dataClearState(status: CaseStatus, record: DataClearRecord | null, legacyResetAttested: boolean): DataClearState {
  if (record) return "done";
  if (legacyResetAttested) return "attested";
  return DATA_CLEAR_STATUSES.includes(status) ? "due" : "not_applicable";
}

/** The steps not confirmed, as their sentences. Empty = every step confirmed. */
export function missingDataClearSteps(input: Partial<Record<DataClearStep, unknown>>): string[] {
  return DATA_CLEAR_STEPS.filter(([k]) => input[k] !== true).map(([, text]) => text);
}
