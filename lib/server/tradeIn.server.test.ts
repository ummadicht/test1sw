/**
 * The trade-in's source order through the REAL server services on a throwaway database, with a
 * stand-in PriceIQ on 127.0.0.1 (testing/fakePriceiq.ts): a quote typed from the partner's app
 * wins → PriceIQ's lowest listing at the grade, less the 5%→2% markdown, less SwapUp's % per
 * defect → the partner's uploaded rate card → "No market price yet — enter a quote". Never a
 * made-up price. The case quote is what the answer shows and what the lock holds on the credit line.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakePriceiq, isoWeek, S23U_256, type FakePriceiq } from "./testing/fakePriceiq.ts";
import { namesBrand } from "../domain/testing/brand.ts";

const dir = mkdtempSync(join(tmpdir(), "swapup-tradein-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
console.warn = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const cases = await import("./cases.ts");
const { uploadRateCard } = await import("./catalog.ts");
const { resetPriceiqState } = await import("./priceiq.ts");
const { linesSum, DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");

let fake: FakePriceiq;
before(async () => {
  fake = await startFakePriceiq({
    "Galaxy S23 Ultra|256": S23U_256, // 52 days old — the data on file today
    "Galaxy S23 Ultra|512": { grades: [{ grade: "Good", low: 58_599 }], ageDays: 3 },
    "Galaxy S24|256": { grades: [{ grade: "Superb", low: 49_999 }], ageDays: 100 }, // over 90 days: no price
    "Galaxy Z Fold6|256": { grades: [] }, // PriceIQ knows it, has no price
  });
  Object.assign(process.env, { PRICEIQ_BASE_URL: fake.url, PRICEIQ_API_KEY: fake.key });
});
after(async () => {
  console.log = origLog;
  console.warn = origWarn;
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
const userNamed = (username: string): U => {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`).get(username) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
};
const advisor = userNamed("advisor");
const s25u = db().prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = 'Galaxy S25 Ultra' ORDER BY price LIMIT 1`).get(advisor.orgId) as { id: string } | undefined;
const W52 = isoWeek(new Date(Date.now() - 52 * 86_400_000));
const AGE52 = `Refurbished market price, week ${W52}, 52 days old.`;

const COND = (over: Record<string, unknown> = {}) => ({
  powersOn: true,
  calls: true,
  screen: "flawless",
  body: "scuffed",
  issues: [] as string[],
  accessories: { charger: true, box: true, bill: true },
  age: "gt11m",
  ...over,
});

async function caseFor(modelId: string, variant: string, faults: string[], issues: string[], body = "scuffed") {
  const c = cases.createCase(advisor, { customerName: "Trade-in Test" });
  return cases.updateCase(advisor, c.id, { modelId, variant, faults, condition: COND({ issues, body }), ...(s25u ? { upgradeDeviceId: s25u.id } : {}) });
}

test("the contract's check: a flawless S23 Ultra 256GB gets a trade-in base of ₹53,499 (Superb), less 2%", async () => {
  const v = await caseFor("galaxy-s23-ultra", "256GB", [], [], "flawless");
  assert.equal(v.quote?.source.kind, "priceiq");
  assert.equal(v.quote?.priceiq?.listing, 53_499);
  assert.equal(v.quote?.priceiq?.grade, "Superb");
  assert.equal(v.quote?.amount, 52_420);
});

test("the owner's case: S23 Ultra 256GB, Good, rear camera failed, battery under 80% → PriceIQ Good − 2% − SwapUp's % for 2 defects, with the data's age", async () => {
  const v = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera", "battery_drain"], ["battery", "rear_camera"]);
  const q = v.quote!;
  assert.equal(q.status, "priced");
  assert.equal(q.source.kind, "priceiq");
  assert.equal(q.source.label, "PriceIQ · Good − defects");
  assert.deepEqual(
    q.lines.map((l) => [l.label, l.bp ?? null, l.amount]),
    [
      ["Refurbished market price (Good) · PriceIQ", null, 51_399],
      ["Below the market price", 200, -1_028],
      ["Battery drains / swollen", 900, -4_625],
      ["Rear camera faulty", 1_800, -9_251],
      ["Rounded down to ₹10", null, -5],
    ]
  );
  assert.equal(q.amount, 36_490);
  assert.equal(linesSum(q.lines), q.amount);
  assert.ok(q.validUntil, "a binding quote has a validity");
  assert.equal(q.priceiq?.grade, "Good");
  assert.equal(q.priceiq?.deductions, "SwapUp's % per defect");
  assert.equal(q.priceiq?.stale, true);
  assert.equal(q.priceiq?.ageDays, 52);
  // The repaired value is priced like the trade-in: the grade after refurb (Good — the scuffs stay),
  // the same markdown, nothing left to deduct. The store's sell price is that before the ₹10 step.
  assert.equal(v.repairedQuote?.source.kind, "priceiq");
  assert.equal(v.repairedQuote?.amount, 50_370);
  assert.equal(v.marketSell.amount, 50_371);
  assert.equal(v.marketSell.why === null && v.marketSell.note, AGE52, "the sell price says its age too");

  const w = v.offer!.swap;
  assert.equal(w.tradeIn, 36_490);
  assert.equal(w.tradeInDetail?.line, `Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ ${W52}, 52 days old`);
  assert.deepEqual(w.tradeInDetail?.lines, [
    { label: "Below the market price", pct: "2%", amount: -1_028 },
    { label: "Battery drains / swollen", pct: "9%", amount: -4_625 },
    { label: "Rear camera faulty", pct: "18%", amount: -9_251 },
    { label: "Rounded down to ₹10", pct: null, amount: -5 },
  ]);
  assert.equal(w.tradeInDetail?.note, null);
  assert.equal(w.tradeInNote, AGE52, "over 14 days old: shown WITH its age");
  assert.ok(s25u, "the seeded catalogue has the Galaxy S25 Ultra");
  assert.ok(w.bonus !== null && w.bonus > 0, "the upgrade bonus still applies");
  assert.equal(w.total, 36_490 + w.bonus!);
  // Old data is still a price: the lock is not blocked by its age.
  assert.ok(!v.lockBlockers.some((b) => /old|PriceIQ/i.test(b)), v.lockBlockers.join(" | "));
  // No partner's name on the answer, no "sample" anywhere.
  assert.ok(!namesBrand(JSON.stringify(v.offer)));
  assert.doesNotMatch(JSON.stringify(v.offer), /Buyback Partner|sample/i);
});

test("PriceIQ has no price and there is no rate card: no price at all — 'No market price yet — enter a quote', and why", async () => {
  const v = await caseFor("galaxy-z-fold6", "256GB", ["rear_camera"], ["rear_camera"]);
  const q = v.quote!;
  assert.equal(q.status, "unpriced");
  assert.equal(q.amount, null);
  assert.equal(q.source.kind, "none");
  assert.equal(q.reason, "No market price yet — enter a quote.");
  assert.equal(q.priceiqWhy, "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.");
  assert.equal(v.offer!.swap.tradeIn, null);
  assert.equal(v.offer!.swap.why, "No market price yet — enter a quote.");
  assert.deepEqual(v.offer!.asks.find((a) => a.kind === "partner_quote"), { kind: "partner_quote", title: "Enter the partner's quote", text: "No market price yet — enter a quote." });
  // Nothing to swap on: the answer refuses with the same words (and a quoted case's lock says "No trade-in price yet.").
  assert.equal(v.offer!.actions.swap, "No market price yet — enter a quote.");
  if (v.status === "quoted") assert.ok(v.lockBlockers.includes("No trade-in price yet."));
  assert.equal(v.marketSell.amount, null);
});

test("over 90 days old: no PriceIQ price — the partner's rate card answers if it lists the phone, and says why", async () => {
  const none = await caseFor("galaxy-s24", "256GB", [], [], "flawless");
  assert.equal(none.quote?.status, "unpriced");
  assert.match(none.quote?.priceiqWhy ?? "", /^PriceIQ's prices for the Galaxy S24 256GB are from \d{4}-W\d{2} \(100 days old\) — too old to price\.$/);
  // The partner uploads its own rate card: it prices what PriceIQ can't.
  const partner = userNamed("partner");
  uploadRateCard(partner, { label: "Partner sheet week 42", effectiveFrom: "2026-10-12", quoteValidityDays: 3, csv: "model_id,variant,max_price\ngalaxy-s24,256GB,40000\n", deductions: DEFECT_DEDUCTIONS, activate: true });
  try {
    const v = await cases.updateCase(advisor, none.id, { condition: COND({ body: "flawless", issues: ["rear_camera"] }) });
    assert.equal(v.quote?.status, "priced");
    assert.equal(v.quote?.source.kind, "partner_ratecard");
    assert.equal(v.quote?.lines[0].label, "Best-condition price on the rate card");
    assert.equal(v.offer!.swap.tradeInDetail?.line, null);
    assert.match(v.offer!.swap.tradeInDetail?.note ?? "", /too old to price\.$/);
    assert.equal(v.offer!.swap.tradeInNote, null);
    assert.equal(v.lockBlockers.filter((b) => /price/i.test(b)).length, 0, "a real partner price: nothing to block");
  } finally {
    db().prepare(`UPDATE rate_cards SET active = 0`).run();
  }
});

test("the PriceIQ repaired value keeps deducting what the repair doesn't explain (a ticked Wi-Fi issue beside a camera fault)", async () => {
  const v = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera"], ["rear_camera", "wifi_bt"]);
  assert.equal(v.quote?.source.kind, "priceiq");
  assert.equal(v.repairedQuote?.source.kind, "priceiq");
  assert.ok(v.repairedQuote!.lines.some((l) => /Wi-Fi/.test(l.label)), "the Wi-Fi deduction stays on the repaired value");
  assert.ok(!v.repairedQuote!.lines.some((l) => /camera/i.test(l.label)), "the camera repair heals its own deduction");
  assert.ok(v.repairedQuote!.amount! < 50_370);
});

test("a quote typed from the partner's app still wins over PriceIQ", async () => {
  const v0 = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera"], ["rear_camera"]);
  const v = await cases.updateCase(advisor, v0.id, { partnerQuote: { amount: 41_000, reference: "PQ-12345" } });
  assert.equal(v.quote?.source.kind, "partner_manual");
  assert.equal(v.quote?.amount, 41_000);
  assert.deepEqual(v.offer!.swap.tradeInDetail, { line: null, lines: [], note: null });
  // Removing it hands the price back to PriceIQ.
  const back = await cases.updateCase(advisor, v0.id, { partnerQuote: null });
  assert.equal(back.quote?.source.kind, "priceiq");
});

test("storage unknown: each size's chip is priced the way the trade-in will be, asked together, with the data's age under them", async () => {
  const c = cases.createCase(advisor, { customerName: "Chips" });
  const v = await cases.updateCase(advisor, c.id, { modelId: "galaxy-s23-ultra", faults: [], condition: COND() });
  const ask = v.offer!.asks.find((a) => a.kind === "storage");
  assert.ok(ask && ask.kind === "storage");
  const by = Object.fromEntries(ask.options.map((o) => [o.variant, o.tradeIn]));
  assert.equal(by["256GB"], 50_370);
  assert.equal(by["512GB"], 57_420); // Good 58,599 − 2% = 57,427.02 → 57,427 → ₹57,420
  assert.equal(ask.note, AGE52, "a chip's price rests on 52-day-old data: said under the chips");
  assert.ok(ask.options.every((o) => !("sample" in o)));
  const picked = await cases.updateCase(advisor, c.id, { variant: "256GB" });
  assert.equal(picked.quote?.amount, by["256GB"], "the chip and the answer agree");
});

test("PriceIQ not connected (no key): no price — never a guess — and the trace says why", async () => {
  const keep = process.env.PRICEIQ_API_KEY;
  delete process.env.PRICEIQ_API_KEY;
  try {
    const v = await caseFor("galaxy-s23-ultra", "512GB", [], []);
    assert.equal(v.quote?.status, "unpriced");
    assert.equal(v.quote?.reason, "No market price yet — enter a quote.");
    assert.equal(v.quote?.priceiqWhy, "No refurbished market price yet — PriceIQ isn't connected.");
    assert.equal(v.marketSell.amount, null);
    assert.equal(v.marketSell.why, "No refurbished market price yet — PriceIQ isn't connected.");
  } finally {
    process.env.PRICEIQ_API_KEY = keep;
  }
});

test("PriceIQ down at quote time: the last good answer prices it, labelled", async () => {
  const v0 = await caseFor("galaxy-s23-ultra", "512GB", [], []);
  assert.equal(v0.quote?.amount, 57_420);
  db().prepare(`UPDATE market_listings SET fetched_at = ? WHERE variant = '512GB'`).run(new Date(Date.now() - 2 * 3_600_000).toISOString());
  fake.mode = "down";
  try {
    const v = await cases.updateCase(advisor, v0.id, { condition: COND({ issues: ["speaker"] }) });
    assert.equal(v.quote?.source.kind, "priceiq");
    assert.match(v.offer!.swap.tradeInNote ?? "", /^PriceIQ unreachable, last answer \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/);
  } finally {
    fake.mode = "ok";
    resetPriceiqState();
  }
});

test("a quote stored by an older build from a source that no longer exists is never used: lapsed, re-asked on the next re-price", async () => {
  const v0 = await caseFor("galaxy-s23-ultra", "256GB", [], []);
  const retired = { ...v0.quote!, source: { kind: "sample", label: "an older build's illustrative card" }, validUntil: new Date(Date.now() + 86_400_000).toISOString(), priceiq: undefined };
  db().prepare(`UPDATE cases SET quote = ? WHERE id = ?`).run(JSON.stringify(retired), v0.id);
  const seen = cases.getCase(advisor, v0.id);
  assert.equal(seen.quoteExpired, true);
  assert.ok(seen.lockBlockers.some((b) => /expired/.test(b)), seen.lockBlockers.join(" | "));
  const re = await cases.reprice(advisor, v0.id);
  assert.equal(re.quote?.source.kind, "priceiq");
  assert.equal(re.quoteExpired, false);
});

test("the partner never gets the store's SELL price or its answer: no PriceIQ listing, markdown or repaired value, no decision, no repair figures", async () => {
  const v = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera", "battery_drain"], ["battery", "rear_camera"]);
  assert.equal(v.quote?.source.kind, "priceiq");
  const sell = v.marketSell.amount!;
  const listing = v.quote!.priceiq!.listing;
  assert.ok(sell && listing && v.decision && v.repair && v.repairedQuote, "staff have every figure");
  const p = cases.forViewer(userNamed("partner"), v);
  assert.equal(p.decision, null);
  assert.equal(p.repair, null);
  assert.equal(p.manualRepair, null);
  assert.equal(p.offer, null);
  assert.equal(p.repairedQuote, null, "a PriceIQ repaired value is the store's own figure");
  assert.deepEqual(p.quote?.lines, [{ label: "Trade-in", amount: v.quote!.amount }]);
  assert.equal(p.quote?.priceiq, undefined);
  assert.equal(p.quote?.amount, v.quote!.amount, "the trade-in itself is the partner's business");
  const numbers = JSON.stringify(p).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  for (const n of [sell, listing, v.repairedQuote!.amount!, v.marketSell.amount!]) assert.ok(!numbers.includes(n), `${n} must not reach the partner`);
  assert.doesNotMatch(JSON.stringify(p), /Refurbished market price|Below the market price/);
});
