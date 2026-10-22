import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  refurbEconomics,
  cardTraceLine,
  refurbDecisionShown,
  NOTHING_TO_REPAIR,
  NOT_FROM_PRICE_LIST,
  PRICE_LIST_GONE,
  REFURB_DECISION_STATUSES,
  type RefurbEconomics,
} from "./refurbEconomics.ts";
import { buildOffer, type OfferInput, type OfferQuote } from "./offer.ts";
import { priceFromCard, DEFECT_DEDUCTIONS, DEFECT_RULES, NOT_ON_CARD, type RateCard } from "./ratecard.ts";
import { estimateRepair, type Coverage, type RepairBookEntry } from "./repair.ts";
import { HEALTHY, healedCondition, type ConditionAnswers, type FaultId } from "./condition.ts";
import { gradeAfterRefurb } from "./marketSell.ts";

/* ─────────────────────────── fixtures: SUP-92's worked examples ─────────────────────────── */
// The S23 Ultra 256GB on the week-42 card (A 34,960 · B 33,574 · C 32,255 · D 30,672), SwapUp's
// % per defect with charger / box / bill / age at 0, the repo's real price book (seed-data.json)
// and repair policy (auth.ts defaults: tier S labour ₹425, GST 18%), the S26 Ultra 256GB at
// ₹1,54,999 with a 3% bonus (₹4,649). Everything is built with the real domain functions, the way
// reprice() and toView() build it.

const S23U = "galaxy-s23-ultra";
const W42: RateCard = {
  id: "rc_w42",
  partner: "Buyback Partner (test)",
  source: { kind: "partner_ratecard", label: "Week 42", effectiveFrom: "2026-10-12" },
  quoteValidityDays: 3,
  ...DEFECT_RULES,
  deductions: { ...DEFECT_DEDUCTIONS, noChargerBp: 0, noBoxBp: 0, noBillBp: 0, age: { lt3m: 0, "3to11m": 0, gt11m: 0 } },
  entries: [{ modelId: S23U, variant: "256GB", maxPrice: 34_960, gradePrices: { Good: 33_574, Fair: 32_255, "Best Value": 30_672 } }],
};

const seed = JSON.parse(readFileSync(new URL("../server/seed-data.json", import.meta.url), "utf8")) as { repairBook: RepairBookEntry[] };
const BOOK = seed.repairBook.filter((b) => b.modelId === S23U);
const POLICY = { labour: 425, carePlusFee: 2349, gstBp: 1800 };

const S26U = { deviceId: "nd_s26u_256", label: "Samsung Galaxy S26 Ultra 256GB", model: "Galaxy S26 Ultra", variant: "256GB", price: 154_999 };
const BONUS = { amount: 4_649, bp: 300, override: null };
// Accessories missing and over 11 months old: the card takes nothing off for them (all at 0).
const cond = (over: Partial<ConditionAnswers> = {}): ConditionAnswers => ({ ...HEALTHY, issues: [], accessories: { charger: false, box: false, bill: false }, age: "gt11m", ...over });

type Case = {
  condition: ConditionAnswers;
  faults: FaultId[];
  card?: RateCard | null;
  /** The card the trade-in is read off; default W42. null = no active card. */
  quoteCard?: RateCard | null;
  coverage?: Coverage;
  upgrade?: boolean;
  refurbCost?: { amount: number; by: string } | null;
  quote?: OfferQuote | null;
};

/** One case at the counter, through the answer, then the refurb decision. */
function run(c: Case): { e: RefurbEconomics; offer: ReturnType<typeof buildOffer> } {
  const quoteCard = c.quoteCard === undefined ? W42 : c.quoteCard;
  let quote: OfferQuote | null = c.quote ?? null;
  if (!c.quote) {
    if (!quoteCard) quote = { status: "unpriced", amount: null, source: { kind: "none" }, partnerRef: null, reason: "No rate card is active yet." };
    else {
      const r = priceFromCard(quoteCard, S23U, "256GB", c.condition);
      quote =
        r.status === "priced"
          ? { status: "priced", amount: r.amount, source: { kind: "partner_ratecard" }, partnerRef: null, lines: r.lines, ...(r.grade ? { grade: r.grade } : {}) }
          : { status: "unpriced", amount: null, source: { kind: "none" }, partnerRef: null, reason: r.reason };
    }
  }
  const repair = c.faults.length ? estimateRepair({ book: BOOK, modelId: S23U, faults: c.faults, coverage: c.coverage ?? "none", policy: POLICY }) : null;
  const up = c.upgrade === false ? null : S26U;
  const input: OfferInput = {
    status: "quoted",
    device: { label: "Samsung Galaxy S23 Ultra", variant: "256GB", variants: ["256GB", "512GB"] },
    variantSource: "measured",
    storageQuotes: null,
    faultCount: c.faults.length,
    coverage: c.coverage ?? "none",
    repair,
    manualRepair: null,
    repairNotServiced: null,
    quote,
    quoteExpired: false,
    quoteBlocked: null,
    conditionProblems: [],
    hasCondition: true,
    upgrade: up,
    bonus: up ? BONUS : null,
    decision: null,
    condition: c.condition,
  };
  const offer = buildOffer(input);
  const e = refurbEconomics({
    swap: offer.swap,
    quote,
    card: c.card === undefined ? quoteCard : c.card,
    device: { modelId: S23U, variant: "256GB" },
    condition: c.condition,
    faults: c.faults,
    repair,
    refurbCost: c.refurbCost ?? null,
  });
  return { e, offer };
}

/** The SwapUp offer is the answer's own figures, never worked out again. */
function sameAsAnswer(e: RefurbEconomics, offer: ReturnType<typeof buildOffer>) {
  assert.equal(e.preRefurb.amount, offer.answer.market?.amount ?? null);
  assert.equal(e.offer.amount, offer.answer.wePay);
  assert.equal(e.offer.bonus, offer.answer.bonus?.amount ?? null);
}

/* ─────────────────────────── the worked examples ─────────────────────────── */

test("(a) cracked back, screen flawless: grade A less 15%, the back glass repaired → grade A ₹34,960, repair before pickup +₹654", () => {
  const { e, offer } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"] });
  // The grade it was priced at — the phone's grade, as the answer shows it (one grade).
  assert.deepEqual(e.preRefurb, { amount: 29_710, grade: "A", source: "Market price — priced at grade A ₹34,960, less 15% back glass cracked", why: null });
  assert.deepEqual(e.repairCost, { amount: 4_596, basis: "estimate", source: "SwapUp's repair estimate: back glass / cover ₹3,470 + labour ₹425 + GST ₹701", why: null });
  // The card priced this phone at grade A and took 15% off for the back: repaired, the 15% comes back
  // and the grade the card read stays — owner, SUP-92 (a).
  assert.deepEqual(e.postRepair, { amount: 34_960, grade: "A", source: "Grade A price", why: null });
  assert.deepEqual(e.uplift, { amount: 654, verdict: "repair", text: "Repair before pickup: +₹654", why: null });
  assert.equal(e.uplift.amount, 34_960 - 29_710 - 4_596);
  assert.deepEqual(e.offer, {
    amount: 30_898,
    bonus: 4_649,
    newPhone: "Galaxy S26 Ultra 256GB",
    source: "As on the answer · + ₹4,649 bonus with the Galaxy S26 Ultra 256GB",
    why: null,
  });
  // One grade: the customer's answer shows the grade the panel priced before and after — "Current grade A".
  assert.equal(offer.answer.grade?.letter, "A");
  sameAsAnswer(e, offer);
});

test("repaired: one grade — a new back glass is the look the grade priced, so the repaired phone is the grade it was shown at", () => {
  const back = cond({ body: "back_cracked" });
  assert.equal(healedCondition(back, ["back_cracked"]).body, "flawless");
  assert.equal(gradeAfterRefurb(back), "Superb");
  // Wear the card did price stays: a scratched screen keeps grade B with the back repaired.
  const scratched = run({ condition: cond({ screen: "scratched", body: "back_cracked" }), faults: ["back_cracked"] }).e;
  assert.deepEqual([scratched.preRefurb.grade, scratched.postRepair.grade, scratched.postRepair.amount], ["B", "B", 33_574]);
  // A cracked back no fault explains isn't repaired: it stays, and so does its 15%.
  assert.equal(healedCondition(back, []).body, "back_cracked");
  // A bent frame still heals only as far as scuffs.
  assert.equal(healedCondition(cond({ body: "bent" }), ["frame_damage"]).body, "scuffed");
});

test("(b) cracked screen: the display costs more than it adds — send as-is", () => {
  const { e, offer } = run({ condition: cond({ screen: "cracked" }), faults: ["screen_cracked"] });
  assert.deepEqual(e.preRefurb, { amount: 20_970, grade: "A", source: "Market price — priced at grade A ₹34,960, less 40% screen cracked", why: null });
  assert.deepEqual(e.repairCost, {
    amount: 34_096,
    basis: "estimate",
    source: "SwapUp's repair estimate: display assembly ₹28,470 + labour ₹425 + GST ₹5,201",
    why: null,
  });
  assert.equal(e.repairCost.amount, offer.repair.amount, "the same estimate the customer's repair line uses");
  assert.deepEqual(e.postRepair, { amount: 34_960, grade: "A", source: "Grade A price", why: null });
  assert.deepEqual(e.uplift, { amount: -20_106, verdict: "as_is", text: "Send as-is — repairing costs ₹20,106 more than it adds", why: null });
  assert.equal(e.offer.amount, 21_808);
  sameAsAnswer(e, offer);
});

test("(c) light wear, no faults: grade B, nothing to repair, the same price after", () => {
  const { e, offer } = run({ condition: cond({ screen: "scratched", body: "scuffed" }), faults: [] });
  assert.deepEqual(e.preRefurb, { amount: 33_574, grade: "B", source: "Market price — grade B price", why: null });
  assert.deepEqual(e.repairCost, { amount: 0, basis: "none", source: NOTHING_TO_REPAIR, why: null });
  assert.deepEqual(e.postRepair, { amount: 33_574, grade: "B", source: "Grade B price", why: null });
  assert.deepEqual(e.uplift, { amount: null, verdict: "nothing_to_repair", text: "Nothing to repair", why: null });
  assert.equal(e.offer.amount, 34_581);
  sameAsAnswer(e, offer);
});

test("(d) not on the card, or no card: pre-refurb and post-repair are missing with the specific reason, and no uplift", () => {
  const offCard: RateCard = { ...W42, entries: [{ modelId: "galaxy-s22", variant: "8/128", maxPrice: 24_000 }] };
  for (const [quoteCard, why] of [
    [offCard, NOT_ON_CARD],
    [null, "No rate card is active yet."],
  ] as const) {
    const { e, offer } = run({ condition: cond({ screen: "cracked" }), faults: ["screen_cracked"], quoteCard, card: null });
    assert.deepEqual(e.preRefurb, { amount: null, grade: null, source: null, why });
    assert.deepEqual(e.postRepair, { amount: null, grade: null, source: null, why });
    assert.equal(e.repairCost.amount, 34_096, "the repair cost needs no card");
    assert.deepEqual(e.uplift, { amount: null, verdict: null, text: null, why: "Needs the pre-refurb value and the post-repair value." });
    assert.deepEqual([e.offer.amount, e.offer.bonus, e.offer.why], [null, null, why]);
    assert.equal(offer.swap.why, why);
  }
});

test("the panel is there only with a priced trade-in to decide on: at the counter, and traded in until the partner's pickup", () => {
  assert.deepEqual([...REFURB_DECISION_STATUSES], ["draft", "quoted", "locked", "in_pickup"]);
  for (const s of REFURB_DECISION_STATUSES) assert.equal(refurbDecisionShown(s, { tradeIn: 29_710 }), true, s);
  // No trade-in to decide on: the customer repairs, walked away, cancelled, or the partner has the phone.
  for (const s of ["repair_chosen", "walked_away", "cancelled", "collected", "cleared", "regraded", "rejected", "not_received"] as const)
    assert.equal(refurbDecisionShown(s, { tradeIn: 29_710 }), false, s);
  // No trade-in price: the answer's Swap up side says why, once — not again under every line here.
  assert.equal(refurbDecisionShown("quoted", { tradeIn: null }), false);
});

/* ─────────────────────────── the edges ─────────────────────────── */

test("the store's own repair cost wins over SwapUp's estimate, and can turn the decision", () => {
  const { e } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], refurbCost: { amount: 2_000, by: "Ravi" } });
  assert.deepEqual(e.repairCost, { amount: 2_000, basis: "store", source: "The store's own figure, entered by Ravi", why: null });
  assert.deepEqual(e.uplift, { amount: 3_250, verdict: "repair", text: "Repair before pickup: +₹3,250", why: null });
  // Dearer than SwapUp's estimate, it turns the other way.
  const dear = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], refurbCost: { amount: 6_000, by: "Ravi" } }).e;
  assert.deepEqual([dear.uplift.amount, dear.uplift.verdict, dear.uplift.text], [-750, "as_is", "Send as-is — repairing costs ₹750 more than it adds"]);
  // Exactly even: no gain, so as-is.
  const even = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], refurbCost: { amount: 34_960 - 29_710, by: "Ravi" } }).e;
  assert.deepEqual([even.uplift.amount, even.uplift.verdict, even.uplift.text], [0, "as_is", "Send as-is — repairing only breaks even"]);
  // With no fault, a figure the store typed is still a cost against no gain.
  const cosmetic = run({ condition: cond({ body: "scuffed" }), faults: [], refurbCost: { amount: 500, by: "Ravi" } }).e;
  assert.deepEqual([cosmetic.repairCost.basis, cosmetic.uplift.amount, cosmetic.uplift.verdict], ["store", -500, "as_is"]);
});

test("a repair with no price: the repair cost is missing with why, and there is no uplift", () => {
  // Liquid damage needs a bench check; the post-repair value is still the card's price for it dried out.
  const wet = run({ condition: cond({ issues: ["liquid"] }), faults: ["water_damage"] }).e;
  assert.deepEqual(wet.repairCost, { amount: null, basis: null, source: null, why: "Bench check needed (Liquid damage) — enter the store's repair cost." });
  assert.deepEqual(wet.preRefurb, { amount: 19_220, grade: "A", source: "Market price — priced at grade A ₹34,960, less 45% signs of liquid damage", why: null });
  assert.equal(wet.postRepair.amount, 34_960);
  assert.deepEqual(wet.uplift, { amount: null, verdict: null, text: null, why: "Needs the repair cost." });
  // A part the price book has no price for on this model.
  const speaker = run({ condition: cond({ issues: ["speaker"] }), faults: ["speaker"] }).e;
  assert.deepEqual(speaker.repairCost, { amount: null, basis: null, source: null, why: "No book price for Speaker — enter the store's repair cost." });
  assert.equal(speaker.uplift.amount, null);
});

test("wear the repair doesn't touch stays: a dented phone with a cracked screen comes out at grade C", () => {
  const { e } = run({ condition: cond({ screen: "cracked", body: "dented" }), faults: ["screen_cracked"] });
  assert.deepEqual(e.preRefurb, { amount: 19_350, grade: "C", source: "Market price — priced at grade C ₹32,255, less 40% screen cracked", why: null });
  assert.deepEqual(e.postRepair, { amount: 32_255, grade: "C", source: "Grade C price", why: null });
  assert.equal(e.uplift.amount, 32_255 - 19_350 - 34_096);
  // An issue no fault explains (no repair quoted for it) stays taken off after the repair.
  const wifi = run({ condition: cond({ screen: "cracked", issues: ["wifi_bt"] }), faults: ["screen_cracked"] }).e;
  assert.deepEqual(wifi.postRepair, { amount: 29_710, grade: "A", source: "Priced at grade A ₹34,960, less 15% Wi-Fi / Bluetooth faulty", why: null });
});

test("no new phone: the offer is what we pay, as on the answer, with no bonus", () => {
  const { e, offer } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], upgrade: false });
  assert.deepEqual(e.offer, { amount: 30_898, bonus: null, newPhone: null, source: "As on the answer", why: null });
  sameAsAnswer(e, offer);
});

test("a covered repair: the store's cost is the estimate at list price, not the customer's ₹0", () => {
  const { e, offer } = run({ condition: cond({ issues: ["battery"] }), faults: ["battery_drain"], coverage: "warranty" });
  assert.equal(offer.repair.amount, 0, "the customer's repair is free under warranty");
  assert.equal(e.repairCost.amount, 2_760 + 425 + Math.round(((2_760 + 425) * 1800) / 10_000));
  assert.equal(e.repairCost.source, "SwapUp's repair estimate: battery ₹2,760 + labour + GST");
});

test("a covered part with no book price: the store's cost is missing with why, never the customer's covered price", () => {
  // The speaker has no price on this model. Cover makes it free to the customer, but the store
  // still pays for the part, so there is no figure to count — and no "Repair before pickup".
  for (const coverage of ["warranty", "care_plus"] as const) {
    const { e, offer } = run({ condition: cond({ issues: ["speaker"] }), faults: ["speaker"], coverage });
    assert.equal(offer.repair.amount, 0, `${coverage}: the customer's repair is still free`);
    assert.deepEqual(e.repairCost, { amount: null, basis: null, source: null, why: "No book price for Speaker — enter the store's repair cost." }, coverage);
    assert.deepEqual(e.uplift, { amount: null, verdict: null, text: null, why: "Needs the repair cost." }, coverage);
  }
  // Mixed warranty: the back glass is charged, the speaker covered with no price. The customer's
  // figure counts only the back glass; the store's cost would be short by the speaker, so none.
  const mixed = run({ condition: cond({ body: "back_cracked", issues: ["speaker"] }), faults: ["back_cracked", "speaker"], coverage: "warranty" }).e;
  assert.deepEqual(mixed.repairCost, { amount: null, basis: null, source: null, why: "No book price for Speaker — enter the store's repair cost." });
  assert.equal(mixed.uplift.amount, null);
  // The store's own figure still wins.
  const typed = run({ condition: cond({ issues: ["speaker"] }), faults: ["speaker"], coverage: "warranty", refurbCost: { amount: 1_200, by: "Ravi" } }).e;
  assert.deepEqual([typed.repairCost.amount, typed.repairCost.basis], [1_200, "store"]);
});

test("the post-repair value is the price list's only: a PriceIQ trade-in, or a card no longer on file, gives none", () => {
  const priceiq: OfferQuote = { status: "priced", amount: 30_000, source: { kind: "priceiq" }, partnerRef: null, lines: [{ label: "Refurbished market price (Superb) · PriceIQ", amount: 36_000 }] };
  const p = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], quote: priceiq }).e;
  assert.equal(p.preRefurb.amount, 30_000);
  assert.deepEqual(p.postRepair, { amount: null, grade: null, source: null, why: NOT_FROM_PRICE_LIST });
  assert.equal(p.uplift.why, "Needs the post-repair value.");
  const gone = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], card: null }).e;
  assert.equal(gone.preRefurb.amount, 29_710);
  assert.deepEqual(gone.postRepair, { amount: null, grade: null, source: null, why: PRICE_LIST_GONE });
});

test("the trace line: a card row without grade columns starts from its best-condition price", () => {
  assert.equal(
    cardTraceLine(
      [
        { label: "Best-condition price on the rate card", amount: 24_000 },
        { label: "Screen: Lines, spots or dead pixels", bp: 3500, amount: -8_400 },
        { label: "Body: Light scuffs", bp: 300, amount: -720 },
        { label: "No original box", bp: 200, amount: -480 },
        { label: "Rounded down to ₹10", amount: 0 },
      ],
      null
    ),
    "priced at the best-condition price ₹24,000, less 35% screen lines or spots, 3% light scuffs and 2% no original box"
  );
  assert.equal(cardTraceLine([], "Good"), null);
  // Nothing taken off: the figure beside it is the price, so the line names the grade only.
  assert.equal(cardTraceLine([{ label: "Market price grade B · Week 42", amount: 33_574 }], "Good"), "grade B price");
  assert.equal(cardTraceLine([{ label: "Best-condition price on the rate card", amount: 24_000 }], null), "best-condition price");
});
