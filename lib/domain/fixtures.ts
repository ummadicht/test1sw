// Test fixtures — a small, clearly fictional rate card and repair book.
import type { RateCard } from "./ratecard.ts";
import type { RepairBookEntry } from "./repair.ts";
import type { Campaign } from "./bonus.ts";

export const CARD: RateCard = {
  id: "rc_test",
  partner: "Cashify",
  source: { kind: "sample", label: "Test card", effectiveFrom: "2026-10-01" },
  quoteValidityDays: 3,
  roundTo: 10,
  maxDeductionBp: 8500,
  floorBp: 500,
  deductions: {
    deadBp: 8000,
    callsBp: 1500,
    screen: { flawless: 0, scratched: 500, lines_or_spots: 3000, cracked: 3500, not_working: 6000 },
    body: { flawless: 0, scuffed: 300, dented: 1000, back_cracked: 1200, bent: 3000 },
    issues: {
      touch: 2500, battery: 800, charging: 1000, rear_camera: 1500, front_camera: 800, speaker: 600,
      mic: 600, wifi_bt: 1500, fingerprint: 700, buttons: 500, vibration: 300, liquid: 4000,
    },
    noChargerBp: 300,
    noBoxBp: 200,
    noBillBp: 300,
    age: { lt3m: 0, "3to11m": 400, gt11m: 800 },
  },
  entries: [
    { modelId: "galaxy-s22", variant: "8/128", maxPrice: 24000 },
    { modelId: "galaxy-a52", variant: "6/128", maxPrice: 9000 },
  ],
};

const src = { kind: "sample" as const, label: "Test book" };
export const BOOK: RepairBookEntry[] = [
  { modelId: "galaxy-s22", part: "display", price: 14000, source: src },
  { modelId: "galaxy-s22", part: "battery", price: 3000, source: src },
  { modelId: "galaxy-s22", part: "back_cover", price: 2500, source: src },
  { modelId: "galaxy-a52", part: "display", price: 6500, source: src },
];

export const CAMPAIGN: Campaign = {
  id: "cmp_test",
  name: "Upgrade bonus",
  basis: "new_price",
  minBp: 200,
  maxBp: 500,
  capRupees: null,
  fundedBy: "Brand",
  startsOn: "2026-10-01",
  endsOn: "2026-12-31",
  rules: [
    { id: "base", label: "Base", bp: 200, when: { kind: "always" } },
    { id: "loyal", label: "Samsung loyalty", bp: 100, when: { kind: "old_brand", brands: ["Samsung"] } },
    { id: "flag", label: "Flagship", bp: 100, when: { kind: "target_series", series: ["S", "Z"] } },
    { id: "repair", label: "Expensive repair", bp: 100, when: { kind: "repair_ratio_gte", ratio: 0.5 } },
    { id: "old", label: "Old phone", bp: 50, when: { kind: "old_age_years_gte", years: 4 } },
  ],
};
