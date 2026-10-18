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
export function getCaseForViewer(u: SessionUser, id: string): CaseView {
  return forViewer(u, getCase(u, id));
}
