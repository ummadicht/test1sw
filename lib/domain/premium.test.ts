import { test } from "node:test";
import assert from "node:assert/strict";
import { exchange, premiumBp, premiumOn, NEW_PHONE_TOO_CHEAP, PREMIUM_BANDS, PREMIUM_RULE_VERSION } from "./premium.ts";
import { SELL_MARKDOWN } from "./marketSell.ts";
import { pctOf } from "./money.ts";
import { RuleError } from "./errors.ts";

/** We pay you = the market price + the premium. */
const W = (m: number) => m + (premiumOn(m)?.amount ?? 0);

test("premium: the owner's example — market price ₹25,000 → ₹1,000 premium (4%), we pay ₹26,000", () => {
  assert.deepEqual(premiumOn(25_000), { amount: 1_000, bp: 400, rule: PREMIUM_RULE_VERSION, edge: null });
  assert.equal(W(25_000), 26_000);
  assert.equal(PREMIUM_RULE_VERSION, "2026-10-18.1");
});

test("premium: the literal bands are the sell markdown's (5% ≤ ₹15,000 · 4% ≤ ₹30,000 · 3% ≤ ₹50,000 · 2% above), upper edges inclusive", () => {
  assert.deepEqual(PREMIUM_BANDS, [
    { upTo: 15_000, bp: 500 },
    { upTo: 30_000, bp: 400 },
    { upTo: 50_000, bp: 300 },
    { upTo: null, bp: 200 },
  ]);
  assert.equal(PREMIUM_BANDS, SELL_MARKDOWN, "one table: changing one is a visible decision");
  const at = (m: number) => [premiumBp(m), premiumOn(m)!.amount];
  assert.deepEqual(at(14_999), [500, 749]);
  assert.deepEqual(at(15_000), [500, 750]);
  assert.deepEqual(at(30_000), [400, 1_200]);
  assert.deepEqual(at(50_000), [300, 1_500]);
  assert.deepEqual(at(1_20_000), [200, 2_400]);
});

test("premium: no band-edge dip — just above an edge, we pay what the edge pays (owner Q1, resolved)", () => {
  // The literal band would pay ₹15,601 on ₹15,001 against ₹15,750 on ₹15,000: lifted to the edge's.
  assert.deepEqual(premiumOn(15_001), { amount: 749, bp: 400, rule: PREMIUM_RULE_VERSION, edge: 15_000 });
  assert.equal(W(15_001), W(15_000));
  assert.equal(W(30_001), W(30_000));
  assert.equal(W(50_001), W(50_000));
  assert.ok(exchange({ market: 15_001, bonus: 0, newPrice: 1_00_000 }).wePay >= exchange({ market: 15_000, bonus: 0, newPrice: 1_00_000 }).wePay);
  // Once the band's own % pays more, the guard steps aside.
  assert.equal(premiumOn(16_000)!.edge, null);
  assert.equal(premiumOn(16_000)!.amount, 640);
});

test("premium: floored to the rupee — never a rupee the ledger can't pay", () => {
  assert.equal(premiumOn(14_990)!.amount, 749); // 749.5
  assert.equal(premiumOn(33_333)!.amount, 999); // 999.99
  for (const m of [1, 7, 99, 1_234, 14_990, 33_333, 77_777]) assert.ok(Number.isInteger(premiumOn(m)!.amount), String(m));
});

test("premium: no market price, no premium", () => {
  for (const m of [null, undefined, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(premiumOn(m as number), null, String(m));
});

test("exchange: the one formula — we pay = market + premium, the line holds the market price, the programme pays premium + bonus", () => {
  const x = exchange({ market: 25_000, bonus: 6_199, newPrice: 1_54_999 });
  assert.deepEqual(x, { premium: 1_000, premiumBp: 400, wePay: 26_000, hold: 25_000, claim: 7_199, customerPays: 1_22_800 });
  // The store's books, cleared: customer + partner + programme = the new phone.
  assert.equal(x.customerPays + x.hold + x.claim, 1_54_999);
});

test("exchange: no price, no exchange — and a new phone cheaper than we pay + the bonus is refused, never floored", () => {
  for (const market of [0, -1, 1.5, Number.NaN]) assert.throws(() => exchange({ market, bonus: 0, newPrice: 50_000 }), RuleError);
  assert.throws(() => exchange({ market: 25_000, bonus: 6_199, newPrice: 32_198 }), (e: Error) => e instanceof RuleError && e.message === NEW_PHONE_TOO_CHEAP);
  assert.equal(exchange({ market: 25_000, bonus: 6_199, newPrice: 32_199 }).customerPays, 0);
  assert.equal(NEW_PHONE_TOO_CHEAP, "The new phone costs less than we pay plus the bonus — choose another phone.");
});

test("property: random market prices, bonuses and new phones — the premium stays in its band, adds up, and never dips", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ms: number[] = [];
  for (let i = 0; i < 5_000; i++) ms.push(1 + Math.floor(rnd() * 3_00_000));
  for (const edge of [15_000, 30_000, 50_000]) for (let d = -3; d <= 3; d++) ms.push(edge + d);
  for (const M of ms) {
    const p = premiumOn(M)!;
    assert.ok(p.amount >= pctOf(M, premiumBp(M)), `${M}: at least the band's own %`);
    assert.ok(p.amount >= 0 && p.amount <= Math.floor((M * 500) / 10_000), `${M}: 0 ≤ P ≤ 5%`);
    const B = Math.floor(rnd() * 8_000);
    const N = M + p.amount + B + Math.floor(rnd() * 1_50_000);
    const x = exchange({ market: M, bonus: B, newPrice: N });
    assert.equal(x.premium, p.amount);
    assert.equal(x.wePay, M + p.amount);
    assert.equal(x.hold, M);
    assert.equal(x.claim, p.amount + B);
    assert.equal(x.customerPays + x.wePay + B, N);
    // The programme's claim is exactly what the customer got off beyond the market price.
    assert.ok(x.claim <= N - x.customerPays - M);
  }
  // "We pay you" never falls when the market price rises — checked at every rupee up to ₹3,00,000.
  let last = 0;
  for (let M = 1; M <= 3_00_000; M++) {
    const w = W(M);
    assert.ok(w >= last, `we pay dips at ₹${M}`);
    last = w;
  }
});

test("premium: the source of the market price does not matter — the rule takes only the amount", () => {
  // premiumOn has no source input at all; buildOffer's per-source table (answer.test.ts) checks the same M gives the same P.
  assert.equal(premiumOn.length, 1);
});

test("premium: edge + 1 is the next band's % (its bp), lifted to the edge's rupees — 15,001 · 30,001 · 50,001", () => {
  for (const [m, bp, amount] of [[15_001, 400, 749], [30_001, 300, 1_199], [50_001, 200, 1_499]] as const) {
    assert.deepEqual(premiumOn(m), { amount, bp, rule: PREMIUM_RULE_VERSION, edge: m - 1 });
    assert.equal(W(m), W(m - 1));
  }
  // The lift ends where the band's own % catches up with the edge (₹15,145 × 4% → ₹15,750 again), and never sooner.
  let m = 15_001;
  while (premiumOn(m)!.edge !== null) m++;
  assert.equal(m, 15_145);
  assert.equal(W(m), W(15_000));
  assert.ok(W(m + 25) > W(15_000));
});
