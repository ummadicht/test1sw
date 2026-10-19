/**
 * REPAIR OR UPGRADE — the decision a service centre's customer actually faces.
 *
 * The customer came in to FIX a phone. The useful moment is when the repair
 * quote lands and it turns out the phone, repaired, is worth barely more than
 * the repair costs — and nobody has the numbers side by side to see it.
 *
 * THE INTEGRITY RULE (carried from CounterIQ's repair-or-buyback, and the reason
 * this file is shaped the way it is). This runs at a counter where the centre
 * earns on the upgrade. A tool that nudged toward upgrading whenever upgrading
 * pays the centre would be a sales trick wearing a calculator, and it would be
 * found out the first time a customer did the maths. So:
 *
 *   • the money question — is the phone worth more to the customer KEPT
 *     (repaired) or LET GO (traded as it is)? — is answered on its own, in
 *     rupees, as `favoursCustomer`, even when the answer earns the centre nothing;
 *   • the upgrade BONUS is shown but is never a signal — a promotion is not a
 *     reason to give up a phone that is worth repairing;
 *   • "let go" is what the customer is PAID for the phone as it is: the market
 *     price plus the SwapUp premium (lib/domain/premium.ts, at most 5% of the
 *     market price). The premium comes only with a new phone, like the bonus —
 *     but it is SwapUp's price for THIS phone, so it is in the money question,
 *     and a caveat says it is conditional;
 *   • a repair that is free under cover is always recommended;
 *   • with no repair quote, or no partner value for the phone, it declines
 *     (`cannot_say`) rather than compare against a guess.
 */

import { type Rupees } from "./money.ts";
import type { PriceSourceKind } from "./ratecard.ts";

/** Bumped whenever a rule or default changes; stored with every decision for audit. */

/** The one caveat that is never behind a toggle: the answer shows it under its headline (Offer.safety). */
export const SWOLLEN_BATTERY_CAVEAT = "Swollen battery is a safety risk — stop using and charging it.";
export const RULESET_VERSION = "2026-10-18.1";

export type Thresholds = {
  /**
   * Repair cost as a share of the NEW phone's price at which replacing is worth
   * considering — Consumer Reports' general "50% rule". A heuristic, not a fact.
   */
  upgradeRatio: number;
  /** At or below this share of the new phone's price, repair is normally the better value (consumers' own ~15–20% expectation). */
  repairRatio: number;
  /** A rupee gap smaller than this is noise, not a reason. */
  materialGap: Rupees;
  /** Updates ending within this many years is worth mentioning. */
  supportSoonYears: number;
  /** A phone this old (years) is worth mentioning. */
  oldAgeYears: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  upgradeRatio: 0.5,
  repairRatio: 0.2,
  materialGap: 500,
  supportSoonYears: 1,
  oldAgeYears: 5,
};

export type DecisionInput = {
  /** What the customer pays to repair (0 when covered). null = no quote yet. */
  repairPays: Rupees | null;
  repairCovered: boolean;
  /** Partner value of the phone once repaired. */
  repairedValue: Rupees | null;
  /**
   * What the customer is paid for the phone as it is — the market price plus the SwapUp premium
   * (lib/domain/premium.ts). Never the bonus.
   */
  asIsValue: Rupees | null;
  /** The SwapUp premium inside asIsValue — for its caveat only (it comes with a new phone). Default 0. */
  premium?: Rupees;
  valueSource: PriceSourceKind | null;
  upgrade: { label: string; newPrice: Rupees; bonus: Rupees; supportEndYear: number | null } | null;
  old: { ageYears: number | null; supportEndYear: number | null };
  thisYear: number;
  /** No faults recorded: there is no repair to weigh — it is a straight trade-in. */
  nothingToRepair?: boolean;
  /** How many separate faults, and whether any is systemic (liquid, board, network, no power). */
  faultCount?: number;
  systemicFault?: boolean;
  /** A swollen battery is a safety issue — said plainly, never used as a sales hook. */
  swollenBattery?: boolean;
  thresholds?: Partial<Thresholds>;
};

export type Signal = {
  code: string;
  points: "repair" | "upgrade";
  strength: "strong" | "soft";
  text: string;
};

export type Recommendation = "repair" | "upgrade" | "either" | "no_repair" | "cannot_say";

export type Decision = {
  version: string;
  recommendation: Recommendation;
  headline: string;
  /** Money only: is the phone worth more KEPT (repaired) or LET GO (as-is)? */
  favoursCustomer: "keep" | "let_go" | "level" | null;
  repair: { pays: Rupees; keepsValue: Rupees; net: Rupees; covered: boolean } | null;
  upgrade: {
    label: string;
    newPrice: Rupees;
    tradeIn: Rupees;
    bonus: Rupees;
    pays: Rupees;
    /** How much more the upgrade costs today than the repair. Can be negative. */
    extraVsRepair: Rupees | null;
  } | null;
  metrics: {
    /** Repair as a share of the repaired phone's resale value. */
    repairRatio: number | null;
    /** Repair as a share of the new phone's price (the 50% rule). */
    repairVsNewRatio: number | null;
    valueAddedByRepair: Rupees | null;
    yearsLeftOld: number | null;
    yearsLeftNew: number | null;
    costPerYearRepair: Rupees | null;
    costPerYearUpgrade: Rupees | null;
  };
  signals: Signal[];
  missing: string[];
  caveats: string[];
};

const pct = (r: number) => `${Math.round(r * 100)}%`;
const r = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function decide(input: DecisionInput): Decision {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const signals: Signal[] = [];
  const caveats: string[] = [];
  const missing: string[] = [];

  const yearsLeftOld = input.old.supportEndYear !== null ? input.old.supportEndYear - input.thisYear : null;
  const yearsLeftNew = input.upgrade?.supportEndYear != null ? input.upgrade.supportEndYear - input.thisYear : null;

  if (input.upgrade && input.upgrade.bonus > 0) {
    caveats.push("The bonus is a promotion, never a reason to upgrade.");
  }
  if ((input.premium ?? 0) > 0 && input.asIsValue !== null) {
    caveats.push(`The trade-in includes a ${r(input.premium!)} SwapUp premium, paid only with a new phone.`);
  }

  const upgradeBlock = (repairPays: Rupees | null): Decision["upgrade"] => {
    if (!input.upgrade || input.asIsValue === null) return null;
    const pays = Math.max(0, input.upgrade.newPrice - input.asIsValue - input.upgrade.bonus);
    return {
      label: input.upgrade.label,
      newPrice: input.upgrade.newPrice,
      tradeIn: input.asIsValue,
      bonus: input.upgrade.bonus,
      pays,
      extraVsRepair: repairPays === null ? null : pays - repairPays,
    };
  };

  // 1. Free repair: always the answer. Nothing else needs to be known.
  if (input.repairPays === 0 && input.repairCovered) {
    const up = upgradeBlock(0);
    signals.push({ code: "covered", points: "repair", strength: "strong", text: "Covered — the customer pays nothing." });
    return {
      version: RULESET_VERSION,
      recommendation: "repair",
      headline: "Repair it — it's covered",
      favoursCustomer: "keep",
      repair: input.repairedValue !== null ? { pays: 0, keepsValue: input.repairedValue, net: input.repairedValue, covered: true } : null,
      upgrade: up,
      metrics: {
        repairRatio: 0,
        repairVsNewRatio: 0,
        valueAddedByRepair: input.repairedValue !== null && input.asIsValue !== null ? input.repairedValue - input.asIsValue : null,
        yearsLeftOld,
        yearsLeftNew,
        costPerYearRepair: 0,
        costPerYearUpgrade: up && yearsLeftNew && yearsLeftNew > 0 ? Math.round(up.pays / yearsLeftNew) : null,
      },
      signals,
      missing,
      caveats,
    };
  }

  if (input.nothingToRepair) {
    return {
      version: RULESET_VERSION,
      recommendation: "no_repair",
      headline: "Nothing to repair — a straight trade-in",
      favoursCustomer: null,
      repair: null,
      upgrade: upgradeBlock(null),
      metrics: { repairRatio: null, repairVsNewRatio: null, valueAddedByRepair: null, yearsLeftOld, yearsLeftNew, costPerYearRepair: null, costPerYearUpgrade: upgradeBlock(null) && yearsLeftNew && yearsLeftNew > 0 ? Math.round(upgradeBlock(null)!.pays / yearsLeftNew) : null },
      signals: yearsLeftOld !== null && yearsLeftOld < 0 && input.old.supportEndYear !== null
        ? [{ code: "support_ended", points: "upgrade", strength: "soft", text: `Security updates ended in ${input.old.supportEndYear}.` }]
        : [],
      missing: input.asIsValue === null ? ["No trade-in price yet."] : [],
      caveats,
    };
  }

  if (input.repairPays === null) missing.push("No repair quote yet.");
  if (input.repairedValue === null) missing.push("No repaired value yet.");
  if (input.asIsValue === null) missing.push("No trade-in price yet.");

  if (missing.length || input.repairPays === null || input.repairedValue === null || input.asIsValue === null) {
    return {
      version: RULESET_VERSION,
      recommendation: "cannot_say",
      headline: "Not enough to compare yet",
      favoursCustomer: null,
      repair: null,
      upgrade: upgradeBlock(input.repairPays),
      metrics: { repairRatio: null, repairVsNewRatio: null, valueAddedByRepair: null, yearsLeftOld, yearsLeftNew, costPerYearRepair: null, costPerYearUpgrade: null },
      signals,
      missing,
      caveats,
    };
  }

  const R = input.repairPays;
  const V = input.repairedValue;
  const T = input.asIsValue;
  const net = V - R;
  const added = V - T;
  const ratio = V > 0 ? R / V : Number.POSITIVE_INFINITY;

  // 2. Money signals (each a heuristic; the thresholds are configurable and labelled).
  //    • Repair against the NEW phone's price — Consumer Reports' general 50% rule,
  //      and consumers' own ~15–20% "clearly worth it" line. Only when the
  //      customer is actually looking at a new phone, so N is a real number.
  //    • Repair against what the phone will be WORTH repaired: past 100% the
  //      repair does not pay financially (it may still be right for the customer —
  //      their data, their budget, their attachment — which is why it is a signal,
  //      not a verdict).
  //    • Resale: does the repair pay for itself if the phone is sold later?
  //      Decisive if yes; if no, it matters only to someone who means to sell.
  const N = input.upgrade?.newPrice ?? null;
  const vsNew = N && N > 0 ? R / N : null;
  if (vsNew !== null) {
    if (vsNew >= t.upgradeRatio) {
      signals.push({ code: "repair_vs_new_high", points: "upgrade", strength: "strong", text: `Repair is ${pct(vsNew)} of a new ${input.upgrade!.label} — consider replacing.` });
    } else if (vsNew <= t.repairRatio) {
      signals.push({ code: "repair_vs_new_low", points: "repair", strength: "strong", text: `Repair is only ${pct(vsNew)} of a new phone's price.` });
    } else {
      signals.push({ code: "repair_vs_new_mid", points: "repair", strength: "soft", text: `Repair is ${pct(vsNew)} of a new phone's price.` });
    }
  }
  if (R >= V) {
    signals.push({
      code: "repair_exceeds_value",
      points: "upgrade",
      strength: "strong",
      text: V > 0 ? `Repair costs more than the phone is worth repaired (${r(V)}).` : "No resale value, even repaired.",
    });
  } else if (ratio >= t.upgradeRatio) {
    signals.push({ code: "repair_ratio_high", points: "upgrade", strength: "soft", text: `Repair is ${pct(ratio)} of the repaired phone's value.` });
  }
  if (added >= R + t.materialGap) {
    signals.push({
      code: "repair_adds_value",
      points: "repair",
      strength: "strong",
      text: `Repair adds ${r(added)} to its value — it pays for itself.`,
    });
  } else if (added < R - t.materialGap) {
    signals.push({
      code: "repair_destroys_value",
      points: "upgrade",
      strength: "soft",
      text: `If selling soon, repair adds only ${r(Math.max(0, added))} to resale value.`,
    });
  }
  if ((input.faultCount ?? 0) >= 3) {
    signals.push({ code: "many_faults", points: "upgrade", strength: "soft", text: `${input.faultCount} faults at once.` });
  }
  if (input.systemicFault) {
    caveats.push("Liquid, board, network or power faults can return after repair.");
  }

  // 3. Life left in the phone. Context, never decisive on its own: a phone past
  //    its updates is not unusable, and the customer can choose to keep it.
  if (yearsLeftOld !== null && input.old.supportEndYear !== null) {
    if (yearsLeftOld < 0) {
      signals.push({ code: "support_ended", points: "upgrade", strength: "soft", text: `Security updates ended in ${input.old.supportEndYear}.` });
      caveats.push("It still works without updates — avoid banking on it.");
    } else if (yearsLeftOld <= t.supportSoonYears) {
      signals.push({ code: "support_ending", points: "upgrade", strength: "soft", text: `Security updates end in ${input.old.supportEndYear}.` });
    }
  }
  if (input.old.ageYears !== null && input.old.ageYears >= t.oldAgeYears) {
    signals.push({ code: "old_device", points: "upgrade", strength: "soft", text: `The phone is ${input.old.ageYears} years old.` });
  }
  if (input.swollenBattery) {
    caveats.unshift(SWOLLEN_BATTERY_CAVEAT);
  }

  const strongUp = signals.some((s) => s.points === "upgrade" && s.strength === "strong");
  const strongRep = signals.some((s) => s.points === "repair" && s.strength === "strong");
  const softUp = signals.filter((s) => s.points === "upgrade").length;
  const softRep = signals.filter((s) => s.points === "repair").length;

  let recommendation: Recommendation;
  if (strongUp && !strongRep) recommendation = "upgrade";
  else if (strongRep && !strongUp) recommendation = "repair";
  else if (strongUp && strongRep) recommendation = "either";
  else recommendation = softRep >= softUp ? "repair" : "either";

  const favoursCustomer: Decision["favoursCustomer"] =
    net > T + t.materialGap ? "keep" : net < T - t.materialGap ? "let_go" : "level";

  const up = upgradeBlock(R);
  const headline =
    recommendation === "repair"
      ? "Repair recommended"
      : recommendation === "upgrade"
        ? "An upgrade is worth considering"
        : "Either works — customer's choice";

  if (favoursCustomer === "level") caveats.push("Kept or traded, it's worth about the same — customer's call.");
  if (yearsLeftOld !== null || yearsLeftNew !== null) {
    caveats.push("Cost per year assumes use until updates end.");
  }
  caveats.push("This answer doesn't depend on what the store earns.");

  return {
    version: RULESET_VERSION,
    recommendation,
    headline,
    favoursCustomer,
    repair: { pays: R, keepsValue: V, net, covered: input.repairCovered },
    upgrade: up,
    metrics: {
      repairRatio: Number.isFinite(ratio) ? ratio : null,
      repairVsNewRatio: vsNew,
      valueAddedByRepair: added,
      yearsLeftOld,
      yearsLeftNew,
      costPerYearRepair: yearsLeftOld !== null && yearsLeftOld > 0 ? Math.round(R / yearsLeftOld) : null,
      costPerYearUpgrade: up && yearsLeftNew !== null && yearsLeftNew > 0 ? Math.round(up.pays / yearsLeftNew) : null,
    },
    signals,
    missing,
    caveats,
  };
}
