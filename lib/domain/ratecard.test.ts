import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFromCard, linesSum, gradePricesProblem, entryGradePrices, type RateCard } from "./ratecard.ts";
import { HEALTHY, type ConditionAnswers } from "./condition.ts";
import { CARD } from "./fixtures.ts";

/**
 * The per-grade rate card (owner, 2026-10-19: the buyback partner's own grade ladder, "rate card
 * now, PriceIQ later"). The S23 Ultra 256GB row of the week-42 sheet: max (A) 34,960 · good (B)
 * 33,574 · fair (C) 32,255 · best value (D) 30,672.
 */
const GRADED: RateCard = {
  ...CARD,
  source: { kind: "partner_ratecard", label: "Week 42", effectiveFrom: "2026-10-12" },
  entries: [
    { modelId: "galaxy-s23-ultra", variant: "256GB", maxPrice: 34_960, gradePrices: { Good: 33_574, Fair: 32_255, "Best Value": 30_672 } },
    // Only the top two grades listed: a Fair phone has no column at or below it.
    { modelId: "galaxy-s23", variant: "128GB", maxPrice: 20_000, gradePrices: { Good: 19_000 } },
    // Max and best value only: a Good phone falls to the next LOWER listed grade, never up to max.
    { modelId: "galaxy-s24", variant: "256GB", maxPrice: 40_000, gradePrices: { "Best Value": 35_000 } },
    // An old 3-column row.
    { modelId: "galaxy-s22", variant: "8/128", maxPrice: 24_000 },
  ],
};
const ALL = { accessories: { charger: true, box: true, bill: true }, age: "lt3m" as const };
const c = (over: Partial<ConditionAnswers> = {}): ConditionAnswers => ({ ...HEALTHY, issues: [], ...ALL, ...over });
const q = (model: string, variant: string, a: ConditionAnswers) => {
  const r = priceFromCard(GRADED, model, variant, a);
  assert.equal(r.status, "priced");
  return r as Extract<typeof r, { status: "priced" }>;
};

test("per-grade card: the price at the phone's look — A max, B good, C fair, D best value — with no look deducted again", () => {
  const rows: [Partial<ConditionAnswers>, number, string][] = [
    [{}, 34_960, "Superb"],
    [{ body: "scuffed" }, 33_574, "Good"],
    [{ screen: "scratched" }, 33_574, "Good"],
    [{ body: "dented" }, 32_255, "Fair"],
    [{ body: "bent" }, 30_672, "Best Value"],
  ];
  for (const [over, price, grade] of rows) {
    const r = q("galaxy-s23-ultra", "256GB", c(over));
    // The card's own cash step still applies (₹10, rounded down).
    assert.equal(r.amount, Math.floor(price / 10) * 10, JSON.stringify(over));
    assert.equal(r.grade, grade);
    assert.equal(r.ceiling, price);
    assert.ok(!r.lines.some((l) => /^(Screen|Body):/.test(l.label)), "a look is the grade's, never a deduction too");
  }
  assert.deepEqual(q("galaxy-s23-ultra", "256GB", c({ body: "dented" })).lines, [
    { label: "Market price grade C · Week 42", amount: 32_255 },
    { label: "Rounded down to ₹10", amount: -5 },
  ]);
});

test("per-grade card: every non-look defect is taken off once, on top of the grade's price", () => {
  // Dented (grade C) with a cracked screen and a faulty speaker, no charger, 3–11 months old.
  const a = c({ body: "dented", screen: "cracked", issues: ["speaker"], accessories: { charger: false, box: true, bill: true }, age: "3to11m" });
  const r = q("galaxy-s23-ultra", "256GB", a);
  const d = GRADED.deductions;
  const labels = r.lines.map((l) => l.label);
  assert.deepEqual(labels.slice(0, 5), ["Market price grade C · Week 42", "Screen: Cracked glass", "Speaker faulty", "No original charger", "Age: 3 – 11 months"]);
  const off = [d.screen.cracked, d.issues.speaker, d.noChargerBp, d.age["3to11m"]].reduce((s, bp) => s + Math.floor((32_255 * bp) / 10_000), 0);
  assert.equal(r.amount, Math.floor((32_255 - off) / 10) * 10);
  assert.equal(linesSum(r.lines), r.amount);
  // A cracked back is a defect too: priced at the look (Superb) less the back's %.
  const back = q("galaxy-s23-ultra", "256GB", c({ body: "back_cracked" }));
  assert.equal(back.grade, "Superb");
  assert.ok(back.lines.some((l) => l.label === "Body: Back glass cracked"));
  // A dead phone is priced on that alone, from its grade's price.
  const dead = q("galaxy-s23-ultra", "256GB", c({ powersOn: false, body: "dented" }));
  assert.deepEqual(dead.lines.slice(0, 2).map((l) => l.label), ["Market price grade C · Week 42", "Does not switch on (priced as non-working)"]);
});

test("per-grade card: an empty grade column falls to the next LOWER listed grade — never a higher one; none below → today's max − look %", () => {
  // S24: Good has no column; Best Value is the next one down.
  const s24 = q("galaxy-s24", "256GB", c({ body: "scuffed" }));
  assert.equal(s24.grade, "Best Value");
  assert.equal(s24.amount, 35_000);
  // S23: a Fair phone, no Fair or Best Value column → max less the card's dent %, as every card did before.
  const s23 = q("galaxy-s23", "128GB", c({ body: "dented" }));
  assert.equal(s23.grade, undefined);
  assert.equal(s23.lines[0].label, "Best-condition price on the rate card");
  assert.ok(s23.lines.some((l) => l.label === "Body: Dents on the frame"));
});

test("3-column back-compat: a row without grade prices prices exactly as before", () => {
  for (const a of [c(), c({ body: "dented", screen: "cracked" }), c({ powersOn: false })]) {
    const before = priceFromCard({ ...CARD }, "galaxy-s22", "8/128", a);
    const now = priceFromCard(GRADED, "galaxy-s22", "8/128", a);
    assert.deepEqual(now, before);
    assert.equal(now.status === "priced" && now.grade, undefined);
  }
});

test("validation: max ≥ good ≥ fair ≥ best value over the columns present, each a whole rupee ≥ 1", () => {
  const e = (gradePrices: Record<string, number>, maxPrice = 34_960) => ({ modelId: "m", variant: "v", maxPrice, gradePrices });
  assert.equal(gradePricesProblem(e({ Good: 33_574, Fair: 32_255, "Best Value": 30_672 })), null);
  assert.equal(gradePricesProblem(e({ Fair: 34_960 })), null, "equal is fine");
  assert.equal(gradePricesProblem({ modelId: "m", variant: "v", maxPrice: 100 }), null);
  assert.match(gradePricesProblem(e({ Good: 35_000 }))!, /Good price \(35000\) is above the Superb price/);
  assert.match(gradePricesProblem(e({ Good: 30_000, "Best Value": 31_000 }))!, /Best Value price \(31000\) is above the Good price/);
  assert.match(gradePricesProblem(e({ Fair: 0 }))!, /whole rupee/);
  assert.match(gradePricesProblem(e({ Fair: 1.5 }))!, /whole rupee/);
  assert.match(gradePricesProblem(e({ Fair: Number.NaN }))!, /whole rupee/);
  assert.deepEqual(entryGradePrices(e({ Fair: 32_000 })).map((x) => x.grade), ["Superb", "Fair"]);
});
