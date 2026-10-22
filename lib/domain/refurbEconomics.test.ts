import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refurbEconomics, cardTraceLine, NOTHING_TO_REPAIR, NOT_FROM_PRICE_LIST, PRICE_LIST_GONE, type RefurbEconomics } from "./refurbEconomics.ts";
import { buildOffer, type OfferInput, type OfferQuote } from "./offer.ts";
import { priceFromCard, DEFECT_DEDUCTIONS, DEFECT_RULES, NOT_ON_CARD, type RateCard } from "./ratecard.ts";
import { estimateRepair, type Coverage, type RepairBookEntry } from "./repair.ts";
import { HEALTHY, healedCondition, type ConditionAnswers, type FaultId } from "./condition.ts";

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

test("(a) cracked back, screen flawless: grade A less 15%, the back glass repaired — the post-repair grade is B, so send as-is", () => {
  const { e, offer } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"] });
  assert.deepEqual(e.preRefurb, { amount: 29_710, grade: "A", source: "grade A ₹34,960 − 15% back glass cracked", why: null });
  assert.deepEqual(e.repairCost, { amount: 4_596, basis: "estimate", source: "SwapUp's repair estimate: back glass / cover ₹3,470 + labour ₹425 + GST ₹701", why: null });
  // SUP-92's example assumed grade A (₹34,960) once repaired, for +₹654. healedCondition — the one
  // healing rule the repaired value, the answer's grade line and the report all read — heals a
  // cracked back only as far as "scuffed" (a new back panel on a frame we haven't seen bare), so the
  // card prices it at grade B, and the answer already shows this phone as "Current grade B".
  assert.equal(healedCondition(cond({ body: "back_cracked" }), ["back_cracked"]).body, "scuffed");
  assert.deepEqual(e.postRepair, { amount: 33_574, grade: "B", source: "grade B price", why: null });
  assert.deepEqual(e.uplift, { amount: -732, verdict: "as_is", text: "Send as-is — repairing costs ₹732 more than it adds", why: null });
  assert.deepEqual(e.offer, { amount: 30_898, bonus: 4_649, newPhone: "Galaxy S26 Ultra 256GB", source: "+ ₹4,649 bonus with the Galaxy S26 Ultra 256GB", why: null });
  assert.equal(offer.answer.grade?.letter, "B", "the answer's grade line says the same grade the phone comes out at");
  sameAsAnswer(e, offer);
});

test("(b) cracked screen: the display costs more than it adds — send as-is", () => {
  const { e, offer } = run({ condition: cond({ screen: "cracked" }), faults: ["screen_cracked"] });
  assert.deepEqual(e.preRefurb, { amount: 20_970, grade: "A", source: "grade A ₹34,960 − 40% screen cracked", why: null });
  assert.deepEqual(e.repairCost, {
    amount: 34_096,
    basis: "estimate",
    source: "SwapUp's repair estimate: display assembly ₹28,470 + labour ₹425 + GST ₹5,201",
    why: null,
  });
  assert.equal(e.repairCost.amount, offer.repair.amount, "the same estimate the customer's repair line uses");
  assert.deepEqual(e.postRepair, { amount: 34_960, grade: "A", source: "grade A price", why: null });
  assert.deepEqual(e.uplift, { amount: -20_106, verdict: "as_is", text: "Send as-is — repairing costs ₹20,106 more than it adds", why: null });
  assert.equal(e.offer.amount, 21_808);
  sameAsAnswer(e, offer);
});

test("(c) light wear, no faults: grade B, nothing to repair, the same price after", () => {
  const { e, offer } = run({ condition: cond({ screen: "scratched", body: "scuffed" }), faults: [] });
  assert.deepEqual(e.preRefurb, { amount: 33_574, grade: "B", source: "grade B price", why: null });
  assert.deepEqual(e.repairCost, { amount: 0, basis: "none", source: NOTHING_TO_REPAIR, why: null });
  assert.deepEqual(e.postRepair, { amount: 33_574, grade: "B", source: "grade B price", why: null });
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

/* ─────────────────────────── the edges ─────────────────────────── */

test("the store's own repair cost wins over SwapUp's estimate, and can turn the decision", () => {
  const { e } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], refurbCost: { amount: 2_000, by: "Ravi" } });
  assert.deepEqual(e.repairCost, { amount: 2_000, basis: "store", source: "The store's own figure, entered by Ravi", why: null });
  assert.deepEqual(e.uplift, { amount: 1_864, verdict: "repair", text: "Repair before pickup: +₹1,864", why: null });
  // Exactly even: no gain, so as-is.
  const even = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], refurbCost: { amount: 33_574 - 29_710, by: "Ravi" } }).e;
  assert.deepEqual([even.uplift.amount, even.uplift.verdict, even.uplift.text], [0, "as_is", "Send as-is — repairing only breaks even"]);
  // With no fault, a figure the store typed is still a cost against no gain.
  const cosmetic = run({ condition: cond({ body: "scuffed" }), faults: [], refurbCost: { amount: 500, by: "Ravi" } }).e;
  assert.deepEqual([cosmetic.repairCost.basis, cosmetic.uplift.amount, cosmetic.uplift.verdict], ["store", -500, "as_is"]);
});

test("a repair with no price: the repair cost is missing with why, and there is no uplift", () => {
  // Liquid damage needs a bench check; the post-repair value is still the card's price for it dried out.
  const wet = run({ condition: cond({ issues: ["liquid"] }), faults: ["water_damage"] }).e;
  assert.deepEqual(wet.repairCost, { amount: null, basis: null, source: null, why: "Bench check needed (Liquid damage) — enter the store's repair cost." });
  assert.deepEqual(wet.preRefurb, { amount: 19_220, grade: "A", source: "grade A ₹34,960 − 45% signs of liquid damage", why: null });
  assert.equal(wet.postRepair.amount, 34_960);
  assert.deepEqual(wet.uplift, { amount: null, verdict: null, text: null, why: "Needs the repair cost." });
  // A part the price book has no price for on this model.
  const speaker = run({ condition: cond({ issues: ["speaker"] }), faults: ["speaker"] }).e;
  assert.deepEqual(speaker.repairCost, { amount: null, basis: null, source: null, why: "No book price for Speaker — enter the store's repair cost." });
  assert.equal(speaker.uplift.amount, null);
});

test("wear the repair doesn't touch stays: a dented phone with a cracked screen comes out at grade C", () => {
  const { e } = run({ condition: cond({ screen: "cracked", body: "dented" }), faults: ["screen_cracked"] });
  assert.deepEqual(e.preRefurb, { amount: 19_350, grade: "C", source: "grade C ₹32,255 − 40% screen cracked", why: null });
  assert.deepEqual(e.postRepair, { amount: 32_255, grade: "C", source: "grade C price", why: null });
  assert.equal(e.uplift.amount, 32_255 - 19_350 - 34_096);
  // An issue no fault explains (no repair quoted for it) stays taken off after the repair.
  const wifi = run({ condition: cond({ screen: "cracked", issues: ["wifi_bt"] }), faults: ["screen_cracked"] }).e;
  assert.deepEqual(wifi.postRepair, { amount: 29_710, grade: "A", source: "grade A ₹34,960 − 15% Wi-Fi / Bluetooth faulty", why: null });
});

test("no new phone: the offer is what we pay, with no bonus", () => {
  const { e, offer } = run({ condition: cond({ body: "back_cracked" }), faults: ["back_cracked"], upgrade: false });
  assert.deepEqual(e.offer, { amount: 30_898, bonus: null, newPhone: null, source: null, why: null });
  sameAsAnswer(e, offer);
});

test("a covered repair: the store's cost is the estimate at list price, not the customer's ₹0", () => {
  const { e, offer } = run({ condition: cond({ issues: ["battery"] }), faults: ["battery_drain"], coverage: "warranty" });
  assert.equal(offer.repair.amount, 0, "the customer's repair is free under warranty");
  assert.equal(e.repairCost.amount, 2_760 + 425 + Math.round(((2_760 + 425) * 1800) / 10_000));
  assert.equal(e.repairCost.source, "SwapUp's repair estimate: battery ₹2,760 + labour + GST");
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
    "best-condition price ₹24,000 − 35% screen lines or spots − 3% light scuffs − 2% no original box"
  );
  assert.equal(cardTraceLine([], "Good"), null);
  // Nothing taken off: the figure beside it is the price, so the line names the grade only.
  assert.equal(cardTraceLine([{ label: "Market price grade B · Week 42", amount: 33_574 }], "Good"), "grade B price");
  assert.equal(cardTraceLine([{ label: "Best-condition price on the rate card", amount: 24_000 }], null), "best-condition price");
});
