/**
 * Pure helpers for the upgrade-bonus campaign editor: the form holds strings
 * (percentages as typed); the domain holds basis points. Client-safe.
 */
import { validateCampaign, type BonusCondition, type BonusRule, type Campaign } from "@/lib/domain/bonus";
import { fmtBp, inr, pctToBp } from "@/lib/domain/money";
import { STORE_KIND_LABEL, SERIES_LABEL, parsePct, parseRupees, fmtDay } from "./format";

export type CampaignWithActive = Campaign & { active: boolean };

export type CondKind = BonusCondition["kind"];

export const COND_LABEL: Record<CondKind, string> = {
  always: "Always (base rate)",
  old_brand: "Old phone's brand is…",
  target_series: "New phone's series is…",
  old_age_years_gte: "Old phone is at least … years old",
  repair_ratio_gte: "Repair share is at least …",
  store_kind: "Store type is…",
};

export const COND_KINDS: CondKind[] = ["always", "target_series", "old_brand", "old_age_years_gte", "repair_ratio_gte", "store_kind"];

export type RuleDraft = {
  id: string;
  label: string;
  pct: string;
  kind: CondKind;
  brands: string;
  series: string[];
  years: string;
  ratioPct: string;
  kinds: string[];
};

export type Draft = {
  id: string;
  name: string;
  basis: Campaign["basis"];
  minPct: string;
  maxPct: string;
  cap: string;
  fundedBy: string;
  startsOn: string;
  endsOn: string;
  active: boolean;
  rules: RuleDraft[];
};

const pctStr = (bp: number) => String(bp / 100);

export function newRuleId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function blankRule(kind: CondKind = "always"): RuleDraft {
  return { id: newRuleId(), label: "", pct: "", kind, brands: "", series: [], years: "", ratioPct: "", kinds: [] };
}

export function ruleToDraft(r: BonusRule): RuleDraft {
  const d = blankRule(r.when.kind);
  d.id = r.id;
  d.label = r.label;
  d.pct = pctStr(r.bp);
  const w = r.when;
  if (w.kind === "old_brand") d.brands = w.brands.join(", ");
  if (w.kind === "target_series") d.series = [...w.series];
  if (w.kind === "old_age_years_gte") d.years = String(w.years);
  if (w.kind === "repair_ratio_gte") d.ratioPct = String(Math.round(w.ratio * 1000) / 10);
  if (w.kind === "store_kind") d.kinds = [...w.kinds];
  return d;
}

export function toDraft(c: CampaignWithActive): Draft {
  return {
    id: c.id,
    name: c.name,
    basis: c.basis,
    minPct: pctStr(c.minBp),
    maxPct: pctStr(c.maxBp),
    cap: c.capRupees === null ? "" : String(c.capRupees),
    fundedBy: c.fundedBy,
    startsOn: c.startsOn,
    endsOn: c.endsOn ?? "",
    active: c.active,
    rules: c.rules.map(ruleToDraft),
  };
}

export function emptyDraft(band: { minBp: number; maxBp: number }, today: string): Draft {
  return {
    id: "",
    name: "",
    basis: "new_price",
    minPct: pctStr(band.minBp),
    maxPct: pctStr(band.maxBp),
    cap: "",
    fundedBy: "",
    startsOn: today,
    endsOn: "",
    active: true,
    rules: [{ ...blankRule("always"), label: "Upgrade bonus — base rate", pct: pctStr(band.minBp) }],
  };
}

function condFromDraft(r: RuleDraft, n: string, errs: string[]): BonusCondition {
  switch (r.kind) {
    case "always":
      return { kind: "always" };
    case "old_brand": {
      const brands = r.brands
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      if (!brands.length) errs.push(`${n}: list at least one brand.`);
      return { kind: "old_brand", brands };
    }
    case "target_series":
      if (!r.series.length) errs.push(`${n}: pick at least one series.`);
      return { kind: "target_series", series: r.series };
    case "old_age_years_gte": {
      const y = Number(r.years);
      if (!r.years.trim() || !Number.isFinite(y) || y < 0 || y > 20) errs.push(`${n}: enter the phone age in years (0–20).`);
      return { kind: "old_age_years_gte", years: Number.isFinite(y) ? y : 0 };
    }
    case "repair_ratio_gte": {
      const p = parsePct(r.ratioPct);
      if (p === null || p <= 0 || p > 200) errs.push(`${n}: enter the repair share as a % (1–200).`);
      return { kind: "repair_ratio_gte", ratio: p === null ? 0 : p / 100 };
    }
    case "store_kind":
      if (!r.kinds.length) errs.push(`${n}: pick at least one store type.`);
      return { kind: "store_kind", kinds: r.kinds };
  }
}

/** Draft → Campaign plus every problem the server would refuse (and a few it would not catch). */
export function fromDraft(d: Draft, band: { minBp: number; maxBp: number }): { campaign: Campaign; errors: string[] } {
  const errs: string[] = [];
  const minP = parsePct(d.minPct);
  const maxP = parsePct(d.maxPct);
  if (minP === null) errs.push("Enter the minimum bonus %.");
  if (maxP === null) errs.push("Enter the maximum bonus %.");
  let cap: number | null = null;
  if (d.cap.trim()) {
    cap = parseRupees(d.cap);
    if (cap === null || cap <= 0) errs.push("The ₹ cap must be a positive whole number, or left blank for no cap.");
  }
  const rules: BonusRule[] = d.rules.map((r, i) => {
    const n = `Rule ${i + 1}`;
    const p = parsePct(r.pct);
    if (p === null) errs.push(`${n}: enter how many % it adds.`);
    if (r.label.trim().length < 3) errs.push(`${n}: describe it in a few words — the advisor reads this to the customer.`);
    return { id: r.id, label: r.label.trim(), bp: p === null ? 0 : pctToBp(p), when: condFromDraft(r, n, errs) };
  });
  const campaign: Campaign = {
    id: d.id,
    name: d.name.trim(),
    basis: d.basis,
    minBp: minP === null ? 0 : pctToBp(minP),
    maxBp: maxP === null ? 0 : pctToBp(maxP),
    capRupees: cap !== null && cap > 0 ? cap : null,
    fundedBy: d.fundedBy.trim(),
    startsOn: d.startsOn,
    endsOn: d.endsOn || null,
    rules,
  };
  if (campaign.name.length < 3) errs.unshift("Give the campaign a name.");
  if (!campaign.fundedBy) errs.push("Say who funds the bonus — the claims report is grouped by it.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campaign.startsOn)) errs.push("Choose a start date.");
  if (!rules.length) errs.push("A campaign needs at least one rule.");
  if (minP !== null && maxP !== null) errs.push(...validateCampaign(campaign, band));
  return { campaign, errors: [...new Set(errs)] };
}

export function describeCondition(w: BonusCondition): string {
  switch (w.kind) {
    case "always":
      return "every upgrade";
    case "old_brand":
      return `trading in ${w.brands.join(", ")}`;
    case "target_series":
      return `new phone is ${w.series.map((s) => SERIES_LABEL[s] ?? s).join(" or ")}`;
    case "old_age_years_gte":
      return `old phone ${w.years}+ years`;
    case "repair_ratio_gte":
      return `repair ≥ ${Math.round(w.ratio * 100)}% of repaired value`;
    case "store_kind":
      return `at ${w.kinds.map((k) => (STORE_KIND_LABEL[k] ?? k).toLowerCase() + "s").join(", ")}`;
  }
}

export function basisLabel(b: Campaign["basis"]): string {
  return b === "new_price" ? "% of the new phone's price" : "% of the trade-in value";
}

/** Is the campaign live at the counter today, and if not, why. */
export function campaignStatus(c: CampaignWithActive, today: string): { live: boolean; label: string; tone: "up" | "warn" | "" } {
  if (!c.active) return { live: false, label: "Paused", tone: "" };
  if (c.startsOn > today) return { live: false, label: `Starts ${fmtDay(c.startsOn)}`, tone: "warn" };
  if (c.endsOn && c.endsOn < today) return { live: false, label: `Ended ${fmtDay(c.endsOn)}`, tone: "" };
  return { live: true, label: "Live at the counter", tone: "up" };
}

export function bandText(minBp: number, maxBp: number): string {
  return `${fmtBp(minBp)}–${fmtBp(maxBp)}`;
}

export function capText(cap: number | null): string {
  return cap === null ? "No ₹ cap" : `Capped at ${inr(cap)} per upgrade`;
}
