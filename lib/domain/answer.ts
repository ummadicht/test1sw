/**
 * THE ANSWER, WORD FOR WORD — the lines every screen prints as sent (owner, 2026-10-18):
 *
 *     Current grade C · screen cracked
 *     Market price for grade C ₹25,000
 *     We pay you ₹26,000
 *     + ₹6,199 bonus if you exchange with a new device · Galaxy S26 Ultra 256GB
 *     or repair it for ₹34,096
 *
 * The server writes every word and every number here; the desk, SwapUp Store and SwapUp Check
 * (native and browser) print `lines` and add only staff extras under them. That is what keeps four
 * screens from drifting apart. The customer's phone gets `customerAnswer` — a whitelist copy with
 * no source, no percentage, no premium, no staff note.
 *
 *   grade    THE SwapUp grade (marketSell.ts tradeInGrade, owner 2026-10-22: "grade match"): rule
 *            G1 on the phone's look with its defects set aside — the ONE grade the trade-in is
 *            priced at, the report shows and the refurb comes out at. The defects go in the note,
 *            at most two, then "+N more".
 *   market   M — what the buyback partner pays for this phone (the case's trade-in quote), named
 *            "for grade X" with the grade line's own grade. When the price took something off the
 *            grade's price (a defect, missing accessories, age), the note is the calculation:
 *            "₹34,960 less ₹5,250 for back glass cracked". Shown to the customer only from the
 *            partner's own price (its rate card): a PriceIQ trade-in is SwapUp's estimate, so the
 *            customer waits while staff see it. Only when nothing listed the phone's grade and a
 *            lower one priced it does the line name no grade; staff read which grade it was.
 *   we_pay  W = M + the SwapUp premium (premium.ts). The premium is never named to the customer.
 *   bonus    the upgrade bonus, with a new phone only.
 *   repair   the customer's repair price (the refurb quote), at the counter or once chosen.
 *
 * Pure — no database, no clock. It may only `import type` from offer.ts, and never imports the
 * grading engine (grading.test.ts G49).
 */
import { inr, fmtBp, type BasisPoints, type Rupees } from "./money.ts";
import { MARKET_GRADE_LETTER, isDefectState, tradeInGrade, type MarketGrade, type MarketGradeLetter } from "./marketSell.ts";
import { BODY_WORD, ISSUE_LABEL, SCREEN_WORD, type ConditionAnswers } from "./condition.ts";
import { premiumOn, PREMIUM_RULE_VERSION } from "./premium.ts";
import type { PriceSourceKind } from "./ratecard.ts";
import type { Coverage } from "./repair.ts";
import type { Recommendation } from "./decision.ts";

/* ─────────────────────────── the contract (docs/MOBILE-API.md §3c, §4) ─────────────────────────── */

export type AnswerLineKey = "grade" | "market" | "we_pay" | "bonus" | "repair";
/** One line, word for word. `note` is customer-safe and is printed after " · " in muted ink. */
export type AnswerLine = { key: AnswerLineKey; text: string; note: string | null; amount: Rupees | null };

export type Answer = {
  /** The customer may see the figures. Staff screens print `lines` whatever this says. */
  ready: boolean;
  /** One customer sentence when !ready ("The advisor is working out your price."); null when ready. */
  text: string | null;
  /** The case has left the counter: the figures are the ones locked (or last shown). */
  final: boolean;
  /** The CUSTOMER's headline. Staff screens keep Offer.headline. */
  headline: string;
  grade: { letter: MarketGradeLetter; word: MarketGrade; note: string | null } | null;
  /** letter/word = the grade the market line names — the grade line's; null only when a lower grade priced it (none listed at the phone's). */
  market: { amount: Rupees; letter: MarketGradeLetter | null; word: MarketGrade | null; source: string } | null;
  premium: { amount: Rupees; bp: BasisPoints; rule: string } | null;
  wePay: Rupees | null;
  /** Only with a new phone and an amount > 0. */
  bonus: { amount: Rupees; bp: BasisPoints } | null;
  /** The label without the brand: "Galaxy S26 Ultra 256GB". */
  newPhone: { label: string; price: Rupees } | null;
  repair: { amount: Rupees | null; covered: boolean; coverage: Coverage; nothingToRepair: boolean };
  /** In the owner's order: grade, market, we_pay, bonus, repair — absent lines left out. */
  lines: AnswerLine[];
  /** Staff-only words, server-written; never in the customer slice. */
  staffNotes: { market: string | null; we_pay: string | null; bonus: string | null };
  /** A test programme (org.demo): every surface adds "Test programme — no real money". */
  test: boolean;
};

/** What the customer's phone gets (GET /api/device/status → answer). A whitelist, copied key by key. */
export type CustomerAnswer =
  | { ready: false; final: boolean; text: string; test: boolean }
  | {
      ready: true;
      final: boolean;
      headline: string;
      grade: { letter: MarketGradeLetter; word: MarketGrade; note: string | null } | null;
      market: { amount: Rupees; letter: MarketGradeLetter | null; word: MarketGrade | null } | null;
      wePay: Rupees | null;
      bonus: { amount: Rupees } | null;
      newPhone: { label: string } | null;
      repair: { amount: Rupees | null; covered: boolean; nothingToRepair: boolean };
      lines: AnswerLine[];
      test: boolean;
    };

/** What buildOffer hands in (lib/domain/offer.ts maps its own values onto it). */
export type AnswerInput = {
  status: string;
  condition: Pick<ConditionAnswers, "powersOn" | "calls" | "screen" | "body" | "issues"> | null;
  /**
   * The market price M on the case (Offer.swap.tradeIn) and where it came from. `priceGrade`: the
   * grade the price's base is FOR (a PriceIQ listing, a rate card's grade column); null when the
   * price is for the phone as it is (a rate card without grade prices).
   */
  market: {
    amount: Rupees;
    source: PriceSourceKind | string;
    priceGrade: MarketGrade | null;
    /**
     * The grade's own price before anything was taken off (a rate card grade column's price), when
     * the source has one. M below it means something was deducted (a defect, missing accessories,
     * age): the market line's note works it out — "₹34,960 less ₹5,250 for back glass cracked".
     */
    gradePrice?: Rupees | null;
    /** What was taken off, as the customer reads it ("back glass cracked", "no charger"), in the quote's order. */
    takenOff?: string[] | null;
  } | null;
  /** An expired quote or the camera's identity block — nothing ready. */
  quoteExpired: boolean;
  quoteBlocked: boolean;
  repair: { amount: Rupees | null; covered: boolean; coverage: Coverage; nothingToRepair: boolean };
  newPhone: { label: string; price: Rupees } | null;
  /** `cap` = the campaign's ₹ cap when it is what set the amount; null otherwise. */
  bonus: { amount: Rupees; bp: BasisPoints; cap: Rupees | null } | null;
  /** Offer.swap.bonusWhy — the staff note when there is no bonus. */
  bonusWhy: string | null;
  recommendation: Recommendation | null;
  /** Closed traded cases: the figures frozen at lock win over the quote and bonus JSON. */
  locked: { trade: Rupees | null; premium: Rupees | null; premiumBp: BasisPoints | null; bonus: Rupees | null; payable: Rupees | null } | null;
  testProgramme: boolean;
};

/* ─────────────────────────── the words ─────────────────────────── */

export const WORKING_OUT = "The advisor is working out your price.";
export const CONFIRMING = "The advisor is confirming your price.";
export const CANCELLED_TEXT = "This trade-in was cancelled.";
const CLOSED_TEXT = "This case is closed.";
/** Staff: a PriceIQ trade-in is SwapUp's estimate, never shown to the customer as the market price (owner, R1). */
export const ESTIMATE_NOTE = "Estimate from the refurbished market — not shown to the customer.";

/** The sources whose figure IS what the buyback partner pays — the only ones the customer is shown (partner_manual: history only, nothing writes it now). */
const PARTNER_SOURCES: readonly string[] = ["partner_manual", "partner_ratecard"];
export const TRADED_STATUSES: readonly string[] = ["locked", "in_pickup", "collected", "cleared", "regraded", "rejected", "not_received"];

const HEADLINE: Record<Recommendation, string> = {
  repair: "Repair recommended",
  upgrade: "An upgrade is worth considering",
  // decide()'s "customer's choice", said to the customer.
  either: "Either works — your choice",
  no_repair: "Nothing to repair — a straight trade-in",
  cannot_say: "Your offer",
};

const COVER_WORD: Record<Coverage, string> = { none: "", warranty: "warranty", care_plus: "Care+" };

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
/** At most two, then "+N more". */
const atMostTwo = (all: string[]) => (all.length <= 2 ? all.join(", ") : `${all.slice(0, 2).join(", ")}, +${all.length - 2} more`);

/**
 * The defects, in the deduction table's order — never a scratch, scuff, dent or bent frame: the
 * letter already prices those. A phone that won't switch on says only that. At most two, then "+N more".
 */
export function defectNote(c: AnswerInput["condition"]): string | null {
  if (!c) return null;
  if (!c.powersOn) return "doesn't switch on";
  const all: string[] = [];
  if (!c.calls) all.push("calls don't work");
  if (isDefectState.screen(c.screen)) all.push(SCREEN_WORD[c.screen]);
  if (isDefectState.body(c.body)) all.push(BODY_WORD[c.body]);
  for (const i of c.issues) all.push(lowerFirst(ISSUE_LABEL[i]));
  return all.length ? atMostTwo(all) : null;
}

function repairText(r: AnswerInput["repair"], chosen: boolean): string {
  const cover = COVER_WORD[r.coverage] || "warranty";
  if (r.covered) return chosen ? `Repair — covered by ${cover}` : `or repair it free — covered by ${cover}`;
  if (r.amount !== null) return chosen ? `Repair ${inr(r.amount)}` : `or repair it for ${inr(r.amount)}`;
  return chosen ? "Repair — the advisor will quote the price" : "or repair it — the advisor will quote the price";
}

/* ─────────────────────────── the answer ─────────────────────────── */

export function buildAnswer(i: AnswerInput): Answer {
  const s = i.status;
  const open = s === "draft" || s === "quoted";
  const traded = TRADED_STATUSES.includes(s);
  const chosen = s === "repair_chosen";
  const cancelled = s === "cancelled";
  const final = !open;

  // ── The grade: THE SwapUp grade — the one the price is for ──
  const word = tradeInGrade(i.condition);
  const note = defectNote(i.condition);
  const grade = word ? { letter: MARKET_GRADE_LETTER[word], word, note } : null;

  // ── The money: live on the counter, frozen once traded ──
  let M: Rupees | null = null;
  let premium: Answer["premium"] = null;
  let premiumEdge: Rupees | null = null;
  if (traded) {
    // The figures frozen at lock (absent only for a caller with none: then the quote, and no premium).
    M = i.locked ? i.locked.trade : (i.market?.amount ?? null);
    // A case locked before premiums has premium_value NULL: the customer was paid the market price.
    const p = i.locked?.premium ?? null;
    if (M !== null && p !== null && p > 0) premium = { amount: p, bp: i.locked?.premiumBp ?? 0, rule: PREMIUM_RULE_VERSION };
  } else if (!chosen && !cancelled && i.market) {
    M = i.market.amount;
    const p = premiumOn(M);
    if (p) {
      premium = { amount: p.amount, bp: p.bp, rule: p.rule };
      premiumEdge = p.edge;
    }
  }
  const wePay = M === null ? null : M + (premium?.amount ?? 0);
  const bonusAmount = traded && i.locked ? (i.locked.bonus ?? 0) : (i.bonus?.amount ?? 0);
  const bonus = i.newPhone && wePay !== null && bonusAmount > 0 && !chosen && !cancelled ? { amount: bonusAmount, bp: i.bonus?.bp ?? 0 } : null;

  // ── The market line: for the grade the grade line shows, worked out when something was taken off ──
  // The price's base is for the phone's grade (a rate card's column, a PriceIQ listing; a source
  // with no grade of its own prices that grade too) — unless nothing listed that grade and a lower
  // one priced it: then the line names no grade, and staff read which it was.
  const lower = !!i.market?.priceGrade && !!word && i.market.priceGrade !== word;
  const pricedAt = i.market?.priceGrade ?? word;
  const named = word && pricedAt === word ? word : null;
  // Something taken off the grade's own price (a defect, no charger, age): the note is the sum —
  // "₹34,960 less ₹5,250 for back glass cracked" — so the grade, its price and M always add up.
  const gradePrice = i.market?.gradePrice ?? null;
  const takenOff = M !== null && gradePrice !== null && M < gradePrice ? gradePrice - M : 0;
  const what = (i.market?.takenOff ?? []).filter((w) => !!w);
  const sum = gradePrice !== null && takenOff ? `${inr(gradePrice)} less ${inr(takenOff)}${what.length ? ` for ${atMostTwo(what)}` : ""}` : null;
  const market: Answer["market"] =
    M === null ? null : { amount: M, letter: named ? MARKET_GRADE_LETTER[named] : null, word: named, source: i.market?.source ?? "none" };

  // ── Ready for the customer? ──
  const partnerPrice = !!i.market && PARTNER_SOURCES.includes(String(i.market.source));
  let ready: boolean;
  let text: string | null = null;
  if (open) {
    ready = wePay !== null && !i.quoteExpired && !i.quoteBlocked && partnerPrice;
    if (!ready) text = wePay !== null && !i.quoteExpired && !i.quoteBlocked ? CONFIRMING : WORKING_OUT;
  } else if (traded || chosen) ready = true;
  else if (cancelled) {
    ready = false;
    text = CANCELLED_TEXT;
  } else {
    // walked_away: the lines as last worked out, if they were the partner's own figure.
    ready = wePay !== null && partnerPrice;
    if (!ready) text = CLOSED_TEXT;
  }

  // ── The lines, in the owner's order ──
  const lines: AnswerLine[] = [];
  if (grade && !cancelled)
    lines.push({ key: "grade", text: note ? `Current grade ${grade.letter}` : `Current grade ${grade.letter} (${grade.word})`, note, amount: null });
  if (market && wePay !== null) {
    lines.push({
      key: "market",
      text: market.letter ? `Market price for grade ${market.letter} ${inr(M)}` : `Market price ${inr(M)}`,
      note: named ? sum : null,
      amount: M,
    });
    lines.push({ key: "we_pay", text: traded ? `We paid you ${inr(wePay)}` : `We pay you ${inr(wePay)}`, note: null, amount: wePay });
  }
  if (bonus && i.newPhone) {
    lines.push(
      traded
        ? { key: "bonus", text: `+ ${inr(bonus.amount)} bonus with the ${i.newPhone.label}`, note: null, amount: bonus.amount }
        : { key: "bonus", text: `+ ${inr(bonus.amount)} bonus if you exchange with a new device`, note: i.newPhone.label, amount: bonus.amount }
    );
  }
  if (!i.repair.nothingToRepair && !traded && !cancelled)
    lines.push({ key: "repair", text: repairText(i.repair, chosen), note: null, amount: i.repair.covered ? 0 : i.repair.amount });

  // ── The headline the customer reads ──
  const headline = traded
    ? "Traded in"
    : chosen
      ? "Repair chosen"
      : cancelled
        ? "Trade-in cancelled"
        : i.recommendation === "repair" && i.repair.covered
          ? "Repair it — it's covered"
          : HEADLINE[i.recommendation ?? "cannot_say"];

  // ── Staff-only words ──
  // The grade the price is for, when a lower one priced it: "Priced at grade C (₹30,672) — none listed at grade B."
  const pricedNote =
    lower && pricedAt && word
      ? `Priced at grade ${MARKET_GRADE_LETTER[pricedAt]}${gradePrice !== null ? ` (${inr(gradePrice)}${takenOff ? ` less ${inr(takenOff)}` : ""})` : ""} — none listed at grade ${MARKET_GRADE_LETTER[word]}.`
      : null;
  const marketNotes = [open && i.market?.source === "priceiq" ? ESTIMATE_NOTE : null, pricedNote].filter((x): x is string => !!x);
  const pct = premium && premium.bp ? ` (${fmtBp(premium.bp)}${premiumEdge !== null ? `, lifted to what ${inr(premiumEdge)} earns` : ""})` : "";
  const staffNotes = {
    market: market && marketNotes.length ? marketNotes.join(" ") : null,
    we_pay: premium ? `Includes ${inr(premium.amount)} SwapUp premium${pct}.` : null,
    bonus: bonus ? (i.bonus?.cap !== null && i.bonus?.cap !== undefined ? `Upgrade bonus · capped at ${inr(i.bonus.cap)}` : `Upgrade bonus · ${fmtBp(bonus.bp)}`) : i.bonusWhy,
  };

  return {
    ready,
    text,
    final,
    headline,
    grade,
    market,
    premium,
    wePay,
    bonus,
    newPhone: i.newPhone ? { label: i.newPhone.label, price: i.newPhone.price } : null,
    repair: { amount: i.repair.amount, covered: i.repair.covered, coverage: i.repair.coverage, nothingToRepair: i.repair.nothingToRepair },
    lines,
    staffNotes,
    test: i.testProgramme,
  };
}

/**
 * The customer's slice — a WHITELIST copy, not a delete-list: never the source, the premium, any
 * percentage, a staff note or the new phone's price. Not ready → one sentence.
 */
export function customerAnswer(a: Answer): CustomerAnswer {
  if (!a.ready) return { ready: false, final: a.final, text: a.text ?? WORKING_OUT, test: a.test };
  return {
    ready: true,
    final: a.final,
    headline: a.headline,
    grade: a.grade ? { letter: a.grade.letter, word: a.grade.word, note: a.grade.note } : null,
    market: a.market ? { amount: a.market.amount, letter: a.market.letter, word: a.market.word } : null,
    wePay: a.wePay,
    bonus: a.bonus ? { amount: a.bonus.amount } : null,
    newPhone: a.newPhone ? { label: a.newPhone.label } : null,
    repair: { amount: a.repair.amount, covered: a.repair.covered, nothingToRepair: a.repair.nothingToRepair },
    lines: a.lines.map((l) => ({ key: l.key, text: l.text, note: l.note, amount: l.amount })),
    test: a.test,
  };
}
