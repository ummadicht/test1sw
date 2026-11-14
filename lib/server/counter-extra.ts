import type { SessionUser } from "./auth";
import { getCase, forViewer, type CaseView } from "./cases";

/**
 * getCase for any viewer. The partner rule (a case still at the counter, or one
 * that never became a trade-in, is "not found" to the buyback partner) now lives
 * in cases.ts `caseInScope`, so every read path enforces it; this stays as the
 * name the counter pages import.
 *
 * What the partner may SEE of a case is cases.ts `forViewer`, which getCase now
 * applies on every read path: no refurb cost, no answer (refurb quote vs
 * trade-in + bonus), and no SELL price — `marketSell` is PriceIQ's refurbished
 * market listing, the store's margin (it used to reach the partner: spec §9). The
 * grade the partner sees is the report frozen at lock, never the live one.
 */
/**
 * Strips all store balance, credit limit, and available wallet figures from a CaseView
 * when the viewer is a store counter login (`advisor`). Only `store_manager` (and higher admins)
 * may see store balance figures.
 */
export function redactCaseForCounter(u: SessionUser, view: CaseView): CaseView {
  if (u.role !== "advisor") return view;
  return {
    ...view,
    creditCheck: null,
    lockBlockers: view.lockBlockers.map((b) =>
      /credit limit|free\)/i.test(b) ? "Requires store manager approval to proceed." : b
    ),
  };
}

export async function getCaseForViewer(u: SessionUser, id: string): Promise<CaseView> {
  const v = forViewer(u, await getCase(u, id));
  return redactCaseForCounter(u, v);
}
