/**
 * SELL — what a refurbished phone sells for, from PriceIQ's refurbished market price.
 *
 * Owner, 2026-10-17: "reduce by 2 to 5%: 5% on lower price and 2% on higher". PriceIQ answers,
 * per model, storage and grade, the LOWEST refurbished-market listing (lib/server/priceiq.ts,
 * GET /api/market-grades). The store's sell price is that listing less a markdown that shrinks
 * as the price grows, so a refurbished phone from the centre always undercuts the market:
 *
 *   market listing    markdown
 *   up to ₹15,000        5%
 *   up to ₹30,000        4%
 *   up to ₹50,000        3%
 *   above ₹50,000        2%
 *
 * Owner, 2026-10-18: the SAME markdown sits under the trade-in (lib/domain/priceiqTradeIn.ts) —
 * one margin below the market price everywhere, in SwapUp and in GradeIQ.
 *
 * The grade is the one the phone will be AFTER refurb: whatever the refurb repairs (a cracked
 * screen, a cracked back) comes out like new; what it does not touch (scuffs, dents, a bent
 * frame, a scratched screen) keeps the grade down. When the market lists no phone at that grade
 * the next LOWER listed grade is used and named — never a higher one.
 *
 * Old data (owner, 2026-10-18): a market price more than 14 days old is shown WITH its age; more
 * than 90 days old is no price at all. PriceIQ unreachable: the last good answer, labelled.
 *
 * Pure — no database, no clock (callers pass `asOf`).
 */
import type { BasisPoints, Rupees } from "./money.ts";
import type { BodyState, ConditionAnswers, ScreenState } from "./condition.ts";

/** The refurbished-market grades, best first, word for word as PriceIQ returns them — the SwapUp grade's words. */
export const MARKET_GRADES = ["Superb", "Good", "Fair", "Best Value"] as const;
export type MarketGrade = (typeof MARKET_GRADES)[number];

/** The letter beside each grade (owner, 2026-10-17: "both scales") — a strict one-to-one translation, never CTIA. */
export type MarketGradeLetter = "A" | "B" | "C" | "D";
export const MARKET_GRADE_LETTER: Readonly<Record<MarketGrade, MarketGradeLetter>> = { Superb: "A", Good: "B", Fair: "C", "Best Value": "D" };

export function isMarketGrade(g: unknown): g is MarketGrade {
  return typeof g === "string" && (MARKET_GRADES as readonly string[]).includes(g);
}

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

/** A market listing less its markdown, rounded down to the rupee. The sell price, and the trade-in's start. */
export function sellFromListing(listing: Rupees): { amount: Rupees; markdownBp: BasisPoints; markdown: Rupees } {
  const bp = markdownBp(listing);
  const amount = Math.floor((listing * (10_000 - bp)) / 10_000);
  return { amount, markdownBp: bp, markdown: listing - amount };
}

const rank = (g: MarketGrade) => MARKET_GRADES.indexOf(g);
const worse = (a: MarketGrade, b: MarketGrade): MarketGrade => (rank(a) >= rank(b) ? a : b);

/**
 * Rule G1 of the SwapUp grade (lib/domain/grading.ts): what the phone LOOKS like — the worse of the
 * screen's and the body's grade; null when either is off the grade ladder (lines, a cracked or dead
 * screen, a cracked back: those are repairs, not looks). Here, beside the grade's words, so the
 * grade and the PriceIQ trade-in read one rule and the trade-in never imports the grading engine.
 */
const SCREEN_GRADE: Partial<Record<ScreenState, MarketGrade>> = { flawless: "Superb", scratched: "Good" };
const BODY_GRADE: Partial<Record<BodyState, MarketGrade>> = { flawless: "Superb", scuffed: "Good", dented: "Fair", bent: "Best Value" };
export function cosmeticGrade(condition: Pick<ConditionAnswers, "screen" | "body"> | null): MarketGrade | null {
  if (!condition) return null;
  const s = SCREEN_GRADE[condition.screen];
  const b = BODY_GRADE[condition.body];
  return s && b ? worse(s, b) : null;
}

// The grade ladder is rule G1's: a screen or body state with no grade is a defect, not a look.
const onLadder = {
  screen: (s: ScreenState) => SCREEN_GRADE[s] !== undefined,
  body: (b: BodyState) => BODY_GRADE[b] !== undefined,
};
/** A screen or body state the grade can't see (lines, a cracked or dead screen, a cracked back): a defect, deducted. */
export const isDefectState = { screen: (s: ScreenState) => !onLadder.screen(s), body: (b: BodyState) => !onLadder.body(b) };

/**
 * THE SwapUp GRADE — one grade for a phone, everywhere (owner, 2026-10-22: "auto grade ... grade
 * match and also if I change condition re grade n price change in all"): rule G1 on what the grade
 * can see, with a defect (lines, a cracked or dead screen, a cracked back) left out — the defect is
 * named beside the grade and taken off its price instead. null = no condition.
 *
 * It is, all at once: the grade every answer shows ("Current grade A · back glass cracked"); the
 * grade the trade-in is priced at (a per-grade rate card's column, ratecard.ts; PriceIQ's listing,
 * priceiqTradeIn.ts); and the grade the phone comes out at after refurb, because the refurb replaces
 * exactly what the grade leaves out (the screen, the back glass) and touches nothing it sees
 * (scratches, scuffs, dents, a bent frame). So no screen ever shows one grade and prices another.
 */
export function tradeInGrade(condition: Pick<ConditionAnswers, "screen" | "body"> | null | undefined): MarketGrade | null {
  if (!condition) return null;
  return cosmeticGrade({ screen: onLadder.screen(condition.screen) ? condition.screen : "flawless", body: onLadder.body(condition.body) ? condition.body : "flawless" });
}

/**
 * The grade a phone in this condition comes out at after refurb — the SwapUp grade itself
 * (tradeInGrade): a cracked screen or back glass is replaced, what the grade sees stays. Its own
 * name for the sell side (the refurbished price, the repaired value, the report's after-repair grade).
 */
export const gradeAfterRefurb = tradeInGrade;

/* ─────────────────────────── PriceIQ's answer, as SwapUp keeps it ─────────────────────────── */

/** One grade's lowest listing. `points`: how many distinct prices PriceIQ saw at that grade. */
export type ListingRow = { grade: string; price: Rupees; week: string; points?: number };

/**
 * What PriceIQ last said about ONE model + storage (lib/server/priceiq.ts keeps it in
 * market_listings). `rows` [] = PriceIQ answered and has no price for it.
 */
export type MarketAnswer = {
  rows: ListingRow[];
  /** The newest week with graded rows. null when PriceIQ has none. */
  week: string | null;
  /** When the newest of those listings was seen. null when PriceIQ has none. */
  observedAt: string | null;
  /** When SwapUp got this answer from PriceIQ. */
  fetchedAt: string;
  /** PriceIQ didn't answer the latest ask (down, slow, refused): this is the last good answer. */
  unreachable: boolean;
};

/** Older than this, a market price is shown with its age. */
export const MARKET_STALE_AFTER_DAYS = 14;
/** Older than this, a market price is no price. */
export const MARKET_NO_PRICE_AFTER_DAYS = 90;

/** The Monday an ISO week ("2026-W35") starts on, as epoch ms; null when it isn't one. */
export function weekStart(week: string): number | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  return jan4 - dow * 86_400_000 + (n - 1) * 7 * 86_400_000;
}

/** Whole days from the start of `week` to `asOf`; null when either can't be read. */
export function weekAgeDays(week: string, asOf: string): number | null {
  const start = weekStart(week);
  const now = Date.parse(asOf);
  if (start === null || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - start) / 86_400_000));
}

/** How old the market data is on `asOf`: from when it was observed, else from its week. null = it can't be read. */
export function marketAgeDays(a: Pick<MarketAnswer, "week" | "observedAt">, asOf: string): number | null {
  const seen = a.observedAt ? Date.parse(a.observedAt) : NaN;
  const now = Date.parse(asOf);
  if (Number.isFinite(seen) && Number.isFinite(now)) return Math.max(0, Math.floor((now - seen) / 86_400_000));
  return a.week ? weekAgeDays(a.week, asOf) : null;
}

/** "2026-10-18 09:12 UTC" — an ISO time as staff read it. */
export function shortTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/** The words for old data (contract §3): "refurbished market price, week 2026-W35, 52 days old". */
export const staleLabel = (week: string, days: number) => `refurbished market price, week ${week}, ${days} days old`;
/** The words when PriceIQ didn't answer and the last good answer is used. */
export const unreachableLabel = (fetchedAt: string) => `PriceIQ unreachable, last answer ${shortTime(fetchedAt)}`;

/** Why there is no listing for this phone — the same words wherever a PriceIQ price is missing. */
export const noListingWhy = (label: string) => `PriceIQ has no refurbished market price for the ${label}.`;
export const onlyAboveWhy = (label: string, wanted: MarketGrade) => `The market lists the ${label} only above "${wanted}".`;
export const tooOldWhy = (label: string, week: string, days: number) =>
  `PriceIQ's prices for the ${label} are from ${week} (${days} days old) — too old to price.`;
export const undatedWhy = (label: string) => `PriceIQ's prices for the ${label} carry no date — not used.`;
/** No answer from PriceIQ at all (not set up, or never reached): no price yet, never a guess. */
export const NO_MARKET_YET = "No refurbished market price yet.";

/**
 * Whether this answer may price anything on `asOf`, and how it must be labelled. null `answer` →
 * no price yet. The label names the age when it is over 14 days and PriceIQ being unreachable
 * when this is the last good answer; both together when both hold.
 */
export function marketUsable(
  answer: MarketAnswer | null,
  asOf: string,
  label: string
): { ok: true; ageDays: number; stale: boolean; note: string | null } | { ok: false; why: string } {
  if (!answer) return { ok: false, why: NO_MARKET_YET };
  if (!answer.rows.some((r) => isMarketGrade(r.grade) && Number.isInteger(r.price) && r.price > 0)) return { ok: false, why: noListingWhy(label) };
  const age = marketAgeDays(answer, asOf);
  if (age === null) return { ok: false, why: undatedWhy(label) };
  if (age > MARKET_NO_PRICE_AFTER_DAYS) return { ok: false, why: tooOldWhy(label, answer.week ?? "an unknown week", age) };
  const stale = age > MARKET_STALE_AFTER_DAYS;
  const said = [stale ? staleLabel(answer.week ?? "unknown", age) : null, answer.unreachable ? unreachableLabel(answer.fetchedAt) : null].filter((s): s is string => !!s).join(" · ");
  return { ok: true, ageDays: age, stale, note: said ? `${said[0].toUpperCase()}${said.slice(1)}.` : null };
}

export type MarketSell =
  | {
      amount: Rupees;
      /** The refurbished market's lowest listing at `grade`. */
      listing: Rupees;
      markdownBp: BasisPoints;
      grade: MarketGrade;
      /** The grade the phone should get; differs from `grade` when the market listed none at it. */
      gradeWanted: MarketGrade;
      listings: number;
      week: string;
      ageDays: number;
      /** Over 14 days old: shown with its age. */
      stale: boolean;
      /** "Refurbished market price, week 2026-W35, 52 days old." and/or "PriceIQ unreachable, …"; null when neither. */
      note: string | null;
      why: null;
    }
  | { amount: null; why: string };

/** The lowest listing at `wanted`, else at the next LOWER grade that has one — never a higher one. null = none at or below. */
export function listingAt(rows: ListingRow[], wanted: MarketGrade): { listing: Rupees; grade: MarketGrade; listings: number; week: string } | null {
  for (const grade of MARKET_GRADES.slice(rank(wanted))) {
    const at = rows.filter((r) => r.grade === grade && Number.isInteger(r.price) && r.price > 0);
    if (!at.length) continue;
    const lowest = at.reduce((a, b) => (b.price < a.price ? b : a));
    const week = at.map((r) => r.week).sort().pop() ?? lowest.week;
    const listings = at.reduce((s, r) => s + (Number.isInteger(r.points) && r.points! > 0 ? r.points! : 1), 0);
    return { listing: lowest.price, grade, listings, week };
  }
  return null;
}

/**
 * The sell price from PriceIQ's answer for ONE phone model + storage: the lowest listing at the
 * grade after refurb (or the next lower grade, named), less the markdown — or why there is none.
 */
export function marketSell(input: {
  answer: MarketAnswer | null;
  condition: Pick<ConditionAnswers, "screen" | "body"> | null | undefined;
  label: string;
  asOf: string;
  /** Why there is no answer at all, when the caller knows (PriceIQ not set up). */
  noAnswerWhy?: string | null;
}): MarketSell {
  const wanted = gradeAfterRefurb(input.condition);
  if (!wanted) return { amount: null, why: "The phone's condition isn't on the case yet." };
  if (!input.answer && input.noAnswerWhy) return { amount: null, why: input.noAnswerWhy };
  const use = marketUsable(input.answer, input.asOf, input.label);
  if (!use.ok) return { amount: null, why: use.why };
  const at = listingAt(input.answer!.rows, wanted);
  if (!at) return { amount: null, why: onlyAboveWhy(input.label, wanted) };
  const s = sellFromListing(at.listing);
  return {
    amount: s.amount,
    listing: at.listing,
    markdownBp: s.markdownBp,
    grade: at.grade,
    gradeWanted: wanted,
    listings: at.listings,
    week: at.week,
    ageDays: use.ageDays,
    stale: use.stale,
    note: use.note,
    why: null,
  };
}

/* ─────────────────────────── asking PriceIQ for a SwapUp phone ─────────────────────────── */

/**
 * The model name PriceIQ is asked for (contract §1: "the caller strips the brand prefix and codes
 * like (A3295)"): "Samsung Galaxy S23 Ultra (SM-S918B)" → "Galaxy S23 Ultra". Never shortened
 * further — PriceIQ matches exactly, so a neighbouring model can't answer for this one.
 */
export function priceiqModelName(brand: string, model: string): string {
  let m = model.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const b = brand.trim();
  if (b && m.toLowerCase().startsWith(`${b.toLowerCase()} `)) m = m.slice(b.length).trim();
  return m;
}

/** "256GB" → 256, "1TB" → 1024; anything else → null (never a guessed size). */
export function storageGb(variant: string | null | undefined): number | null {
  const m = /^(\d+)\s*(GB|TB)$/i.exec((variant ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toUpperCase() === "TB" ? 1024 : 1);
  return Number.isInteger(n) && n > 0 ? n : null;
}
