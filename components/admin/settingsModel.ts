/**
 * Programme settings form model: the form holds strings (percentages as typed);
 * the patch holds what updateOrgSettings expects. Pure and client-safe.
 */
import type { OrgSettings } from "@/lib/server/auth";
import { parsePct, parseRupees } from "./format";

export type SettingsFormValues = {
  releaseOn: "collected" | "cleared";
  warnAtPct: string;
  maxAgeDays: string;
  pickupAtCount: string;
  shortfallLiability: "store" | "partner";
  labourZ: string;
  labourS: string;
  labourOther: string;
  gstPct: string;
  carePlus: string;
  quoteValidity: string;
  upgradeRatioPct: string;
  repairRatioPct: string;
  materialGap: string;
  supportSoonYears: string;
  oldAgeYears: string;
  bandMinPct: string;
  bandMaxPct: string;
};

const pctOfFrac = (f: number) => String(Math.round(f * 1000) / 10);

export function toForm(s: OrgSettings): SettingsFormValues {
  return {
    releaseOn: s.releaseOn,
    warnAtPct: pctOfFrac(s.warnAt),
    maxAgeDays: String(s.maxAgeDays),
    pickupAtCount: String(s.pickupAtCount),
    shortfallLiability: s.shortfallLiability,
    labourZ: String(s.repairPolicy.labourByTier.Z ?? ""),
    labourS: String(s.repairPolicy.labourByTier.S ?? ""),
    labourOther: String(s.repairPolicy.labourByTier.other ?? ""),
    gstPct: String(s.repairPolicy.gstBp / 100),
    carePlus: String(s.repairPolicy.carePlusFeeDefault),
    quoteValidity: s.quoteValidityDays === null ? "" : String(s.quoteValidityDays),
    upgradeRatioPct: pctOfFrac(s.thresholds.upgradeRatio),
    repairRatioPct: pctOfFrac(s.thresholds.repairRatio),
    materialGap: String(s.thresholds.materialGap),
    supportSoonYears: String(s.thresholds.supportSoonYears),
    oldAgeYears: String(s.thresholds.oldAgeYears),
    bandMinPct: String(s.bandMinBp / 100),
    bandMaxPct: String(s.bandMaxBp / 100),
  };
}

export type SettingsPatch = Partial<Omit<OrgSettings, "repairPolicy" | "thresholds">> & {
  repairPolicy?: Partial<OrgSettings["repairPolicy"]>;
  thresholds?: Partial<OrgSettings["thresholds"]>;
};

/** SettingsFormValues → patch, plus problems in plain words (the server checks again). */
export function buildSettingsPatch(f: SettingsFormValues, isPlatform: boolean): { patch: SettingsPatch; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const int = (k: keyof SettingsFormValues, lo: number, hi: number, msg: string) => {
    const n = Number(f[k].trim());
    if (!f[k].trim() || !Number.isInteger(n) || n < lo || n > hi) e[k] = msg;
    return n;
  };
  const rupees = (k: keyof SettingsFormValues, hi: number, msg: string) => {
    const n = parseRupees(f[k]);
    if (n === null || n < 0 || n > hi) e[k] = msg;
    return n ?? 0;
  };
  const pct = (k: keyof SettingsFormValues, lo: number, hi: number, msg: string) => {
    const n = parsePct(f[k]);
    if (n === null || n < lo || n > hi) e[k] = msg;
    return n ?? 0;
  };
  const num = (k: keyof SettingsFormValues, lo: number, hi: number, msg: string) => {
    const n = Number(f[k].trim());
    if (!f[k].trim() || !Number.isFinite(n) || n < lo || n > hi) e[k] = msg;
    return n;
  };

  const warnAt = pct("warnAtPct", 1, 100, "Between 1% and 100%.");
  const maxAgeDays = int("maxAgeDays", 1, 60, "Whole days, 1–60.");
  const pickupAtCount = int("pickupAtCount", 1, 500, "Whole number, 1–500.");
  const Z = rupees("labourZ", 50_000, "Whole rupees.");
  const S = rupees("labourS", 50_000, "Whole rupees.");
  const other = rupees("labourOther", 50_000, "Whole rupees.");
  const gst = pct("gstPct", 0, 28, "0–28%.");
  const gstBp = Math.round(gst * 100);
  if (!e.gstPct && Math.abs(gst * 100 - gstBp) > 1e-6) e.gstPct = "Up to two decimals.";
  const carePlus = rupees("carePlus", 100_000, "Whole rupees.");
  let quoteValidityDays: number | null = null;
  if (f.quoteValidity.trim()) quoteValidityDays = int("quoteValidity", 1, 30, "1–30 days, or leave blank.");
  const upgradeRatio = pct("upgradeRatioPct", 1, 200, "1–200%.") / 100;
  const repairRatio = pct("repairRatioPct", 0, 199, "0–199%.") / 100;
  if (!e.upgradeRatioPct && !e.repairRatioPct && repairRatio >= upgradeRatio) e.repairRatioPct = "Must be lower than the upgrade threshold.";
  const materialGap = rupees("materialGap", 100_000, "Whole rupees.");
  const supportSoonYears = num("supportSoonYears", 0, 10, "0–10 years.");
  const oldAgeYears = num("oldAgeYears", 1, 20, "1–20 years.");

  const patch: SettingsPatch = {
    releaseOn: f.releaseOn,
    warnAt: warnAt / 100,
    maxAgeDays,
    pickupAtCount,
    shortfallLiability: f.shortfallLiability,
    repairPolicy: { labourByTier: { Z, S, other }, gstBp, carePlusFeeDefault: carePlus },
    quoteValidityDays,
    thresholds: { upgradeRatio, repairRatio, materialGap, supportSoonYears, oldAgeYears },
  };
  if (isPlatform) {
    const lo = pct("bandMinPct", 0, 10, "0–10%.");
    const hi = pct("bandMaxPct", 0, 10, "0–10%.");
    if (!e.bandMinPct && !e.bandMaxPct && lo > hi) e.bandMaxPct = "Must be at least the minimum.";
    patch.bandMinBp = Math.round(lo * 100);
    patch.bandMaxBp = Math.round(hi * 100);
  }
  return { patch, errors: e };
}
