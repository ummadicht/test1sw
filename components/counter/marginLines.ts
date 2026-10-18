/**
 * STORE MARGIN — the words under the sell figure of the staff-only "Store
 * margin" (StoreMargin.tsx): where the price came from, or why there is none.
 * Pure, so it is tested without a browser (marginLines.test.ts). The figures
 * are lib/domain/buySell.ts's; this only says where each one came from.
 *
 * Runtime imports are relative with ".ts" so `node --test` can load this file.
 */
import { fmtBp, inr } from "../../lib/domain/money.ts";

type Listed = { listing: number; grade: string; gradeWanted: string; markdownBp: number; week?: string; ageDays?: number; stale?: boolean };
type Market = ({ amount: number } & Listed) | { amount: null; why: string | null };

/**
 * "Refurbished market price ₹32,000 (Good) − 2% · PriceIQ", with " · week 2026-W35, 52 days old" when the
 * market data is over 14 days old, and " · none at Superb" when listed only at a lower grade.
 */
export function sellSourceLine(m: Listed): string {
  const age = m.stale && typeof m.ageDays === "number" ? ` · week ${m.week ?? "?"}, ${m.ageDays} days old` : "";
  const lower = m.gradeWanted !== m.grade ? ` · none at ${m.gradeWanted}` : "";
  return `Refurbished market price ${inr(m.listing)} (${m.grade}) − ${fmtBp(m.markdownBp)} · PriceIQ${age}${lower}`;
}

/** The line under "Sell after refurb": the market listing it came from, the partner's repaired price, or why there is no sell price. */
export function sellSub(x: {
  sellBasis: "market" | "partner" | null;
  sellWhy: string | null;
  market: Market;
  /** The partner's repaired quote's own reason, when it has none. */
  repairedReason: string | null;
  /** The trade-in is a quote typed in from the partner's app. */
  manualQuote: boolean;
  partner: string;
}): string | null {
  const m = x.market;
  if (x.sellBasis === "market" && m.amount !== null) return sellSourceLine(m);
  if (x.sellBasis === "partner") return "Partner's repaired price";
  if (x.repairedReason) return x.repairedReason;
  if (x.manualQuote) return "Not given — enter it from the partner app.";
  return x.sellWhy;
}
