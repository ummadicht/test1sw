/**
 * THE TRADE-IN FROM PRICEIQ — what the phone is worth as it is, read off the refurbished market.
 *
 * Owner, 2026-10-17: "Ask simple repair quote and price compare from price iq based on grade
 * ...deduct based on % of failure or defects". Owner, 2026-10-18: ONE margin below the market
 * price everywhere — the 5%→2% markdown — and SwapUp's own % per defect, in SwapUp and GradeIQ.
 *
 *   base       PriceIQ's LOWEST refurbished-market listing for this model + storage at the
 *              phone's grade — the SwapUp grade's cosmetic rule (G1, marketSell.ts cosmeticGrade) —
 *              else at the next LOWER grade, named; never a higher one (marketSell.ts listingAt)
 *   markdown   the same markdown the store's sell price takes (marketSell.ts sellFromListing):
 *              5% up to ₹15,000, 4% to ₹30,000, 3% to ₹50,000, 2% above
 *   defects    a percentage for each functional failure or defect, from SwapUp's deduction table
 *              (ratecard.ts DEFECT_DEDUCTIONS — GradeIQ copies it), combined exactly as a rate card
 *              combines them (ratecard.ts combineDeductions): each % is of the base and floored to
 *              the rupee, the total is capped, the result is never below the table's minimum, and
 *              it is rounded DOWN to its cash step
 *
 * The grade already prices what the phone LOOKS like — scratches, scuffs, dents, a bent frame —
 * so those are never deducted again. What the grade can't see is a defect, deducted once: a
 * screen with lines, cracked or not working, a cracked back, a phone that won't switch on (priced
 * on that alone) or make calls, and each failed function (touch, battery, charging, cameras,
 * speaker, mic, Wi-Fi/Bluetooth, fingerprint, buttons, vibration, liquid). A defect does not
 * lower the grade as well: a cracked screen on an otherwise flawless phone is Superb less the
 * cracked-screen percentage.
 *
 * Accessories and age are not defects: the market price is already this model's, at its age.
 *
 * Old data: over 14 days old the price stands, with its age on it; over 90 days old there is no
 * price (marketSell.ts marketUsable). No listing, no price — with why, so the server can fall back
 * to the partner's rate card or a typed quote and say so. Never a neighbour's model, never a
 * guessed grade. Pure — no database, no clock.
 */
import { fmtBp, inr, type BasisPoints, type Rupees } from "./money.ts";
import type { ConditionAnswers } from "./condition.ts";
import { combineDeductions, conditionDeductions, DEFECT_DEDUCTIONS, DEFECT_RULES, type DeductionPart, type QuoteLine, type RateCard } from "./ratecard.ts";
// The cosmetic rule G1 from beside the grade's words — never the grading engine (grading.test.ts G49).
import { isDefectState, listingAt, marketUsable, onlyAboveWhy, sellFromListing, tradeInGrade, type MarketAnswer, type MarketGrade } from "./marketSell.ts";

export { tradeInGrade };

/** A deduction table: the percentages and the cap, minimum and cash step they combine under. */
export type DeductionTable = Pick<RateCard, "deductions" | "maxDeductionBp" | "floorBp" | "roundTo">;

/** SwapUp's deduction table — the one every PriceIQ trade-in uses (GradeIQ: "same as SwapUp"). */
export const SWAPUP_DEDUCTIONS: DeductionTable = { deductions: DEFECT_DEDUCTIONS, ...DEFECT_RULES };
export const SWAPUP_DEDUCTIONS_LABEL = "SwapUp's % per defect";

export type PriceiqTradeIn =
  | {
      status: "priced";
      amount: Rupees;
      /** The lowest listing at `grade`. */
      listing: Rupees;
      grade: MarketGrade;
      /** The phone's grade; differs from `grade` when the market listed none at it. */
      gradeWanted: MarketGrade;
      /** The markdown taken off the listing (5%→2%). */
      markdownBp: BasisPoints;
      /** How many defects were taken off. */
      defects: number;
      /** base, markdown, one line per defect (name, bp, −₹), then any cap / minimum / rounding line — they sum to `amount`. */
      lines: QuoteLine[];
      deductionBp: BasisPoints;
      capped: boolean;
      floored: boolean;
      listings: number;
      week: string;
      /** How old the market data was when this was priced. */
      ageDays: number;
      /** Over 14 days old: shown with its age. */
      stale: boolean;
      /** The age and/or "PriceIQ unreachable, last answer …" in one sentence; null when neither applies. */
      note: string | null;
    }
  | { status: "unpriced"; reason: string };

/**
 * What a PriceIQ quote stores beside its lines (PartnerQuote.priceiq), so the answer can say it in
 * one line (tradeInLine) without re-reading the market. `deductions` names the table the
 * percentages came from; null on a repaired value that deducted nothing.
 */
export type PriceiqMeta = {
  grade: MarketGrade;
  gradeWanted: MarketGrade;
  listing: Rupees;
  markdownBp: BasisPoints;
  defects: number;
  deductions: string | null;
  week: string;
  listings: number;
  ageDays?: number;
  stale?: boolean;
  note?: string | null;
};

/** The defects on this phone, as the table's percentage lines — never a look the grade already prices (tradeInGrade: marketSell.ts). */
export function defectDeductions(table: Pick<DeductionTable, "deductions">, condition: ConditionAnswers): DeductionPart[] {
  return conditionDeductions(table.deductions, condition, isDefectState);
}

export const BASE_LABEL = (grade: MarketGrade) => `Refurbished market price (${grade}) · PriceIQ`;
export const MARKDOWN_LABEL = "Below the market price";

export function priceiqTradeIn(input: {
  /** PriceIQ's answer for this model + storage (lib/server/priceiq.ts); null = none yet. */
  answer: MarketAnswer | null;
  condition: ConditionAnswers | null | undefined;
  label: string;
  /** Now, for the age of the market data. */
  asOf: string;
  /** Default: SwapUp's own table. */
  table?: DeductionTable;
  /** Price at this grade instead of the phone's own look (the repaired value: the grade after refurb). */
  grade?: MarketGrade | null;
  /** Why there is no answer at all, when the caller knows (PriceIQ not set up). */
  noAnswerWhy?: string | null;
}): PriceiqTradeIn {
  const { condition } = input;
  const table = input.table ?? SWAPUP_DEDUCTIONS;
  const wanted = input.grade ?? tradeInGrade(condition);
  if (!condition || !wanted) return { status: "unpriced", reason: "The phone's condition isn't on the case yet." };
  if (!input.answer && input.noAnswerWhy) return { status: "unpriced", reason: input.noAnswerWhy };
  const use = marketUsable(input.answer, input.asOf, input.label);
  if (!use.ok) return { status: "unpriced", reason: use.why };
  const at = listingAt(input.answer!.rows, wanted);
  if (!at) return { status: "unpriced", reason: onlyAboveWhy(input.label, wanted) };
  const md = sellFromListing(at.listing);
  const parts = defectDeductions(table, condition);
  const out = combineDeductions({
    ceiling: at.listing,
    start: md.amount,
    lines: [
      { label: BASE_LABEL(at.grade), amount: at.listing },
      { label: MARKDOWN_LABEL, bp: md.markdownBp, amount: md.amount - at.listing },
    ],
    parts,
    rules: table,
  });
  return {
    status: "priced",
    amount: out.amount,
    listing: at.listing,
    grade: at.grade,
    gradeWanted: wanted,
    markdownBp: md.markdownBp,
    defects: parts.length,
    lines: out.lines,
    deductionBp: out.deductionBp,
    capped: out.capped,
    floored: out.floored,
    listings: at.listings,
    week: at.week,
    ageDays: use.ageDays,
    stale: use.stale,
    note: use.note,
  };
}

/**
 * The trade-in in one line, under the answer's figure — the store margin's own words for the same
 * base: "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35", with the
 * data's age when it is over 14 days old (", 52 days old") and " · none at Superb" when the market
 * listed none at the phone's grade and a lower one was used.
 */
export function tradeInLine(p: Pick<PriceiqMeta, "grade" | "gradeWanted" | "listing" | "markdownBp" | "defects" | "ageDays" | "stale"> & { week?: string | null }): string {
  const defects = p.defects ? ` − ${p.defects} defect${p.defects === 1 ? "" : "s"}` : "";
  const age = p.stale && typeof p.ageDays === "number" ? `, ${p.ageDays} days old` : "";
  const lower = p.gradeWanted !== p.grade ? ` · none at ${p.gradeWanted}` : "";
  return `Refurbished market price ${inr(p.listing)} (${p.grade}) − ${fmtBp(p.markdownBp)}${defects} · PriceIQ${p.week ? ` ${p.week}` : ""}${age}${lower}`;
}

/** The source label stored with the quote: "PriceIQ · Good − defects", or "PriceIQ · Good" with none. */
export function priceiqLabel(p: { grade: MarketGrade; defects: number }): string {
  return `PriceIQ · ${p.grade}${p.defects ? " − defects" : ""}`;
}
