/**
 * TRADE-IN PRICE FROM A PARTNER RATE CARD.
 *
 * A buyback partner (the programme's own, from its org) prices a device as a model +
 * variant ceiling, then deducts for condition. When PriceIQ has no refurbished market
 * price for the phone, the store works from the partner's RATE CARD — the price sheet
 * partners send their retail channel, uploaded on /partner/rate-cards — and this is the
 * arithmetic that reads it. The same arithmetic combines SwapUp's own % per defect under
 * a PriceIQ trade-in (lib/domain/priceiqTradeIn.ts).
 *
 * Two rules this file exists to keep:
 *
 *   1. NO ENTRY, NO PRICE. A model the card does not list returns `unpriced`.
 *      It never borrows a neighbour's price: "Galaxy S23" is not a fair stand-in
 *      for "Galaxy S23 FE", and the store's credit pays for the difference.
 *   2. THE SOURCE TRAVELS WITH THE NUMBER. Every quote carries the card it came from.
 */

import { type Rupees, type BasisPoints, pctOf, roundDown, clamp } from "./money.ts";
import type { ConditionAnswers, ScreenState, BodyState, IssueId, AgeBand } from "./condition.ts";
import { SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL, SCREEN_WORD, BODY_WORD, lowerFirst } from "./condition.ts";
// The look the card's grade columns price — rule G1 beside the grade's words, never the grading engine (G49).
import { MARKET_GRADES, MARKET_GRADE_LETTER, isDefectState, tradeInGrade, type MarketGrade } from "./marketSell.ts";

/**
 * Where a trade-in price came from, best first (lib/server/tradeIn.ts asks in this order):
 * PriceIQ's refurbished-market price less the markdown and defects (lib/domain/priceiqTradeIn.ts),
 * the partner's uploaded rate card. `none` = nothing priced it ("No market price yet", with why).
 * Never a made-up price, never a typed one. `partner_manual` is a quote an older build let staff
 * type in: kept as a kind so its history still reads, never written again (an open case re-asks it).
 */
export type PriceSourceKind = "partner_manual" | "priceiq" | "partner_ratecard" | "none";
export const PRICE_SOURCE_KINDS: readonly PriceSourceKind[] = ["partner_manual", "priceiq", "partner_ratecard", "none"];
/** A quote stored by an older SwapUp, from a source that no longer exists: it is re-asked, never used again. */
export function retiredSource(kind: string | null | undefined): boolean {
  return !!kind && !(PRICE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** What a quote from a retired source is called on every screen, receipt and trace — never its stored label. */
export const RETIRED_QUOTE_LABEL = "Retired test quote";
/** The kind a retired quote is re-stored under (seed.ts retireOldQuotes): neutral, and still never a PRICE_SOURCE_KIND. */
export const RETIRED_SOURCE_KIND = "retired";

/**
 * The words a quote's source is shown with. A retired source's stored label was written by an older
 * build (it may describe prices SwapUp no longer has), so it is never shown: RETIRED_QUOTE_LABEL is.
 */
export function quoteSourceLabel(source: { kind?: string | null; label?: string | null } | null | undefined): string {
  if (!source) return "";
  return retiredSource(source.kind) ? RETIRED_QUOTE_LABEL : (source.label ?? "");
}

export type RateCard = {
  id: string;
  partner: string;
  source: { kind: "partner_ratecard"; label: string; effectiveFrom: string; note?: string };
  quoteValidityDays: number;
  roundTo: Rupees;
  /** Combined percentage deductions never exceed this (the rest is the floor's job). */
  maxDeductionBp: BasisPoints;
  /** The least the card pays for a device that is priced at all, as bp of its ceiling. */
  floorBp: BasisPoints;
  deductions: {
    /** A phone that will not switch on is priced on this alone — nothing else can be assessed. */
    deadBp: BasisPoints;
    callsBp: BasisPoints;
    screen: Record<ScreenState, BasisPoints>;
    body: Record<BodyState, BasisPoints>;
    issues: Record<IssueId, BasisPoints>;
    noChargerBp: BasisPoints;
    noBoxBp: BasisPoints;
    noBillBp: BasisPoints;
    age: Record<AgeBand, BasisPoints>;
  };
  entries: RateEntry[];
};

/**
 * One row of the card. `maxPrice` is the best-condition price — grade A (Superb). A card may also
 * price grades B–D directly (owner, 2026-10-19: the buyback partner's own grade ladder): then the
 * phone is priced at its look's grade and only the defects are taken off (priceFromCard).
 */
export type RateEntry = { modelId: string; variant: string; maxPrice: Rupees; gradePrices?: GradePrices };
/** The optional grade columns: good_price (B), fair_price (C), best_value_price (D). */
export type GradePrices = Partial<Record<Exclude<MarketGrade, "Superb">, Rupees>>;

/** The upload's columns, in order (lib/server/catalog.ts uploadRateCard). The last three are optional. */
export const RATE_CARD_COLUMNS = ["model_id", "variant", "max_price", "good_price", "fair_price", "best_value_price"] as const;
/** Which grade each price column is. */
export const COLUMN_GRADE: readonly MarketGrade[] = ["Superb", "Good", "Fair", "Best Value"];

/** A row's price at each grade it lists, best first: max is Superb; a blank column is absent. */
export function entryGradePrices(e: RateEntry): { grade: MarketGrade; price: Rupees }[] {
  const out: { grade: MarketGrade; price: Rupees }[] = [{ grade: "Superb", price: e.maxPrice }];
  for (const g of COLUMN_GRADE.slice(1) as Exclude<MarketGrade, "Superb">[]) {
    const p = e.gradePrices?.[g];
    if (p !== undefined) out.push({ grade: g, price: p });
  }
  return out;
}

/**
 * A row's prices must never rise as the grade falls: max ≥ good ≥ fair ≥ best value, over the
 * columns present, each a whole rupee ≥ 1. null = fine; else the reason (the upload names the row).
 */
export function gradePricesProblem(e: RateEntry): string | null {
  const ps = entryGradePrices(e);
  for (const p of ps) if (!Number.isInteger(p.price) || p.price < 1) return `the ${p.grade} price must be a whole rupee amount`;
  for (let i = 1; i < ps.length; i++)
    if (ps[i].price > ps[i - 1].price) return `the ${ps[i].grade} price (${ps[i].price}) is above the ${ps[i - 1].grade} price (${ps[i - 1].price}) — a lower grade can't pay more`;
  return null;
}

/** The price at `wanted`, else at the next LOWER grade the row lists — never a higher one. null = none at or below (other than max). */
function priceAtGrade(e: RateEntry, wanted: MarketGrade): { grade: MarketGrade; price: Rupees } | null {
  if (!e.gradePrices || !Object.keys(e.gradePrices).length) return null;
  const listed = entryGradePrices(e);
  for (const g of MARKET_GRADES.slice(MARKET_GRADES.indexOf(wanted))) {
    const hit = listed.find((x) => x.grade === g);
    if (hit) return hit;
  }
  return null;
}

/**
 * SwapUp's % per defect (owner, 2026-10-18: "deductions per defect = SwapUp's % table
 * everywhere"). Every PriceIQ trade-in takes its defect percentages from here
 * (lib/domain/priceiqTradeIn.ts SWAPUP_DEDUCTIONS), and GradeIQ copies this table for its India
 * clients, labelled "same as SwapUp". A partner starting a rate card may start from it too.
 * Accessories and age are here for a rate card's own use; the PriceIQ trade-in never deducts them.
 */
export const DEFECT_DEDUCTIONS: RateCard["deductions"] = {
  deadBp: 7500,
  callsBp: 2000,
  screen: { flawless: 0, scratched: 600, lines_or_spots: 3500, cracked: 4000, not_working: 6500 },
  body: { flawless: 0, scuffed: 300, dented: 1200, back_cracked: 1500, bent: 3500 },
  issues: {
    touch: 3000,
    battery: 900,
    charging: 1200,
    rear_camera: 1800,
    front_camera: 1000,
    speaker: 700,
    mic: 700,
    wifi_bt: 1500,
    fingerprint: 800,
    buttons: 600,
    vibration: 300,
    liquid: 4500,
  },
  noChargerBp: 300,
  noBoxBp: 200,
  noBillBp: 300,
  age: { lt3m: 0, "3to11m": 400, gt11m: 800 },
};
/** SwapUp's cap on the deductions together, its minimum (as bp of the base) and its cash step. */
export const DEFECT_RULES: Pick<RateCard, "maxDeductionBp" | "floorBp" | "roundTo"> = { maxDeductionBp: 8500, floorBp: 600, roundTo: 10 };

/**
 * One line of a quote's trace. `word`: on a deduction only — what the customer reads it as
 * ("back glass cracked", "no charger"), so the answer can say what the price took off.
 */
export type QuoteLine = { label: string; bp?: BasisPoints; amount: Rupees; word?: string };

export type RateQuote =
  | {
      status: "priced";
      ceiling: Rupees;
      amount: Rupees;
      lines: QuoteLine[];
      deductionBp: BasisPoints;
      capped: boolean;
      floored: boolean;
      /** A row with grade prices: the grade the price is FOR (the phone's look, or the next lower listed). Absent otherwise. */
      grade?: MarketGrade;
    }
  | { status: "unpriced"; reason: string };

/** The card is active, but the phone (model + storage) is not on it. */
export const NOT_ON_CARD = "This phone isn't on the rate card yet.";
/** Nothing priced the phone and no rate card is active (PriceIQ off, or it gave no reason) — lib/server/tradeIn.ts. */
export const NO_RATE_CARD = "No rate card is active yet.";
/**
 * No price, and nothing at the counter will give one: the active card doesn't list the phone, or no
 * card is active (SUP-32). PriceIQ's own reasons are not final — it may answer on the next ask.
 */
export const finalNoPrice = (reason: string | null | undefined): boolean => reason === NOT_ON_CARD || reason === NO_RATE_CARD;

export function findEntry(card: RateCard, modelId: string, variant: string): RateEntry | null {
  return card.entries.find((e) => e.modelId === modelId && e.variant === variant) ?? null;
}

export function priceFromCard(card: RateCard, modelId: string, variant: string, a: ConditionAnswers): RateQuote {
  const entry = findEntry(card, modelId, variant);
  if (!entry) return { status: "unpriced", reason: NOT_ON_CARD };
  const d = card.deductions;
  // A row with grade prices: the price at the phone's look (or the next lower grade it lists), and
  // the looks are NOT taken off again — the grade priced them. Every other deduction applies once.
  const look = tradeInGrade(a);
  const at = look ? priceAtGrade(entry, look) : null;
  const ceiling = at ? at.price : entry.maxPrice;
  const parts = at ? conditionDeductions(d, a, isDefectState) : conditionDeductions(d, a);
  if (!a.accessories.charger && d.noChargerBp) parts.push({ label: "No original charger", bp: d.noChargerBp, word: "no charger" });
  if (!a.accessories.box && d.noBoxBp) parts.push({ label: "No original box", bp: d.noBoxBp, word: "no box" });
  if (!a.accessories.bill && d.noBillBp) parts.push({ label: "No purchase bill", bp: d.noBillBp, word: "no bill" });
  if (d.age[a.age]) parts.push({ label: `Age: ${AGE_LABEL[a.age]}`, bp: d.age[a.age], word: `age ${AGE_LABEL[a.age].toLowerCase()}` });
  const base: QuoteLine = at
    ? { label: `Market price grade ${MARKET_GRADE_LETTER[at.grade]} · ${card.source.label}`, amount: ceiling }
    : { label: "Best-condition price on the rate card", amount: ceiling };
  // A grade's own price is what the partner pays, used exactly (W42: grade B ₹33,574, not ₹33,570);
  // the card's cash step rounds only a price the card worked out — one with something taken off.
  const rules = !parts.length ? { ...card, roundTo: 1 } : card;
  const out = combineDeductions({ ceiling, start: ceiling, lines: [base], parts, rules });
  return { status: "priced", ceiling, ...out, ...(at ? { grade: at.grade } : {}) };
}

/** One percentage the card takes off, with the words the trace shows and the few the customer reads. */
export type DeductionPart = { label: string; bp: BasisPoints; word: string };

/**
 * What is wrong with the phone, as the card's percentage lines — switches on, calls, screen,
 * body and each functional issue. A phone that does not switch on is priced on that alone:
 * nothing else can be assessed. Accessories and age are not here (they are not defects).
 *
 * `deduct` narrows which screen and body states are taken off: the PriceIQ trade-in leaves
 * scratches, scuffs, dents and a bent frame to the grade, which already prices them
 * (lib/domain/priceiqTradeIn.ts). Default: every state the card prices.
 */
export function conditionDeductions(
  d: RateCard["deductions"],
  a: ConditionAnswers,
  deduct: { screen: (s: ScreenState) => boolean; body: (b: BodyState) => boolean } = { screen: () => true, body: () => true }
): DeductionPart[] {
  const parts: DeductionPart[] = [];
  if (!a.powersOn) {
    parts.push({ label: "Does not switch on (priced as non-working)", bp: d.deadBp, word: "not switching on" });
    return parts;
  }
  if (!a.calls) parts.push({ label: "Calls / network not working", bp: d.callsBp, word: "calls not working" });
  if (d.screen[a.screen] && deduct.screen(a.screen)) parts.push({ label: `Screen: ${SCREEN_LABEL[a.screen]}`, bp: d.screen[a.screen], word: SCREEN_WORD[a.screen] });
  if (d.body[a.body] && deduct.body(a.body)) parts.push({ label: `Body: ${BODY_LABEL[a.body]}`, bp: d.body[a.body], word: BODY_WORD[a.body] });
  for (const i of a.issues) if (d.issues[i]) parts.push({ label: ISSUE_LABEL[i], bp: d.issues[i], word: lowerFirst(ISSUE_LABEL[i]) });
  return parts;
}

/**
 * The rate card's arithmetic, shared with the PriceIQ trade-in. Every percentage is of
 * `ceiling`; `start` is where the deductions are taken from (the ceiling itself for a card,
 * the market price less its markdown for PriceIQ) and `lines` the trace so far.
 *
 * Each line is floored on its own and the total is the SUM OF THE LINES, so the trace always
 * adds up to the quote (flooring the summed bp instead can differ by a rupee per line). The
 * deductions together never take off more than `maxDeductionBp` of the ceiling — what the cap
 * forgives is its own line; the result is never below `floorBp` of the ceiling; and it is
 * rounded DOWN to `roundTo`.
 */
export function combineDeductions(input: {
  ceiling: Rupees;
  start: Rupees;
  lines: QuoteLine[];
  parts: DeductionPart[];
  rules: Pick<RateCard, "maxDeductionBp" | "floorBp" | "roundTo">;
}): { amount: Rupees; lines: QuoteLine[]; deductionBp: BasisPoints; capped: boolean; floored: boolean } {
  const { ceiling, parts, rules } = input;
  const lines = [...input.lines];
  const rawBp = parts.reduce((s, p) => s + p.bp, 0);
  const deductionBp = clamp(rawBp, 0, rules.maxDeductionBp);
  let deduction = 0;
  for (const p of parts) {
    const amt = pctOf(ceiling, p.bp);
    deduction += amt;
    lines.push({ label: p.label, bp: p.bp, amount: -amt, word: p.word });
  }
  let capped = false;
  const capAmount = pctOf(ceiling, rules.maxDeductionBp);
  if (deduction > capAmount) {
    // Give back what the cap forgives, as its own visible line — never silently.
    lines.push({ label: "Deductions capped", amount: deduction - capAmount });
    deduction = capAmount;
    capped = true;
  }

  let amount = input.start - deduction;
  const floor = pctOf(ceiling, rules.floorBp);
  let floored = false;
  if (amount < floor) {
    lines.push({ label: "Raised to the card's minimum for this model", amount: floor - amount });
    amount = floor;
    floored = true;
  }
  const rounded = roundDown(amount, rules.roundTo);
  if (rounded !== amount) lines.push({ label: `Rounded down to ₹${rules.roundTo}`, amount: rounded - amount });
  return { amount: rounded, lines, deductionBp, capped, floored };
}

/** Lines must always sum to the amount — a trace that does not add up is not a trace. */
export function linesSum(lines: QuoteLine[]): Rupees {
  return lines.reduce((s, l) => s + l.amount, 0);
}
