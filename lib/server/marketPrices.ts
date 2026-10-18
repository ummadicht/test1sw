import { nowIso } from "./db";
import { cachedMarket, type MarketAsk } from "./priceiq";
import { marketSell, type MarketSell } from "../domain/marketSell";
import type { ConditionAnswers } from "../domain/condition";

/**
 * The store's SELL price for a phone on a case: PriceIQ's refurbished market price at the grade the
 * phone comes out at after refurb, less the 5%→2% markdown (lib/domain/marketSell.ts).
 *
 * A page view reads the answer SwapUp already keeps (lib/server/priceiq.ts cachedMarket) and, when it
 * is over an hour old, refreshes it in the background — the page never waits on PriceIQ. Over 14 days
 * old the price is shown with its age; over 90 days there is none; PriceIQ unreachable → the last
 * good answer, labelled. Never a made-up price.
 */

export type CaseMarketSell = MarketSell & { source: "PriceIQ · refurbished market" };

/** The sell price for a phone on a case, from PriceIQ — or why there is none. */
export function caseMarketSell(input: {
  modelId: string | null;
  variant: string | null;
  brand?: string | null;
  model: string | null;
  condition: ConditionAnswers | null;
}): CaseMarketSell {
  const source = "PriceIQ · refurbished market" as const;
  if (!input.modelId || !input.variant || !input.model) return { amount: null, why: "The phone's model and storage aren't on the case yet.", source };
  const ask: MarketAsk = { modelId: input.modelId, variant: input.variant, brand: input.brand ?? "", model: input.model };
  const read = cachedMarket(ask);
  return {
    ...marketSell({ answer: read.answer, noAnswerWhy: read.why, condition: input.condition, label: `${input.model} ${input.variant}`, asOf: nowIso() }),
    source,
  };
}
