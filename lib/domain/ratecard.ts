/**
 * TRADE-IN PRICE FROM A PARTNER RATE CARD.
 *
 * A buyback partner (Cashify, for this programme) prices a device as a model +
 * variant ceiling, then deducts for condition. When the partner's live quote
 * API is connected, its number wins and this file is not consulted. When it is
 * not, the store works from the partner's RATE CARD — the price sheet partners
 * send their retail channel — and this is the arithmetic that reads it.
 *
 * Two rules this file exists to keep:
 *
 *   1. NO ENTRY, NO PRICE. A model the card does not list returns `unpriced`.
 *      It never borrows a neighbour's price: "Galaxy S23" is not a fair stand-in
 *      for "Galaxy S23 FE", and the store's credit pays for the difference.
 *   2. THE SOURCE TRAVELS WITH THE NUMBER. Every quote carries the card it came
 *      from. A SAMPLE card produces quotes the UI must label as sample, always.
 */

import { type Rupees, type BasisPoints, pctOf, roundDown, clamp } from "./money.ts";
import type { ConditionAnswers, ScreenState, BodyState, IssueId, AgeBand } from "./condition.ts";
import { SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL } from "./condition.ts";

export type PriceSourceKind = "partner_live" | "partner_manual" | "partner_ratecard" | "sample";

export type RateCard = {
  id: string;
  partner: string;
  source: { kind: "partner_ratecard" | "sample"; label: string; effectiveFrom: string; note?: string };
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
      reason: `The ${card.partner} rate card has no price for this model and storage — ask the partner for a quote rather than using a similar model.`,
    };
  }
  const ceiling = entry.maxPrice;
  const lines: QuoteLine[] = [{ label: "Best-condition price on the rate card", amount: ceiling }];
  const d = card.deductions;
  const parts: { label: string; bp: BasisPoints }[] = [];

  if (!a.powersOn) {
    parts.push({ label: "Does not switch on (priced as non-working)", bp: d.deadBp });
  } else {
    if (!a.calls) parts.push({ label: "Calls / network not working", bp: d.callsBp });
    if (d.screen[a.screen]) parts.push({ label: `Screen: ${SCREEN_LABEL[a.screen]}`, bp: d.screen[a.screen] });
    if (d.body[a.body]) parts.push({ label: `Body: ${BODY_LABEL[a.body]}`, bp: d.body[a.body] });
    for (const i of a.issues) if (d.issues[i]) parts.push({ label: ISSUE_LABEL[i], bp: d.issues[i] });
  }
  if (!a.accessories.charger && d.noChargerBp) parts.push({ label: "No original charger", bp: d.noChargerBp });
  if (!a.accessories.box && d.noBoxBp) parts.push({ label: "No original box", bp: d.noBoxBp });
  if (!a.accessories.bill && d.noBillBp) parts.push({ label: "No purchase bill", bp: d.noBillBp });
  if (d.age[a.age]) parts.push({ label: `Age: ${AGE_LABEL[a.age]}`, bp: d.age[a.age] });

  // Each line is floored on its own and the total is the SUM OF THE LINES, so the
  // trace always adds up to the quote (flooring the summed bp instead can differ
  // by a rupee per line).
  const rawBp = parts.reduce((s, p) => s + p.bp, 0);
  const deductionBp = clamp(rawBp, 0, card.maxDeductionBp);
  let deduction = 0;
  for (const p of parts) {
    const amt = pctOf(ceiling, p.bp);
    deduction += amt;
    lines.push({ label: p.label, bp: p.bp, amount: -amt });
  }
  let capped = false;
  const capAmount = pctOf(ceiling, card.maxDeductionBp);
  if (deduction > capAmount) {
    // Give back what the cap forgives, as its own visible line — never silently.
    lines.push({ label: "Deductions capped", amount: deduction - capAmount });
    deduction = capAmount;
    capped = true;
  }

  let amount = ceiling - deduction;
  const floor = pctOf(ceiling, card.floorBp);
  let floored = false;
  if (amount < floor) {
    lines.push({ label: "Raised to the card's minimum for this model", amount: floor - amount });
    amount = floor;
    floored = true;
  }
  const rounded = roundDown(amount, card.roundTo);
  if (rounded !== amount) lines.push({ label: `Rounded down to ₹${card.roundTo}`, amount: rounded - amount });

  return { status: "priced", ceiling, amount: rounded, lines, deductionBp, capped, floored };
}

/** Lines must always sum to the amount — a trace that does not add up is not a trace. */
export function linesSum(lines: QuoteLine[]): Rupees {
  return lines.reduce((s, l) => s + l.amount, 0);
}
