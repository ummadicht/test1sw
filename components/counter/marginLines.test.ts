import { test } from "node:test";
import { namesBrand } from "../../lib/domain/testing/brand.ts";
import assert from "node:assert/strict";
import { sellSourceLine, sellSub } from "./marginLines.ts";

const LISTED = { amount: 31360, listing: 32000, grade: "Good", gradeWanted: "Good", markdownBp: 200 };

test("the sell line names the refurbished market and PriceIQ — never the partner's brand", () => {
  assert.equal(sellSourceLine(LISTED), "Refurbished market price ₹32,000 (Good) − 2% · PriceIQ");
  assert.equal(sellSourceLine({ ...LISTED, gradeWanted: "Superb", markdownBp: 350 }), "Refurbished market price ₹32,000 (Good) − 3.5% · PriceIQ · none at Superb");
  assert.ok(!namesBrand(sellSourceLine(LISTED)));
  // Old market data: its age on the line.
  assert.equal(
    sellSourceLine({ ...LISTED, week: "2026-W35", ageDays: 52, stale: true }),
    "Refurbished market price ₹32,000 (Good) − 2% · PriceIQ · week 2026-W35, 52 days old"
  );
});

test("under 'Sell': the market listing, else the partner's repaired price, else why not", () => {
  const base = { sellWhy: "No quote yet.", repairedReason: null, manualQuote: false, partner: "Buyback Partner (demo)" };
  assert.equal(sellSub({ ...base, sellBasis: "market", market: LISTED }), "Refurbished market price ₹32,000 (Good) − 2% · PriceIQ");
  assert.equal(sellSub({ ...base, sellBasis: "partner", market: { amount: null, why: "PriceIQ has no refurbished market price for the Galaxy S23 Ultra 256GB." } }), "Partner's repaired price");
  assert.equal(sellSub({ ...base, sellBasis: "partner", market: { amount: null, why: null } }), "Partner's repaired price");
  assert.equal(sellSub({ ...base, sellBasis: null, market: { amount: null, why: null }, repairedReason: "Not available for this model." }), "Not available for this model.");
  assert.equal(sellSub({ ...base, sellBasis: null, market: { amount: null, why: null }, manualQuote: true }), "Not given — enter it from the partner app.");
  assert.equal(sellSub({ ...base, sellBasis: null, market: { amount: null, why: null } }), "No quote yet.");
});
