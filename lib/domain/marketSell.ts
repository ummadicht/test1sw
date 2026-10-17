/**
 * SELL — what a refurbished phone sells for, from PriceIQ's Cashify feed.
 *
 * Owner, 2026-10-17: "we already have PriceIQ for Cashify — reduce by 2 to 5%:
 * 5% on lower price and 2% on higher". PriceIQ (~/projects/priceiq-vendors,
 * leaf `cashify/sell`, source_id `cashify_in_sell`) records what Cashify's own
 * refurbished store lists each phone at, per storage and Cashify grade. The
 * store's sell price is that listing less a markdown that shrinks as the price
 * grows, so a refurbished phone from the centre always undercuts Cashify's own.
 *
 *   Cashify listing   markdown
 *   up to ₹15,000        5%
 *   up to ₹30,000        4%
 *   up to ₹50,000        3%
 *   above ₹50,000        2%
 *
 * The grade is the one the phone will be AFTER refurb: whatever the refurb
 * repairs (a cracked screen, a cracked back) comes out like new; what it does
 * not touch (scuffs, dents, a bent frame, a scratched screen) keeps the grade
 * down. When Cashify lists no phone at that grade the next LOWER listed grade
 * is used and named — never a higher one.
 *
 * Pure — no database, no clock.
 */
import type { BasisPoints, Rupees } from "./money.ts";
import type { ConditionAnswers } from "./condition.ts";

/** Cashify's refurbished grades, best first, exactly as Cashify prints them. */
export const CASHIFY_GRADES = ["Superb", "Good", "Fair", "Best Value"] as const;
export type CashifyGrade = (typeof CASHIFY_GRADES)[number];

/** The markdown bands, cheapest first. `upTo: null` = everything above. */
export const SELL_MARKDOWN: { upTo: Rupees | null; bp: BasisPoints }[] = [
  { upTo: 15_000, bp: 500 },
  { upTo: 30_000, bp: 400 },
  { upTo: 50_000, bp: 300 },
  { upTo: null, bp: 200 },
];

export function markdownBp(listing: Rupees): BasisPoints {
  for (const band of SELL_MARKDOWN) if (band.upTo === null || listing <= band.upTo) return band.bp;
  return SELL_MARKDOWN[SELL_MARKDOWN.length - 1].bp;
}

/** The store's sell price for a Cashify listing: the listing less its markdown, rounded down to the rupee. */
export function sellFromListing(listing: Rupees): { amount: Rupees; markdownBp: BasisPoints; markdown: Rupees } {
  const bp = markdownBp(listing);
  const amount = Math.floor((listing * (10_000 - bp)) / 10_000);
  return { amount, markdownBp: bp, markdown: listing - amount };
}

const rank = (g: CashifyGrade) => CASHIFY_GRADES.indexOf(g);
const worse = (a: CashifyGrade, b: CashifyGrade): CashifyGrade => (rank(a) >= rank(b) ? a : b);

/** The Cashify grade a phone in this condition comes out at after refurb, or null when the condition isn't known. */
export function gradeAfterRefurb(condition: Pick<ConditionAnswers, "screen" | "body"> | null | undefined): CashifyGrade | null {
  if (!condition) return null;
  // The refurb replaces a broken screen, so only a scratched one (not a fault) lowers the grade.
  const screen: CashifyGrade = condition.screen === "scratched" ? "Good" : "Superb";
  const body: CashifyGrade =
    condition.body === "flawless"
      ? "Superb"
      : condition.body === "scuffed"
        ? "Good"
        : condition.body === "back_cracked"
          ? "Good" // the back panel is replaced; the frame under it has usually taken wear
          : condition.body === "dented"
            ? "Fair"
            : "Best Value"; // bent
  return worse(screen, body);
}

export type ListingRow = { grade: string; price: Rupees; week: string };

export type MarketSell =
  | {
      amount: Rupees;
      /** Cashify's lowest listing at `grade`. */
      listing: Rupees;
      markdownBp: BasisPoints;
      grade: CashifyGrade;
      /** The grade the phone should get; differs from `grade` when Cashify listed none at it. */
      gradeWanted: CashifyGrade;
      listings: number;
      week: string;
      why: null;
    }
  | { amount: null; why: string };

/**
 * The sell price from the PriceIQ rows for ONE phone model + storage. `rows`
 * may hold several listings per grade (colours, RAM) — the LOWEST is used.
 */
export function marketSell(input: { rows: ListingRow[]; condition: Pick<ConditionAnswers, "screen" | "body"> | null | undefined; label: string }): MarketSell {
  const wanted = gradeAfterRefurb(input.condition);
  if (!wanted) return { amount: null, why: "The phone's condition isn't on the case yet." };
  if (!input.rows.length) return { amount: null, why: `PriceIQ has no Cashify refurbished price for the ${input.label}.` };
  for (const grade of CASHIFY_GRADES.slice(rank(wanted))) {
    const at = input.rows.filter((r) => r.grade === grade && Number.isInteger(r.price) && r.price > 0);
    if (!at.length) continue;
    const lowest = at.reduce((a, b) => (b.price < a.price ? b : a));
    const s = sellFromListing(lowest.price);
    const week = at.map((r) => r.week).sort().pop() ?? lowest.week;
    return { amount: s.amount, listing: lowest.price, markdownBp: s.markdownBp, grade, gradeWanted: wanted, listings: at.length, week, why: null };
  }
  return { amount: null, why: `Cashify lists the ${input.label} only above "${wanted}" — no price at that grade or below.` };
}

/* ---------- matching Cashify's names to SwapUp's catalogue ---------- */

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, "");
const no5g = (s: string) => s.toLowerCase().replace(/\b5g\b/g, "").replace(/[^a-z0-9+]/g, "");

/**
 * Which SwapUp trade model a Cashify listing name is, or null. Exact (ignoring
 * spaces and case) first: "Galaxy Z Flip 7" is "Galaxy Z Flip7", never "Galaxy
 * Z Flip7 FE". Then ignoring a "5G" suffix — but only when exactly one model in
 * the brand fits, because SwapUp carries both "Galaxy A14" and "Galaxy A14 5G".
 */
export function resolveModel(brand: string, name: string, models: { id: string; brand: string; model: string }[]): string | null {
  const same = models.filter((m) => m.brand.toLowerCase() === brand.trim().toLowerCase());
  const exact = same.filter((m) => compact(m.model) === compact(name));
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const loose = same.filter((m) => no5g(m.model) === no5g(name));
  return loose.length === 1 ? loose[0].id : null;
}

/** "256" / "256GB" / 256 → "256GB"; anything that isn't a storage size (Cashify sometimes prints RAM) → null. */
export function variantFromCapacity(capacity: string | number): string | null {
  const n = Number(String(capacity).replace(/gb$/i, "").trim());
  if (!Number.isInteger(n)) return null;
  if (n === 1024) return "1TB";
  return [32, 64, 128, 256, 512].includes(n) ? `${n}GB` : null;
}
