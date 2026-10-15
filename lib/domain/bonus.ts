/**
 * THE UPGRADE BONUS — the 2–5% that promotes a new Samsung.
 *
 * A campaign gives a percentage of the NEW device's price (or of the trade-in
 * value, if the programme says so) on top of the buyback value. Rules add
 * basis points for reasons the programme chooses to reward — loyalty, a
 * flagship target, an old phone — and the result is clamped into the band the
 * programme owner set (2–5% by default). Every step is returned so the advisor
 * can say out loud WHY this customer gets 3.5% and the last one got 2%.
 *
 * Who funds it is recorded on the campaign (normally the brand). The bonus is a
 * promotion, never a reason: the decision engine does not see it when it
 * decides whether repair or upgrade is better for the customer.
 */

import { type Rupees, type BasisPoints, pctOf, clamp, fmtBp } from "./money.ts";

export type BonusCondition =
  | { kind: "always" }
  | { kind: "old_brand"; brands: string[] }
  | { kind: "target_series"; series: string[] }
  | { kind: "old_age_years_gte"; years: number }
  | { kind: "repair_ratio_gte"; ratio: number }
  | { kind: "store_kind"; kinds: string[] };

export type BonusRule = { id: string; label: string; bp: BasisPoints; when: BonusCondition };

export type Campaign = {
  id: string;
  name: string;
  basis: "new_price" | "trade_in_value";
  minBp: BasisPoints;
  maxBp: BasisPoints;
  /** Optional rupee ceiling per upgrade. */
  capRupees: Rupees | null;
  fundedBy: string;
  startsOn: string; // YYYY-MM-DD, inclusive
  endsOn: string | null; // inclusive
  rules: BonusRule[];
};

/** The programme-level guardrail: no campaign may be configured outside it. */
export const DEFAULT_BAND: { minBp: BasisPoints; maxBp: BasisPoints } = { minBp: 200, maxBp: 500 };

export type BonusContext = {
  today: string; // YYYY-MM-DD
  oldBrand: string;
  oldAgeYears: number | null;
  targetSeries: string; // e.g. "S", "Z", "A", "M", "F"
  newPrice: Rupees;
  tradeInValue: Rupees;
  repairRatio: number | null;
  storeKind: string;
};

export type BonusStep = { label: string; bp: BasisPoints; applied: boolean; why: string };

export type BonusResult = {
  campaignId: string;
  bp: BasisPoints;
  amount: Rupees;
  basisAmount: Rupees;
  steps: BonusStep[];
  clampedBy: "min" | "max" | "cap" | null;
  fundedBy: string;
};

export function validateCampaign(c: Campaign, band = DEFAULT_BAND): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(c.minBp) || !Number.isInteger(c.maxBp)) errs.push("Percentages must be whole basis points.");
  if (c.minBp < band.minBp) errs.push(`Minimum ${fmtBp(c.minBp)} is below the programme floor of ${fmtBp(band.minBp)}.`);
  if (c.maxBp > band.maxBp) errs.push(`Maximum ${fmtBp(c.maxBp)} is above the programme ceiling of ${fmtBp(band.maxBp)}.`);
  if (c.minBp > c.maxBp) errs.push("Minimum is above maximum.");
  if (c.capRupees !== null && (!Number.isInteger(c.capRupees) || c.capRupees <= 0)) errs.push("Rupee cap must be a positive whole number.");
  if (c.endsOn && c.endsOn < c.startsOn) errs.push("Campaign ends before it starts.");
  for (const r of c.rules) {
    if (!Number.isInteger(r.bp) || r.bp < 0 || r.bp > 1000) errs.push(`Rule "${r.label}" must add 0–10% in whole basis points.`);
  }
  return errs;
}

export function campaignActive(c: Campaign, today: string): boolean {
  return c.startsOn <= today && (c.endsOn === null || today <= c.endsOn);
}

function matches(cond: BonusCondition, ctx: BonusContext): { ok: boolean; why: string } {
  switch (cond.kind) {
    case "always":
      return { ok: true, why: "base rate" };
    case "old_brand": {
      const ok = cond.brands.some((b) => b.toLowerCase() === ctx.oldBrand.toLowerCase());
      return { ok, why: ok ? `trading in a ${ctx.oldBrand}` : `trading in a ${ctx.oldBrand}, not ${cond.brands.join("/")}` };
    }
    case "target_series": {
      const ok = cond.series.map((s) => s.toUpperCase()).includes(ctx.targetSeries.toUpperCase());
      return { ok, why: ok ? `upgrading to the ${ctx.targetSeries} series` : `${ctx.targetSeries} series is not in ${cond.series.join("/")}` };
    }
    case "old_age_years_gte": {
      if (ctx.oldAgeYears === null) return { ok: false, why: "age of the old phone unknown" };
      const ok = ctx.oldAgeYears >= cond.years;
      return { ok, why: `old phone is ${ctx.oldAgeYears} yr${ctx.oldAgeYears === 1 ? "" : "s"} old` };
    }
    case "repair_ratio_gte": {
      if (ctx.repairRatio === null) return { ok: false, why: "no repair quote to compare" };
      const ok = ctx.repairRatio >= cond.ratio;
      return { ok, why: `repair is ${Math.round(ctx.repairRatio * 100)}% of the repaired value` };
    }
    case "store_kind": {
      const ok = cond.kinds.includes(ctx.storeKind);
      return { ok, why: ok ? `offered at this ${ctx.storeKind.replace(/_/g, " ")}` : "not offered at this store type" };
    }
  }
}

export function computeBonus(c: Campaign, ctx: BonusContext): BonusResult {
  const steps: BonusStep[] = [];
  let raw = 0;
  for (const r of c.rules) {
    const m = matches(r.when, ctx);
    steps.push({ label: r.label, bp: r.bp, applied: m.ok, why: m.why });
    if (m.ok) raw += r.bp;
  }
  let clampedBy: BonusResult["clampedBy"] = null;
  let bp = clamp(raw, c.minBp, c.maxBp);
  if (raw < c.minBp) clampedBy = "min";
  if (raw > c.maxBp) clampedBy = "max";
  const basisAmount = c.basis === "new_price" ? ctx.newPrice : ctx.tradeInValue;
  let amount = pctOf(basisAmount, bp);
  if (c.capRupees !== null && amount > c.capRupees) {
    amount = c.capRupees;
    clampedBy = "cap";
  }
  return { campaignId: c.id, bp, amount, basisAmount, steps, clampedBy, fundedBy: c.fundedBy };
}

/** Best active campaign for a context — the customer gets the most generous one running. */
export function bestCampaign(cs: Campaign[], ctx: BonusContext): { campaign: Campaign; result: BonusResult } | null {
  let best: { campaign: Campaign; result: BonusResult } | null = null;
  for (const c of cs) {
    if (!campaignActive(c, ctx.today)) continue;
    const r = computeBonus(c, ctx);
    if (!best || r.amount > best.result.amount) best = { campaign: c, result: r };
  }
  return best;
}
