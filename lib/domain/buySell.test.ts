import { test } from "node:test";
import assert from "node:assert/strict";
import { buySell, marketSource } from "./buySell.ts";

const priced = (amount: number) => ({ status: "priced" as const, amount });
const noMarket = { amount: null, why: "PriceIQ has no refurbished market price for the Galaxy S23 256GB." };

test("buy vs sell: PriceIQ's marked-down refurbished-market listing is the sell price; the estimate is at list price", () => {
  const r = buySell({
    quote: priced(12_500),
    repairedQuote: priced(19_000),
    refurbCost: null,
    repair: { status: "quoted", customerPays: 0, listTotal: 4_200 },
    faultCount: 1,
    market: { amount: 21_119, why: null, grade: "Good", gradeWanted: "Good", listing: 21_999, markdownBp: 400 },
    partner: "Buyback Partner (demo)",
  });
  assert.equal(r.buy, 12_500);
  assert.equal(r.refurb, 4_200, "a covered repair still costs the store its list price");
  assert.equal(r.refurbBasis, "estimate");
  assert.equal(r.sell, 21_119);
  assert.equal(r.sellBasis, "market");
  assert.equal(r.sellSource, "Refurbished market price ₹21,999 (Good) − 4% · PriceIQ");
  assert.equal(r.margin, 21_119 - 12_500 - 4_200);
  assert.equal(r.marginWhy, null);
});

test("buy vs sell: no PriceIQ listing → the partner's repaired price, named as such", () => {
  const r = buySell({ quote: priced(12_500), repairedQuote: priced(19_000), refurbCost: null, repair: { status: "quoted", customerPays: 4_200 }, faultCount: 1, market: noMarket });
  assert.equal(r.sell, 19_000);
  assert.equal(r.sellBasis, "partner");
  assert.equal(r.sellSource, "Partner's repaired price");
  assert.equal(r.refurb, 4_200, "no list total (a manual repair quote) → what the customer would pay");
  assert.equal(r.margin, 2_300);
});

test("buy vs sell: the advisor's refurb cost wins over the estimate, and a loss is negative", () => {
  const r = buySell({ quote: priced(12_500), repairedQuote: priced(19_000), refurbCost: { amount: 8_000 }, repair: { status: "quoted", customerPays: 4_200 }, faultCount: 1, market: noMarket });
  assert.equal(r.refurb, 8_000);
  assert.equal(r.refurbBasis, "quote");
  assert.equal(r.margin, -1_500);
});

test("buy vs sell: nothing to repair costs ₹0", () => {
  const r = buySell({ quote: priced(20_000), repairedQuote: priced(20_000), refurbCost: null, repair: null, faultCount: 0, market: null });
  assert.equal(r.refurb, 0);
  assert.equal(r.refurbBasis, "none");
  assert.equal(r.margin, 0);
});

test("buy vs sell: missing numbers stay missing and say why — no margin is guessed", () => {
  const none = buySell({ quote: null, repairedQuote: null, refurbCost: null, repair: null, faultCount: 2, market: null });
  assert.equal(none.buy, null);
  assert.equal(none.buyWhy, "No quote yet.");
  assert.equal(none.sell, null);
  assert.equal(none.sellWhy, "No quote yet.");
  assert.equal(none.refurb, null);
  assert.equal(none.refurbWhy, "No repair estimate — enter the refurb cost.");
  assert.equal(none.margin, null);
  assert.equal(none.marginWhy, "Needs the buy price, the refurb cost and the sell price.");

  const noRepaired = buySell({
    quote: priced(9_000),
    repairedQuote: null,
    refurbCost: null,
    repair: { status: "needs_inspection", customerPays: null },
    faultCount: 1,
    market: noMarket,
    partner: "Buyback Partner (demo)",
  });
  assert.equal(noRepaired.sellWhy, noMarket.why, "PriceIQ's own reason is the one shown");
  assert.equal(noRepaired.refurbWhy, "Needs a bench diagnosis — enter the refurb cost.");
  assert.equal(noRepaired.sellSource, null);
  assert.equal(noRepaired.margin, null);
  assert.equal(noRepaired.marginWhy, "Needs the refurb cost and the sell price.");

  const unpriced = buySell({ quote: { status: "unpriced", amount: null }, repairedQuote: { status: "unpriced", amount: null }, refurbCost: { amount: 0 }, repair: null, faultCount: 1, market: null, partner: "Buyback Partner (demo)" });
  assert.equal(unpriced.buyWhy, "No price from Buyback Partner (demo) for this phone.");
  assert.equal(unpriced.sellWhy, "No repaired price from Buyback Partner (demo).");
  assert.equal(unpriced.refurb, 0, "a ₹0 figure is a real number, not a missing one");
  assert.equal(unpriced.marginWhy, "Needs the buy price and the sell price.");
});

test("buy vs sell: the sell line names the refurbished market and PriceIQ, and a lower grade it fell back to", () => {
  assert.equal(marketSource({ grade: "Good", gradeWanted: "Superb", listing: 52_499, markdownBp: 200 }), "Refurbished market price ₹52,499 (Good) − 2% · PriceIQ · none at Superb");
  assert.equal(marketSource({ grade: "Fair", gradeWanted: "Fair", listing: 9_999, markdownBp: 500 }), "Refurbished market price ₹9,999 (Fair) − 5% · PriceIQ");
  const r = buySell({ quote: priced(9_000), repairedQuote: null, refurbCost: null, repair: { status: "unpriced", customerPays: null }, faultCount: 1, market: null });
  assert.equal(r.refurbWhy, "A part has no price — enter the refurb cost.");
  const none = buySell({ quote: priced(9_000), repairedQuote: null, refurbCost: null, repair: null, faultCount: 1, market: null });
  assert.equal(none.refurbWhy, "No repair estimate — enter the refurb cost.");
});
