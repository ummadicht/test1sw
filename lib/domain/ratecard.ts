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
import { SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL } from "./condition.ts";

/**
 * Where a trade-in price came from, best first (lib/server/tradeIn.ts asks in this order): a
 * quote staff typed in from the partner's app, PriceIQ's refurbished-market price less the
 * markdown and defects (lib/domain/priceiqTradeIn.ts), the partner's uploaded rate card.
 * `none` = nothing priced it ("No market price yet — enter a quote"). Never a made-up price.
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

export type RateEntry = { modelId: string; variant: string; maxPrice: Rupees };

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

export type QuoteLine = { label: string; bp?: BasisPoints; amount: Rupees };

export type RateQuote =
  | {
      status: "priced";
      ceiling: Rupees;
      amount: Rupees;
      lines: QuoteLine[];
      deductionBp: BasisPoints;
      capped: boolean;
      floored: boolean;
    }
  | { status: "unpriced"; reason: string };

export function findEntry(card: RateCard, modelId: string, variant: string): RateEntry | null {
  return card.entries.find((e) => e.modelId === modelId && e.variant === variant) ?? null;
}

export function priceFromCard(card: RateCard, modelId: string, variant: string, a: ConditionAnswers): RateQuote {
  const entry = findEntry(card, modelId, variant);
  if (!entry) {
    return {
      status: "unpriced",
      reason: "No rate-card price for this model and storage — ask the partner.",
    };
  }
  const ceiling = entry.maxPrice;
  const d = card.deductions;
  const parts = conditionDeductions(d, a);
  if (!a.accessories.charger && d.noChargerBp) parts.push({ label: "No original charger", bp: d.noChargerBp });
  if (!a.accessories.box && d.noBoxBp) parts.push({ label: "No original box", bp: d.noBoxBp });
  if (!a.accessories.bill && d.noBillBp) parts.push({ label: "No purchase bill", bp: d.noBillBp });
  if (d.age[a.age]) parts.push({ label: `Age: ${AGE_LABEL[a.age]}`, bp: d.age[a.age] });
  const out = combineDeductions({ ceiling, start: ceiling, lines: [{ label: "Best-condition price on the rate card", amount: ceiling }], parts, rules: card });
  return { status: "priced", ceiling, ...out };
}

/** One percentage the card takes off, with the words the trace shows. */
export type DeductionPart = { label: string; bp: BasisPoints };

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
    parts.push({ label: "Does not switch on (priced as non-working)", bp: d.deadBp });
    return parts;
  }
  if (!a.calls) parts.push({ label: "Calls / network not working", bp: d.callsBp });
  if (d.screen[a.screen] && deduct.screen(a.screen)) parts.push({ label: `Screen: ${SCREEN_LABEL[a.screen]}`, bp: d.screen[a.screen] });
  if (d.body[a.body] && deduct.body(a.body)) parts.push({ label: `Body: ${BODY_LABEL[a.body]}`, bp: d.body[a.body] });
  for (const i of a.issues) if (d.issues[i]) parts.push({ label: ISSUE_LABEL[i], bp: d.issues[i] });
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
    lines.push({ label: p.label, bp: p.bp, amount: -amt });
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
