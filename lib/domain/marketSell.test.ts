import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeAfterRefurb, markdownBp, marketSell, resolveModel, sellFromListing, variantFromCapacity } from "./marketSell.ts";

test("markdown: 5% on cheap phones down to 2% on dear ones, band edges inclusive", () => {
  assert.equal(markdownBp(9_999), 500);
  assert.equal(markdownBp(15_000), 500);
  assert.equal(markdownBp(15_001), 400);
  assert.equal(markdownBp(30_000), 400);
  assert.equal(markdownBp(30_001), 300);
  assert.equal(markdownBp(50_000), 300);
  assert.equal(markdownBp(50_001), 200);
  assert.equal(markdownBp(150_000), 200);
});

test("sell from a listing rounds DOWN — never promise a rupee more than the listing allows", () => {
  assert.deepEqual(sellFromListing(12_999), { amount: 12_349, markdownBp: 500, markdown: 650 }); // 12349.05
  assert.deepEqual(sellFromListing(54_799), { amount: 53_703, markdownBp: 200, markdown: 1_096 }); // 53703.02
  for (const p of [999, 15_000, 29_999, 49_999, 61_099]) {
    const s = sellFromListing(p);
    assert.ok(s.amount < p && s.amount + s.markdown === p);
  }
});

test("grade after refurb: what the refurb repairs comes out like new; what it doesn't keeps the grade down", () => {
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "flawless" }), "Superb");
  assert.equal(gradeAfterRefurb({ screen: "cracked", body: "flawless" }), "Superb");
  assert.equal(gradeAfterRefurb({ screen: "scratched", body: "flawless" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "scuffed" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "back_cracked" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "scratched", body: "dented" }), "Fair");
  assert.equal(gradeAfterRefurb({ screen: "not_working", body: "bent" }), "Best Value");
  assert.equal(gradeAfterRefurb(null), null);
});

const rows = [
  { grade: "Superb", price: 57_099, week: "2026-W35" },
  { grade: "Superb", price: 53_499, week: "2026-W35" },
  { grade: "Good", price: 54_799, week: "2026-W35" },
  { grade: "Good", price: 51_399, week: "2026-W35" },
  { grade: "Best Value", price: 47_199, week: "2026-W35" },
];

test("market sell: the LOWEST listing at the phone's grade, less the markdown", () => {
  const s = marketSell({ rows, condition: { screen: "flawless", body: "scuffed" }, label: "Galaxy S23 Ultra 256GB" });
  assert.equal(s.why, null);
  if (s.why !== null) return;
  assert.equal(s.grade, "Good");
  assert.equal(s.gradeWanted, "Good");
  assert.equal(s.listing, 51_399);
  assert.equal(s.listings, 2);
  assert.equal(s.markdownBp, 200);
  assert.equal(s.amount, 50_371);
});

test("market sell: no listing at the grade → the next LOWER grade, named; never a higher one", () => {
  const s = marketSell({ rows, condition: { screen: "flawless", body: "dented" }, label: "Galaxy S23 Ultra 256GB" });
  assert.equal(s.why, null);
  if (s.why !== null) return;
  assert.equal(s.gradeWanted, "Fair");
  assert.equal(s.grade, "Best Value");
  assert.equal(s.listing, 47_199);

  const onlyBetter = marketSell({ rows: rows.filter((r) => r.grade === "Superb"), condition: { screen: "flawless", body: "dented" }, label: "X" });
  assert.equal(onlyBetter.amount, null);
  assert.match(onlyBetter.why ?? "", /only above "Fair"/);
});

test("market sell: missing condition or no PriceIQ rows say why instead of guessing", () => {
  assert.equal(marketSell({ rows, condition: null, label: "X" }).amount, null);
  const none = marketSell({ rows: [], condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 128GB" });
  assert.equal(none.amount, null);
  assert.match(none.why ?? "", /no Cashify refurbished price for the Galaxy S23 128GB/);
});

const catalogue = [
  { id: "a14", brand: "Samsung", model: "Galaxy A14" },
  { id: "a14-5g", brand: "Samsung", model: "Galaxy A14 5G" },
  { id: "a33", brand: "Samsung", model: "Galaxy A33" },
  { id: "flip7", brand: "Samsung", model: "Galaxy Z Flip7" },
  { id: "flip7fe", brand: "Samsung", model: "Galaxy Z Flip7 FE" },
  { id: "s23", brand: "Samsung", model: "Galaxy S23" },
  { id: "s23u", brand: "Samsung", model: "Galaxy S23 Ultra" },
  { id: "s25p", brand: "Samsung", model: "Galaxy S25+" },
];

test("resolve: spacing and case don't matter; a different model never matches", () => {
  assert.equal(resolveModel("Samsung", "Galaxy Z Flip 7", catalogue), "flip7");
  assert.equal(resolveModel("Samsung", "Galaxy Z Flip7 FE 5G", catalogue), "flip7fe");
  assert.equal(resolveModel("Samsung", "Galaxy S23 Ultra 5G", catalogue), "s23u");
  assert.equal(resolveModel("Samsung", "Galaxy S23 FE", catalogue), null);
  assert.equal(resolveModel("Samsung", "Galaxy S25", catalogue), null, "S25 is not S25+");
  assert.equal(resolveModel("Apple", "Galaxy S23", catalogue), null, "brand must match");
});

test("resolve: a 5G suffix is ignored only when it can't pick the wrong one of a pair", () => {
  assert.equal(resolveModel("Samsung", "Galaxy A33 5G", catalogue), "a33");
  assert.equal(resolveModel("Samsung", "Galaxy A14 5G", catalogue), "a14-5g");
  assert.equal(resolveModel("Samsung", "Galaxy A14", catalogue), "a14");
});

test("capacity → variant; a RAM figure is not a storage size", () => {
  assert.equal(variantFromCapacity("256"), "256GB");
  assert.equal(variantFromCapacity(128), "128GB");
  assert.equal(variantFromCapacity("1024"), "1TB");
  assert.equal(variantFromCapacity("12"), null);
  assert.equal(variantFromCapacity("8"), null);
});
