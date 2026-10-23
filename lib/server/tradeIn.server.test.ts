/**
 * The trade-in's source order through the REAL server services on a throwaway database, with a
 * stand-in PriceIQ on 127.0.0.1 (testing/fakePriceiq.ts): PriceIQ's lowest listing at the grade,
 * less the 5%→2% markdown, less SwapUp's % per defect → the partner's uploaded rate card → no
 * price, "No market price yet" with the reason why. Never a made-up price, never a typed one. The
 * case quote is what the answer shows and what the lock holds on the credit line.
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
const { luhnCheckDigit } = await import("../domain/imei.ts");

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
  // We pay = the market price + the SwapUp premium (3% up to ₹50,000); the total adds the bonus.
  assert.deepEqual(w.premium, { amount: 1_094, bp: 300 });
  assert.equal(w.total, 36_490 + 1_094 + w.bonus!);
  // Old data is still a price: the lock is not blocked by its age.
  assert.ok(!v.lockBlockers.some((b) => /old|PriceIQ/i.test(b)), v.lockBlockers.join(" | "));
  // No partner's name on the answer, no "sample" anywhere.
  assert.ok(!namesBrand(JSON.stringify(v.offer)));
  // (The staff note may say "the buyback partner's quote" — the role, never the partner org's name.)
  assert.doesNotMatch(JSON.stringify(v.offer), /Buyback Partner \(demo\)|sample/i);
});

test("PriceIQ has no price and there is no rate card: no price at all — 'No market price yet' and PriceIQ's own why, text only", async () => {
  const v = await caseFor("galaxy-z-fold6", "256GB", ["rear_camera"], ["rear_camera"]);
  const q = v.quote!;
  const why = "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.";
  assert.equal(q.status, "unpriced");
  assert.equal(q.amount, null);
  assert.equal(q.source.kind, "none");
  assert.equal(q.reason, why, "PriceIQ was asked and said why: its why is the reason");
  assert.equal(q.priceiqWhy, why);
  assert.equal(v.offer!.swap.tradeIn, null);
  assert.equal(v.offer!.swap.why, why);
  assert.deepEqual(v.offer!.asks.find((a) => a.kind === "no_price"), { kind: "no_price", title: "No market price yet", text: why });
  assert.ok(!v.offer!.asks.some((a) => (a.kind as string) === "partner_quote"), "the old kind is gone: an installed app drops what it doesn't know");
  // Nothing to swap on: the answer refuses with the same words, and so does the lock (never the plain "No trade-in price yet.").
  assert.equal(v.offer!.actions.swap, why);
  assert.equal(v.offer!.actions.walkAway, null, "the customer can still walk away");
  if (v.status === "quoted") assert.ok(v.lockBlockers.includes(why), v.lockBlockers.join(" | "));
  assert.equal(v.marketSell.amount, null);
});

test("an active rate card that doesn't list the phone: 'This phone isn't on the rate card yet.' — the card's reason, not PriceIQ's", async () => {
  const partner = userNamed("partner");
  uploadRateCard(partner, { label: "Partner sheet one row", effectiveFrom: "2026-10-12", quoteValidityDays: 3, csv: "model_id,variant,max_price\ngalaxy-s24,256GB,40000\n", deductions: DEFECT_DEDUCTIONS, activate: true });
  try {
    const v = await caseFor("galaxy-z-fold6", "256GB", [], []);
    assert.equal(v.quote?.status, "unpriced");
    assert.equal(v.quote?.reason, "This phone isn't on the rate card yet.");
    assert.equal(v.offer!.reason, "This phone isn't on the rate card yet.");
    assert.equal(v.offer!.headline, "No market price yet");
    // At the counter (a cracked screen the repair prices, so the case is "quoted", with its IMEI): the
    // lock refuses with that reason too — its 409, which anything showing the lock's own error prints.
    const c = cases.createCase(advisor, { customerName: "Off the card" });
    const body = "35395031234567";
    const ready = await cases.updateCase(advisor, c.id, {
      modelId: "galaxy-z-fold6",
      variant: "256GB",
      imei: body + String(luhnCheckDigit(body)),
      faults: ["screen_cracked"],
      condition: COND({ screen: "cracked" }),
      ...(s25u ? { upgradeDeviceId: s25u.id } : {}),
    });
    assert.equal(ready.status, "quoted");
    assert.equal(ready.quote?.reason, "This phone isn't on the rate card yet.");
    assert.equal(ready.lockBlockers[0], "This phone isn't on the rate card yet.", ready.lockBlockers.join(" | "));
    assert.ok(!ready.lockBlockers.includes("No trade-in price yet."));
    const CHECKS = { ownership: true, simRemoved: true, imeiMatches: true, noFinanceLock: true, kym: { status: "clear" as const, reference: "SS-1" } };
    assert.throws(
      () => cases.lockTradeIn(advisor, c.id, { customer: { name: "Asha Rao", phone: "9820012345", idType: "aadhaar", idLast4: "1234" }, checks: CHECKS }),
      (e: Error & { status?: number }) => e.status === 409 && e.message === "This phone isn't on the rate card yet."
    );
    assert.equal(cases.getCase(advisor, c.id).status, "quoted", "nothing locked");
  } finally {
    db().prepare(`UPDATE rate_cards SET active = 0`).run();
  }
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

test("a typed trade-in price is refused before anything is saved — the price stays the system's; partnerQuote null changes nothing", async () => {
  const v0 = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera"], ["rear_camera"]);
  assert.equal(cases.PRICE_NOT_TYPED, "Prices can't be typed in — change what's wrong to change the price.");
  const before = db().prepare(`SELECT * FROM cases WHERE id = ?`).get(v0.id);
  for (const partnerQuote of [{ amount: 41_000, reference: "PQ-12345" }, { amount: 41_000, reference: "PQ-12345", repairedAmount: 50_000 }, "41000", 0]) {
    // With a real change beside it: nothing of the patch is saved, not even the faults.
    await assert.rejects(cases.updateCase(advisor, v0.id, { faults: [], partnerQuote } as never), (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, cases.PRICE_NOT_TYPED);
      return true;
    });
  }
  assert.deepEqual(db().prepare(`SELECT * FROM cases WHERE id = ?`).get(v0.id), before, "the case is exactly as it was");
  // null — an older app's "Remove" — is a silent no-op: the system's price stands.
  const same = await cases.updateCase(advisor, v0.id, { partnerQuote: null });
  assert.equal(same.quote?.source.kind, "priceiq");
  assert.equal(same.quote?.amount, v0.quote?.amount);
  assert.equal((db().prepare(`SELECT partner_manual FROM cases WHERE id = ?`).get(v0.id) as { partner_manual: string | null }).partner_manual, null);
});

test("an unpriced case is asked again on a plain re-price: a rate card uploaded since prices it, with nobody touching the case", async () => {
  const c = cases.createCase(advisor, { customerName: "Card later" });
  const v0 = await cases.updateCase(advisor, c.id, { modelId: "galaxy-s24", variant: "256GB", faults: [], condition: COND({ body: "flawless" }) });
  assert.equal(v0.quote?.status, "unpriced");
  const chips0 = await cases.updateCase(advisor, cases.createCase(advisor, { customerName: "Chips later" }).id, { modelId: "galaxy-s24", faults: [], condition: COND({ body: "flawless" }) });
  const chipAsk0 = chips0.offer!.asks.find((a) => a.kind === "storage");
  assert.ok(chipAsk0?.kind === "storage" && chipAsk0.options.every((o) => o.tradeIn === null), "no size priced yet");
  const partner = userNamed("partner");
  uploadRateCard(partner, { label: "Partner sheet later", effectiveFrom: "2026-10-12", quoteValidityDays: 3, csv: "model_id,variant,max_price\ngalaxy-s24,256GB,40000\n", deductions: DEFECT_DEDUCTIONS, activate: true });
  try {
    // The desk asks for that re-quote when either case opens (AnswerCard, once per open).
    const { autoRequoteKey } = await import("../../components/counter/answerAsks.ts");
    assert.ok(autoRequoteKey(cases.getCase(advisor, c.id)), "the unpriced quote");
    assert.ok(autoRequoteKey(cases.getCase(advisor, chips0.id)), "the chips, none priced");
    // The desk's quiet re-quote on open, and the store app's: a plain reprice (requote:false).
    const v = await cases.reprice(advisor, c.id);
    assert.equal(v.quote?.status, "priced");
    assert.equal(v.quote?.source.kind, "partner_ratecard");
    assert.equal(v.offer!.asks.some((a) => a.kind === "no_price"), false);
    // The storage chips, all unpriced before, are asked again the same way.
    const chips = await cases.reprice(advisor, chips0.id);
    const chipAsk = chips.offer!.asks.find((a) => a.kind === "storage");
    assert.ok(chipAsk?.kind === "storage" && chipAsk.options.some((o) => o.variant === "256GB" && o.tradeIn !== null), JSON.stringify(chipAsk));
    // A priced, unexpired quote is not asked again on a plain re-price.
    const again = await cases.reprice(advisor, c.id);
    assert.equal(again.quote?.quotedAt, v.quote?.quotedAt);
  } finally {
    db().prepare(`UPDATE rate_cards SET active = 0`).run();
  }
});

test("conditions change the price: a fault the camera confirmed is removed only with a reason — the desk's resend saves it, by name, and re-prices", async () => {
  const { heldForReason, withCameraReason } = await import("../../components/counter/answerAsks.ts");
  const { blankCameraCheck } = await import("../domain/gradeiqMap.ts");
  const v0 = await caseFor("galaxy-s23-ultra", "256GB", ["rear_camera"], ["rear_camera"]);
  const camera = { ...blankCameraCheck(new Date().toISOString()), state: "ready", faults: [{ id: "rear_camera", because: "Lens cracked", photoIndex: 1, confidence: 0.9 }] };
  db().prepare(`UPDATE cases SET camera_check = ? WHERE id = ?`).run(JSON.stringify(camera), v0.id);
  const WHY = 'Camera confirmed "Rear camera faulty", photo 2 — removing it needs a reason.';
  // The desk's tap on the fault: refused 409 with the camera's sentence, nothing saved.
  const patch = { faults: [], condition: COND({ issues: [] }) };
  let refused = "";
  await assert.rejects(cases.updateCase(advisor, v0.id, patch), (e: Error & { status?: number }) => {
    assert.equal(e.status, 409);
    refused = e.message;
    return true;
  });
  assert.equal(refused, WHY);
  assert.deepEqual(cases.getCase(advisor, v0.id).faults, ["rear_camera"]);
  // The desk keeps that change for one reason field; too short is refused the same way.
  const held = heldForReason(patch, refused);
  assert.ok(held);
  await assert.rejects(cases.updateCase(advisor, v0.id, withCameraReason(held.patch, "ok")), (e: Error & { status?: number }) => e.status === 409);
  const v = await cases.updateCase(advisor, v0.id, withCameraReason(held.patch, "  Lens protector cracked, camera tested fine  "));
  assert.deepEqual(v.faults, []);
  assert.equal(v.quote?.source.kind, "priceiq");
  assert.ok(v.quote!.amount! > v0.quote!.amount!, "the rear camera's deduction comes off: the condition moved the price");
  assert.ok(!v.quote!.lines.some((l) => /camera/i.test(l.label)));
  assert.deepEqual(
    v.camera?.overrides.map((o) => [o.by, o.reason, o.items]),
    [[advisor.name, "Lens protector cracked, camera tested fine", ["fault:rear_camera"]]]
  );
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
    assert.equal(v.quote?.reason, "No rate card is active yet.", "PriceIQ wasn't asked, and no card is active");
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

/* ─────────────────────────── SUP-29: the condition names its fault ─────────────────────────── */

test("SUP-29: a cracked screen set on the condition alone ticks its fault — the screen repair is quoted, never 'Nothing to repair' — and the trade-in is the same", async () => {
  const flawless = COND({ body: "flawless" });
  const cracked = COND({ body: "flawless", screen: "cracked" });
  const c = cases.createCase(advisor, { customerName: "Condition Only" });
  const v0 = await cases.updateCase(advisor, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition: flawless, ...(s25u ? { upgradeDeviceId: s25u.id } : {}) });
  assert.equal(v0.offer!.repair.nothingToRepair, true);
  // The condition editor's own save: the condition, and nothing else.
  const v = await cases.updateCase(advisor, c.id, { condition: cracked });
  assert.deepEqual(v.faults, ["screen_cracked"]);
  assert.deepEqual(v.faultSources, { screen_cracked: ["condition"] }, "the condition's own fault: the condition can take it back");
  assert.deepEqual(v.conditionProblems, []);
  assert.equal(v.repair?.status, "quoted");
  assert.deepEqual(v.repair!.lines.map((l) => [l.part, l.faults]), [["display", ["screen_cracked"]]]);
  assert.equal(v.repair!.customerPays, Math.round((28_470 + 425) * 1.18), "Samsung's display + S-series labour + GST");
  assert.equal(v.offer!.repair.nothingToRepair, false);
  assert.equal(v.offer!.repair.amount, v.repair!.customerPays);
  assert.notEqual(v.offer!.headline, "Nothing to repair — a straight trade-in");
  assert.notEqual(v.decision?.recommendation, "no_repair");
  assert.ok(v.offer!.answer.lines.some((l) => l.key === "repair"), "the answer carries the repair line");

  // The trade-in is what the condition alone priced before: the same condition with no fault, re-priced.
  db().prepare(`UPDATE cases SET faults = '[]', fault_sources = '{}' WHERE id = ?`).run(c.id);
  const old = await cases.reprice(advisor, c.id, { requote: true });
  assert.equal(old.offer!.repair.nothingToRepair, true, "the old way: no fault, nothing to repair");
  assert.equal(v.quote?.status, "priced");
  assert.equal(v.quote?.amount, old.quote?.amount);
  assert.deepEqual(v.quote?.lines, old.quote?.lines);
  // …and what ticking "Cracked screen" itself gives.
  const t = cases.createCase(advisor, { customerName: "Fault Ticked" });
  const viaFault = await cases.updateCase(advisor, t.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: ["screen_cracked"], condition: cracked });
  assert.equal(v.quote?.amount, viaFault.quote?.amount);
  assert.equal(v.repair?.customerPays, viaFault.repair?.customerPays);
});

test("SUP-29: lines, a cracked back and a faulty part set on the condition each bring their fault; looks bring none; a fault list sent with it is taken as sent", async () => {
  const c = cases.createCase(advisor, { customerName: "Condition Only 2" });
  await cases.updateCase(advisor, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition: COND({ body: "flawless" }) });
  const looks = await cases.updateCase(advisor, c.id, { condition: COND({ screen: "scratched", body: "dented" }) });
  assert.deepEqual(looks.faults, [], "scratches and dents are looks, not repairs");
  assert.equal(looks.offer!.repair.nothingToRepair, true);
  const v = await cases.updateCase(advisor, c.id, { condition: COND({ screen: "lines_or_spots", body: "back_cracked" }) });
  assert.deepEqual(v.faults, ["display_lines", "back_cracked"]);
  assert.equal(v.repair?.status, "quoted");
  assert.deepEqual(v.repair!.lines.map((l) => l.part).sort(), ["back_cover", "display"]);
  // A part the book has no price for: the centre's quote is asked for — never "Nothing to repair".
  const spk = await cases.updateCase(advisor, c.id, { condition: COND({ screen: "lines_or_spots", body: "back_cracked", issues: ["speaker"] }) });
  assert.deepEqual(spk.faults, ["display_lines", "back_cracked", "speaker"]);
  assert.equal(spk.repair?.status, "unpriced");
  assert.ok(spk.offer!.asks.some((a) => a.kind === "repair_quote"));
  assert.notEqual(spk.offer!.headline, "Nothing to repair — a straight trade-in");
  // "Nothing wrong" on the fault list sends the faults with the condition they leave: taken as sent.
  const none = await cases.updateCase(advisor, c.id, { faults: [], condition: COND({ body: "flawless" }) });
  assert.deepEqual(none.faults, []);
  assert.equal(none.offer!.repair.nothingToRepair, true);
});

test("SUP-29 review: a crack tapped by mistake is undone in the condition editor — cracked, then flawless: no fault, the condition as set, nothing to repair, the same trade-in", async () => {
  const good = COND({ body: "flawless", screen: "flawless" });
  const c = cases.createCase(advisor, { customerName: "Mis-tap" });
  const v0 = await cases.updateCase(advisor, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition: good, ...(s25u ? { upgradeDeviceId: s25u.id } : {}) });
  assert.equal(v0.offer!.repair.nothingToRepair, true);
  assert.equal(v0.quote?.status, "priced");

  // The mis-tap: the crack brings its fault, the condition's own.
  const cracked = await cases.updateCase(advisor, c.id, { condition: COND({ body: "flawless", screen: "cracked" }) });
  assert.deepEqual(cracked.faults, ["screen_cracked"]);
  assert.deepEqual(cracked.faultSources, { screen_cracked: ["condition"] });
  assert.equal(cracked.offer!.repair.nothingToRepair, false);
  assert.notEqual(cracked.quote?.amount, v0.quote?.amount, "priced as a cracked phone");

  // Undone where it was made: the fault goes with the answer, and the case is the phone before the mis-tap.
  const v = await cases.updateCase(advisor, c.id, { condition: good });
  assert.deepEqual(v.faults, []);
  assert.deepEqual(v.faultSources, {});
  assert.equal(v.condition?.screen, "flawless");
  assert.deepEqual(v.conditionProblems, []);
  assert.equal(v.offer!.repair.nothingToRepair, true);
  assert.equal(v.offer!.repair.amount, v0.offer!.repair.amount);
  assert.equal(v.offer!.headline, v0.offer!.headline);
  assert.equal(v.quote?.status, "priced");
  assert.equal(v.quote?.amount, v0.quote?.amount);
  assert.deepEqual(v.quote?.lines, v0.quote?.lines);
  const fresh = cases.getCase(advisor, c.id);
  assert.deepEqual(fresh.faults, []);
  assert.deepEqual(fresh.faultSources, {});

  // Cracked, then meant "Lines / spots": the one fault swapped for the other.
  await cases.updateCase(advisor, c.id, { condition: COND({ body: "flawless", screen: "cracked" }) });
  const lines = await cases.updateCase(advisor, c.id, { condition: COND({ body: "flawless", screen: "lines_or_spots" }) });
  assert.deepEqual(lines.faults, ["display_lines"]);
  assert.deepEqual(lines.faultSources, { display_lines: ["condition"] });
  assert.deepEqual(lines.conditionProblems, []);

  // A back or an issue chip the same way; another fault the condition named stays.
  const more = await cases.updateCase(advisor, c.id, { condition: COND({ body: "back_cracked", screen: "lines_or_spots", issues: ["mic", "speaker"] }) });
  assert.deepEqual(more.faults, ["display_lines", "back_cracked", "mic", "speaker"]);
  const less = await cases.updateCase(advisor, c.id, { condition: COND({ body: "flawless", screen: "lines_or_spots", issues: ["mic"] }) });
  assert.deepEqual(less.faults, ["display_lines", "mic"]);
  assert.deepEqual(less.conditionProblems, []);

  // Ticked on the fault list: the advisor's, never the condition's to take back — a better answer is still refused.
  await cases.updateCase(advisor, c.id, { faults: ["screen_cracked"], condition: COND({ body: "flawless", screen: "cracked" }) });
  const ticked = await cases.updateCase(advisor, c.id, { condition: good });
  assert.deepEqual(ticked.faults, ["screen_cracked"]);
  assert.deepEqual(ticked.faultSources, { screen_cracked: ["advisor"] });
  assert.ok(ticked.conditionProblems.length > 0, "the condition is better than a ticked fault allows");
});
