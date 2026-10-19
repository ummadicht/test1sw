import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffer, expiredQuoteBlocker, type Offer, type OfferInput } from "./offer.ts";
import { decide, type DecisionInput } from "./decision.ts";
import { premiumOn } from "./premium.ts";
import { customerAnswer } from "./answer.ts";
import { estimateRepair, type Coverage, type RepairBookEntry } from "./repair.ts";
import { HEALTHY, type FaultId } from "./condition.ts";

/* ─────────────────────────── fixtures: the spec's worked example (§3.4) ─────────────────────────── */
// org_samsung_svc, the partner's rate card, the seeded campaign and the S23 Ultra price book;
// a cracked screen. Built with the real domain functions, the way reprice() builds them.

const S23U = "galaxy-s23-ultra";
const BOOK: RepairBookEntry[] = [
  { modelId: S23U, part: "display", price: 28470, source: { kind: "oem_public", label: "Samsung service price list" } },
  { modelId: S23U, part: "battery", price: 3200, source: { kind: "oem_public", label: "Samsung service price list" } },
];
const POLICY = { labour: 425, carePlusFee: 2349, gstBp: 1800 };
const repairFor = (faults: FaultId[], coverage: Coverage = "none", manual: { amount: number; reason: string } | null = null) =>
  estimateRepair({ book: BOOK, modelId: S23U, faults, coverage, policy: POLICY, manual: manual ? { ...manual, by: "Asha" } : null });

// As cases.ts stores it (UpgradeChoice): the label carries the brand; the answer names the phone without it.
const S26U = { deviceId: "nd_s26u_256", label: "Samsung Galaxy S26 Ultra 256GB", model: "Galaxy S26 Ultra", variant: "256GB", price: 154999, suggested: true, why: "Newest Galaxy S Ultra, same storage (256GB)." };
const CARD_QUOTE = { status: "priced" as const, amount: 18800, source: { kind: "partner_ratecard" as const }, partnerRef: null };
const BONUS = { amount: 6199, bp: 400, override: null };
const REPAIRED_VALUE = 34800;

/** decide() exactly as reprice() calls it: the as-is value is what we pay — the market price + the SwapUp premium. */
function decisionFor(o: Pick<OfferInput, "repair" | "quote" | "upgrade" | "bonus" | "faultCount" | "manualRepair">, repairedValue: number | null = REPAIRED_VALUE) {
  const repairPays = o.repair?.status === "quoted" ? o.repair.customerPays : null;
  const market = o.quote?.status === "priced" ? o.quote.amount : null;
  const premium = premiumOn(market)?.amount ?? 0;
  const asIs = market === null ? null : market + premium;
  const bonus = o.bonus ? (o.bonus.override?.amount ?? o.bonus.amount) : 0;
  const input: DecisionInput = {
    repairPays,
    repairCovered: o.repair?.status === "quoted" && o.repair.customerPays === 0 && o.repair.coverage !== "none" && o.repair.basis === "book",
    repairedValue: asIs === null ? null : repairedValue,
    asIsValue: asIs,
    premium,
    valueSource: o.quote?.source.kind ?? null,
    upgrade: o.upgrade ? { label: o.upgrade.label, newPrice: o.upgrade.price, bonus, supportEndYear: 2033 } : null,
    old: { ageYears: 3, supportEndYear: 2028 },
    thisYear: 2026,
    nothingToRepair: o.faultCount === 0 && !o.manualRepair,
    faultCount: o.faultCount,
  };
  return decide(input);
}

/** The S23 Ultra case after `PATCH {variant:"256GB"}` — every number priced. Overrides re-run decide(). */
function priced(over: Partial<OfferInput> = {}, repairedValue = REPAIRED_VALUE): OfferInput {
  const base: OfferInput = {
    status: "quoted",
    device: { label: "Samsung Galaxy S23 Ultra", variant: "256GB", variants: ["256GB", "512GB"] },
    variantSource: "advisor",
    storageQuotes: null,
    faultCount: 1,
    coverage: "none",
    repair: repairFor(["screen_cracked"]),
    manualRepair: null,
    repairNotServiced: null,
    quote: CARD_QUOTE,
    quoteExpired: false,
    quoteBlocked: null,
    conditionProblems: [],
    hasCondition: true,
    upgrade: S26U,
    bonus: BONUS,
    decision: null,
    ...over,
  };
  return { ...base, decision: "decision" in over ? over.decision! : decisionFor(base, repairedValue) };
}

/** Straight after Apply: the phone couldn't measure its storage, so no partner price yet. */
function storageUnknown(over: Partial<OfferInput> = {}): OfferInput {
  return priced({
    device: { label: "Samsung Galaxy S23 Ultra", variant: null, variants: ["256GB", "512GB"] },
    variantSource: null,
    // Out of order on purpose: the chips come back smallest first.
    storageQuotes: [
      { variant: "512GB", amount: 20300, reason: null },
      { variant: "256GB", amount: 18800, reason: null },
    ],
    quote: null,
    bonus: { amount: 4649, bp: 300, override: null },
    ...over,
  });
}

const allowed = (o: Offer) => o.actions;

/* ─────────────────────────── 1. everything priced ─────────────────────────── */

test("offer 1: fully priced — refurb quote vs trade-in + bonus, nothing to ask (the spec's §3.4 numbers)", () => {
  const o = buildOffer(priced());
  assert.equal(o.open, true);
  assert.deepEqual(o.asks, []);
  // The refurb quote — what the customer pays to fix it.
  assert.equal(o.repair.amount, 34096);
  assert.equal(o.repair.basis, "book");
  assert.equal(o.repair.covered, false);
  assert.equal(o.repair.detail, "Display assembly + labour + GST");
  assert.equal(o.repair.why, null);
  // The market price, the SwapUp premium on it (4%), what we pay, + bonus.
  assert.equal(o.swap.tradeIn, 18800);
  assert.deepEqual(o.swap.premium, { amount: 752, bp: 400 });
  assert.equal(o.swap.wePay, 18800 + 752);
  assert.equal(o.swap.bonus, 6199);
  assert.equal(o.swap.bonusBp, 400);
  assert.equal(o.swap.bonusWhy, null);
  assert.equal(o.swap.total, 25751);
  assert.equal(o.swap.total, o.swap.wePay! + o.swap.bonus!);
  assert.equal(o.swap.why, null);
  assert.deepEqual(o.swap.newPhone, { deviceId: "nd_s26u_256", label: "Galaxy S26 Ultra 256GB", price: 154999, suggested: true, why: "Newest Galaxy S Ultra, same storage (256GB)." });
  // What the customer pays is the lock's own formula (premium.ts exchange) — and decide() agrees.
  assert.equal(o.swap.customerPays, 154999 - 19552 - 6199);
  assert.equal(o.swap.customerPays, priced().decision!.upgrade!.pays);
  assert.equal(o.swap.vsRepair, 129248 - 34096);
  assert.equal(o.swap.tradeInNote, null, "a rate-card quote: nothing to mark");
  // The verdict is decide()'s, unchanged.
  assert.equal(o.recommendation, "either");
  assert.equal(o.recommended, null);
  assert.equal(o.headline, "Either works — customer's choice");
  assert.deepEqual(
    o.signals.map((s) => [s.points, s.strength]),
    [["repair", "soft"], ["upgrade", "soft"], ["upgrade", "soft"]]
  );
  assert.match(o.signals[0].text, /22% of a new phone's price/);
  assert.match(o.signals[1].text, /98% of the repaired phone's value/);
  // The money question compares what we pay (₹19,552), not the market price alone.
  assert.match(o.signals[2].text, /adds only ₹15,248/);
  assert.equal(o.reason, o.signals[0].text, "no strong signal: the first one");
  assert.ok(!o.caveats.some((c) => /sample/i.test(c)), "no price is ever called a sample");
  assert.deepEqual(allowed(o), { repair: null, swap: null, walkAway: null });
  assert.equal(o.storage.variant, "256GB");
  assert.equal(o.storage.source, "advisor");
  assert.equal(o.storage.note, null);
});

test("offer 1b: no money of the store's on the customer's answer", () => {
  const json = JSON.stringify(buildOffer(priced()));
  assert.ok(!/refurbCost|marketSell|margin/i.test(json));
});

/* ─────────────────────────── 2. storage unknown ─────────────────────────── */

test("offer 2: storage unknown — one row of chips, each with its trade-in price", () => {
  const input = storageUnknown();
  assert.equal(input.decision!.recommendation, "cannot_say");
  const o = buildOffer(input);
  assert.equal(o.headline, "Which storage is it?");
  assert.equal(o.reason, "The phone couldn't measure it — see Settings › About phone.");
  assert.equal(o.asks.length, 1);
  assert.deepEqual(o.asks[0], {
    kind: "storage",
    title: "Which storage is it?",
    text: "The phone couldn't measure it — see Settings › About phone.",
    options: [
      { variant: "256GB", tradeIn: 18800 },
      { variant: "512GB", tradeIn: 20300 },
    ],
    note: null,
  });
  assert.equal(o.swap.tradeIn, null);
  assert.equal(o.swap.total, null);
  assert.equal(o.swap.why, "Tap the storage to see the trade-in.");
  assert.equal(o.actions.swap, "Tap the storage to see the trade-in.");
  // The repair is priced, so the case is quoted and repair can be chosen.
  assert.equal(o.repair.amount, 34096);
  assert.equal(o.actions.repair, null);
  assert.equal(o.storage.variant, null);
  assert.equal(o.storage.source, null);
  // The suggestion is already there: the bonus shows, "customer pays" waits for the trade-in.
  assert.equal(o.swap.newPhone?.suggested, true);
  assert.equal(o.swap.customerPays, null);
});

test("offer 2b: no what-if prices — the model's sizes, unpriced, never a guess", () => {
  const o = buildOffer(storageUnknown({ storageQuotes: null }));
  const ask = o.asks[0];
  assert.equal(ask.kind, "storage");
  assert.deepEqual(ask.kind === "storage" && ask.options, [
    { variant: "256GB", tradeIn: null },
    { variant: "512GB", tradeIn: null },
  ]);
  assert.equal(ask.kind === "storage" && ask.note, null, "no price on screen, nothing to note");
  // A size nothing prices shows no price, still a chip.
  const partly = buildOffer(storageUnknown({ storageQuotes: [{ variant: "256GB", amount: 18800, reason: null }, { variant: "512GB", amount: null, reason: "No price" }] }));
  const p = partly.asks[0];
  assert.deepEqual(p.kind === "storage" && p.options, [
    { variant: "256GB", tradeIn: 18800 },
    { variant: "512GB", tradeIn: null },
  ]);
  assert.equal(p.kind === "storage" && p.note, null);
});

test("offer 2c: chips priced off old market data carry its age under them; a chip with no price carries nothing", () => {
  const AGE = "Refurbished market price, week 2026-W35, 52 days old.";
  const old = buildOffer(storageUnknown({ storageQuotes: [{ variant: "256GB", amount: 18800, reason: null, note: AGE }, { variant: "512GB", amount: 20300, reason: null, note: AGE }] }));
  const ask = old.asks[0];
  assert.equal(ask.kind === "storage" && ask.note, AGE);
  // Only a priced chip's note counts: an unpriced size says nothing about the others' data.
  const unpriced = buildOffer(storageUnknown({ storageQuotes: [{ variant: "256GB", amount: null, reason: "No price", note: AGE }, { variant: "512GB", amount: 20300, reason: null }] }));
  assert.equal(unpriced.asks[0].kind === "storage" && unpriced.asks[0].note, null);
  // No chip field the app could read as a sample flag.
  assert.ok(ask.kind === "storage" && ask.options.every((o) => Object.keys(o).sort().join() === "tradeIn,variant"));
});

/* ─────────────────────────── 2d. measured, but not a size on file ─────────────────────────── */

test("offer 2d: the phone measured a size the model's list doesn't have — said so, and no chip for another size", () => {
  const text = "Phone measures 1TB, not on file — check Settings, then enter the partner's quote.";
  // Even with what-if prices stored for 256/512GB: the phone has ruled them out.
  const o = buildOffer(storageUnknown({ measuredStorage: "1TB" }));
  assert.deepEqual(o.asks[0], { kind: "storage", title: "Which storage is it?", text, options: [], note: null });
  assert.equal(o.headline, "Which storage is it?");
  assert.equal(o.reason, text);
  assert.equal(o.swap.tradeIn, null);
  assert.equal(o.swap.why, text, "not 'Tap the storage' — there is nothing to tap");
  assert.equal(o.actions.swap, text);
  assert.ok(!/couldn't measure/.test(JSON.stringify(o)), "the phone did measure it");
  // A measured size that IS on the list but isn't on the case (staff changed or cleared it):
  // the ordinary chips, never "couldn't measure".
  const onList = buildOffer(storageUnknown({ measuredStorage: "512GB" }));
  const ask = onList.asks[0];
  assert.equal(ask.kind === "storage" && ask.options.length, 2);
  assert.equal(ask.text, "See Settings › About phone › Storage.");
  assert.equal(onList.swap.why, "Tap the storage to see the trade-in.");
  // The partner's quote entered for it settles the storage at the measured size (cases.ts updateCase):
  // from then on it is an ordinary priced answer.
  const settled = buildOffer(
    priced({
      device: { label: "Samsung Galaxy S23 Ultra", variant: "1TB", variants: ["256GB", "512GB"] },
      measuredStorage: "1TB",
      variantSource: "measured",
      quote: { status: "priced", amount: 52000, source: { kind: "partner_manual" }, partnerRef: "CF-1TB-01" },
    })
  );
  assert.deepEqual(settled.asks, []);
  assert.equal(settled.swap.tradeIn, 52000);
  assert.equal(settled.swap.tradeInNote, "Partner ref CF-1TB-01");
  assert.deepEqual(settled.storage, { variant: "1TB", source: "measured", note: null });
});

/* ─────────────────────────── 3. nothing to repair ─────────────────────────── */

test("offer 3: no faults — nothing to repair, a straight trade-in", () => {
  const o = buildOffer(priced({ faultCount: 0, repair: null }));
  assert.equal(o.recommendation, "no_repair");
  assert.equal(o.recommended, "swap");
  assert.equal(o.headline, "Nothing to repair — a straight trade-in");
  assert.equal(o.reason, "The test found nothing wrong.");
  assert.equal(o.repair.nothingToRepair, true);
  assert.equal(o.repair.amount, null);
  assert.equal(o.repair.why, "Nothing to repair.");
  assert.equal(o.actions.repair, "Nothing to repair.");
  assert.equal(o.actions.swap, null);
  assert.deepEqual(o.asks, [], "no repair quote asked for a phone with nothing wrong");
  // A support signal is still the reason when there is one.
  const old = priced({ faultCount: 0, repair: null });
  const signalled = buildOffer({ ...old, decision: { ...old.decision!, signals: [{ code: "support_ended", points: "upgrade", strength: "soft", text: "Security updates for this model ended in 2024." }] } });
  assert.equal(signalled.reason, "Security updates for this model ended in 2024.");
});

test("offer 3b: a desk-only case (no test applied) never says a test found or measured anything", () => {
  // No faults recorded on a case no phone test ran on: the verdict is decide()'s, the sentence is true.
  const o = buildOffer(priced({ faultCount: 0, repair: null, tested: false }));
  assert.equal(o.headline, "Nothing to repair — a straight trade-in");
  assert.equal(o.reason, "No faults on the case.");
  assert.ok(!/test/i.test(JSON.stringify({ headline: o.headline, reason: o.reason, asks: o.asks })));
  // A model but no storage yet: no phone was there to measure it.
  const s = buildOffer(storageUnknown({ tested: false }));
  assert.equal(s.asks[0].text, "See Settings › About phone › Storage.");
  assert.equal(s.reason, "See Settings › About phone › Storage.");
  // The chips and their prices are the same either way.
  assert.deepEqual(s.asks[0].kind === "storage" && s.asks[0].options.map((x) => x.tradeIn), [18800, 20300]);
  // A tested case keeps the test's words (and `tested` left out means tested).
  assert.equal(buildOffer(priced({ faultCount: 0, repair: null, tested: true })).reason, "The test found nothing wrong.");
  assert.equal(buildOffer(storageUnknown()).asks[0].text, "The phone couldn't measure it — see Settings › About phone.");
});

/* ─────────────────────────── 4. the book can't price it ─────────────────────────── */

test("offer 4: a bench-only fault asks for the repair quote, in the book's words", () => {
  const input = priced({ repair: repairFor(["water_damage"]) });
  const note = input.repair!.notes[0];
  assert.match(note, /Bench check needed/);
  const o = buildOffer(input);
  assert.deepEqual(o.asks, [{ kind: "repair_quote", title: "The repair needs a quote", text: note }]);
  assert.equal(o.headline, "The repair needs a quote");
  assert.equal(o.reason, note);
  assert.equal(o.repair.amount, null);
  assert.equal(o.repair.why, note);
  assert.equal(o.actions.repair, note);
  assert.equal(o.recommendation, "cannot_say");
  // A part the book has no price for: the same ask, the book's own note.
  const unpriced = priced({ repair: repairFor(["rear_camera"]) });
  assert.equal(unpriced.repair!.status, "unpriced");
  assert.deepEqual(buildOffer(unpriced).asks[0], { kind: "repair_quote", title: "The repair needs a quote", text: unpriced.repair!.notes[0] });
  // A brand the centre doesn't service: no estimate at all, the centre's own reason.
  const notServiced = "This centre repairs Samsung phones only. Enter the customer's own repair quote to compare.";
  const iphone = buildOffer(priced({ repair: null, repairNotServiced: notServiced }));
  assert.deepEqual(iphone.asks.find((a) => a.kind === "repair_quote")?.text, notServiced);
  assert.equal(iphone.repair.why, notServiced);
});

test("offer 4b: a bench quote entered — the quote is the refurb quote, said as a quote", () => {
  const manual = { amount: 9000, reason: "Bench quote at this centre" };
  const o = buildOffer(priced({ manualRepair: manual, repair: repairFor(["water_damage"], "none", manual) }));
  assert.equal(o.repair.amount, 9000);
  assert.equal(o.repair.basis, "manual");
  assert.equal(o.repair.detail, "Quote: Bench quote at this centre");
  assert.deepEqual(o.asks, []);
});

/* ─────────────────────────── 5. covered ─────────────────────────── */

test("offer 5: covered — ₹0, said as covered, and decide() recommends the repair", () => {
  const o = buildOffer(priced({ coverage: "warranty", repair: repairFor(["battery_drain"], "warranty") }));
  assert.equal(o.repair.amount, 0);
  assert.equal(o.repair.covered, true);
  assert.equal(o.repair.detail, "Covered by warranty");
  assert.equal(o.repair.coverage, "warranty");
  assert.equal(o.headline, "Repair it — it's covered");
  assert.equal(o.recommended, "repair");
  assert.equal(o.reason, "Covered — the customer pays nothing.");
  assert.equal(buildOffer(priced({ coverage: "care_plus", repair: repairFor(["battery_drain"], "care_plus") })).repair.detail, "Covered by Care+");
  // Care+ with accidental damage costs the plan fee: not "covered", the fee is in the detail.
  const fee = buildOffer(priced({ coverage: "care_plus", repair: repairFor(["screen_cracked"], "care_plus") }));
  assert.equal(fee.repair.amount, 2349);
  assert.equal(fee.repair.covered, false);
  assert.equal(fee.repair.detail, "Display assembly + Care+ fee");
});

/* ─────────────────────────── 6. the camera's identity block ─────────────────────────── */

test("offer 6: the camera's identity block comes first, ahead of the storage", () => {
  const blocked = "The camera says this may not be the phone on the case (model differs). It can't be priced until a store manager checks it and records why it is the right phone.";
  const o = buildOffer(storageUnknown({ quoteBlocked: blocked }));
  assert.deepEqual(o.asks.map((a) => a.kind), ["blocked", "storage"]);
  assert.deepEqual(o.asks[0], { kind: "blocked", title: "Check this is the right phone", text: blocked });
  assert.equal(o.headline, "Check this is the right phone");
  assert.equal(o.reason, blocked);
  assert.equal(o.swap.why, blocked);
  assert.equal(o.actions.swap, blocked);
  // Even a stored price is not shown while the camera says it may be another phone.
  const stale = buildOffer(priced({ quoteBlocked: blocked }));
  assert.equal(stale.swap.tradeIn, null);
  assert.equal(stale.swap.total, null);
  assert.deepEqual(stale.asks.map((a) => a.kind), ["blocked"], "not a partner_quote: the partner isn't the problem");
});

/* ─────────────────────────── 7. where the trade-in came from ─────────────────────────── */

test("offer 7: expired and partner-app quotes each say so", () => {
  const card = { ...CARD_QUOTE, source: { kind: "partner_ratecard" as const } };
  assert.equal(buildOffer(priced({ quote: card })).swap.tradeInNote, null);
  assert.equal(buildOffer(priced({ quote: card, quoteExpired: true })).swap.tradeInNote, "Quote expired — re-quoting.");
  const manual = { ...CARD_QUOTE, source: { kind: "partner_manual" as const }, partnerRef: "CF-88421" };
  assert.equal(buildOffer(priced({ quote: manual })).swap.tradeInNote, "Partner ref CF-88421");
  // SwapUp never re-quotes a quote read off the partner's app — so it never says it is re-quoting one (7d).
  assert.equal(buildOffer(priced({ quote: manual, quoteExpired: true })).swap.tradeInNote, "Partner quote (ref CF-88421) expired — enter today's quote.");
  // A closed case is never re-quoted: its quote running out after the lock is no news.
  assert.equal(buildOffer(priced({ status: "locked", quote: card, quoteExpired: true })).swap.tradeInNote, null);
  assert.equal(buildOffer(priced({ status: "locked", quote: manual, quoteExpired: true })).swap.tradeInNote, "Partner ref CF-88421");
});

test("offer 7d: a partner-app quote that has lapsed — marked, asked for again, and the swap refused until it is", () => {
  const text = "Partner quote (ref CF-88421) expired — enter today's quote.";
  const manual = { status: "priced" as const, amount: 18800, source: { kind: "partner_manual" as const }, partnerRef: "CF-88421" };
  const fresh = buildOffer(priced({ quote: manual }));
  assert.deepEqual(fresh.asks, []);
  assert.equal(fresh.actions.swap, null);
  const o = buildOffer(priced({ quote: manual, quoteExpired: true }));
  // The figure stays on screen for reference, marked — never passed off as today's.
  assert.equal(o.swap.tradeIn, 18800);
  assert.equal(o.swap.tradeInNote, text);
  assert.equal(o.swap.why, null, "there is a trade-in figure; the note says what is wrong with it");
  // One ask — the existing "Enter the partner's quote" sheet replaces it with a fresh validity.
  assert.deepEqual(o.asks, [{ kind: "partner_quote", title: "Enter the partner's quote", text }]);
  assert.equal(o.headline, "Enter the partner's quote");
  assert.equal(o.reason, text);
  // The Lock screen would refuse it and can't fix it there: refused here, with the reason.
  assert.equal(o.actions.swap, text);
  assert.equal(o.actions.repair, null, "the repair doesn't depend on the partner");
  // In the ask order: after storage/partner, before repair and new phone; and ahead of "Choose the new phone." on the swap.
  const both = buildOffer(priced({ quote: manual, quoteExpired: true, repair: repairFor(["water_damage"]), upgrade: null, bonus: null }));
  assert.deepEqual(both.asks.map((a) => a.kind), ["partner_quote", "repair_quote", "new_phone"]);
  assert.equal(both.actions.swap, text);
  // No reference on file: still said, never invented.
  assert.equal(buildOffer(priced({ quote: { ...manual, partnerRef: null }, quoteExpired: true })).swap.tradeInNote, "Partner quote (ref —) expired — enter today's quote.");
  // A lapsed rate-card quote is still SwapUp's to re-quote: no ask, the Lock screen's blocker.
  const card = buildOffer(priced({ quote: { ...manual, source: { kind: "partner_ratecard" as const }, partnerRef: null }, quoteExpired: true }));
  assert.deepEqual(card.asks, []);
  assert.equal(card.swap.tradeInNote, "Quote expired — re-quoting.");
  assert.equal(card.actions.swap, null);
  // The camera's identity block still comes first: no price is shown at all, so nothing is "expired".
  const blocked = buildOffer(priced({ quote: manual, quoteExpired: true, quoteBlocked: "The camera says this may not be the phone on the case." }));
  assert.deepEqual(blocked.asks.map((a) => a.kind), ["blocked"]);
  assert.equal(blocked.swap.tradeInNote, null);
});

test("offer 7e: the lock's expired-quote blocker says what fixes it — the answer's own sentence for a partner-app quote", () => {
  const manual = { source: { kind: "partner_manual" as const }, partnerRef: "CF-88421" };
  const o = buildOffer(priced({ quote: { status: "priced", amount: 18800, ...manual }, quoteExpired: true }));
  // One sentence on the answer, the swap's refusal and the Lock screen: re-quoting can't renew a quote typed from the app.
  assert.equal(expiredQuoteBlocker(manual), o.swap.tradeInNote);
  assert.equal(expiredQuoteBlocker(manual), o.actions.swap);
  assert.equal(expiredQuoteBlocker({ ...manual, partnerRef: null }), "Partner quote (ref —) expired — enter today's quote.");
  // SwapUp re-quotes everything else, so "re-quote" is the true fix there.
  for (const kind of ["partner_ratecard", "priceiq"] as const)
    assert.equal(expiredQuoteBlocker({ source: { kind }, partnerRef: null }), "The partner's quote has expired — re-quote.");
});

test("offer 7b: nothing priced it — ask for a quote, in the server's words (owner: 'No market price yet — enter a quote')", () => {
  const reason = "No market price yet — enter a quote.";
  const o = buildOffer(priced({ quote: { status: "unpriced", amount: null, source: { kind: "none" }, partnerRef: null, reason } }));
  assert.deepEqual(o.asks, [{ kind: "partner_quote", title: "Enter the partner's quote", text: reason }]);
  assert.equal(o.headline, "Enter the partner's quote");
  assert.equal(o.swap.why, reason);
  assert.equal(o.actions.swap, reason);
  assert.equal(o.swap.tradeIn, null);
  const silent = buildOffer(priced({ quote: { status: "unpriced", amount: null, source: { kind: "none" }, partnerRef: null } }));
  assert.equal(silent.asks[0].text, "No market price yet — enter a quote.", "no reason stored: the same words, never a made-up price");
});

test("offer 7c: no price because of the condition — its first problem, never a partner ask", () => {
  const o = buildOffer(priced({ quote: null, conditionProblems: ["The screen is recorded flawless but it is cracked."] }));
  assert.equal(o.swap.why, "The screen is recorded flawless but it is cracked.");
  assert.ok(!o.asks.some((a) => a.kind === "partner_quote"));
});

/* ─────────────────────────── 8. a manager's override ─────────────────────────── */

test("offer 8: a manager's bonus override is the bonus shown", () => {
  const o = buildOffer(priced({ bonus: { amount: 6199, bp: 400, override: { bp: 500, amount: 7500 } } }));
  assert.equal(o.swap.bonus, 7500);
  assert.equal(o.swap.bonusBp, 500);
  assert.equal(o.swap.total, 19552 + 7500);
  assert.equal(o.swap.customerPays, 154999 - 19552 - 7500);
});

/* ─────────────────────────── 9. no new phone ─────────────────────────── */

test("offer 9: no new phone — ask for one, the trade-in alone is the total, the verdict stands", () => {
  const input = priced({ upgrade: null, bonus: null });
  const o = buildOffer(input);
  assert.deepEqual(o.asks, [{ kind: "new_phone", title: "Choose the new phone", text: "No catalogue match — choose one to see the bonus." }]);
  assert.equal(o.headline, input.decision!.headline, "new_phone never replaces the headline");
  assert.notEqual(o.reason, o.asks[0].text);
  assert.equal(o.swap.bonus, null);
  assert.equal(o.swap.bonusWhy, "Choose the new phone to see the bonus.");
  assert.equal(o.swap.total, 19552, "we pay alone");
  assert.equal(o.swap.newPhone, null);
  // The catalogue has a phone for it (staff cleared the suggestion, or none ran): "nothing matches" would be untrue.
  assert.deepEqual(buildOffer({ ...input, newPhoneMatch: true }).asks, [{ kind: "new_phone", title: "Choose the new phone", text: "Choose the new phone to see the bonus." }]);
  assert.equal(o.swap.customerPays, null);
  // A swap with no new phone is always refused at the lock, and the Lock screen can't choose one:
  // refused here, in the lock blocker's own words.
  assert.equal(o.actions.swap, "Choose the new phone.");
  assert.equal(o.actions.repair, null, "the repair is still allowed");
  // With no trade-in either, the missing trade-in is the reason (it comes first).
  assert.equal(buildOffer(priced({ upgrade: null, bonus: null, quote: null })).actions.swap, "No trade-in price yet.");
  // Nothing to repair and no new phone: both refused, each with its own reason.
  const straight = buildOffer(priced({ faultCount: 0, repair: null, upgrade: null, bonus: null }));
  assert.deepEqual(straight.actions, { repair: "Nothing to repair.", swap: "Choose the new phone.", walkAway: null });
  // A new phone, but no campaign covers it.
  const none = buildOffer(priced({ bonus: null }));
  assert.equal(none.swap.bonusWhy, "No bonus campaign today.");
  assert.equal(none.swap.total, 19552);
  // A staff pick is not "suggested".
  assert.equal(buildOffer(priced({ upgrade: { deviceId: "nd_s25u", label: "Galaxy S25 Ultra 256GB", price: 114999, suggested: false } })).swap.newPhone?.suggested, false);
  assert.equal(buildOffer(priced({ upgrade: { deviceId: "nd_s25u", label: "Galaxy S25 Ultra 256GB", price: 114999 } })).swap.newPhone?.why, null);
  // The stored label (with the brand) is the fallback when the choice has no model and storage.
  assert.equal(buildOffer(priced({ upgrade: { deviceId: "nd_x", label: "Samsung Galaxy S26 Ultra 256GB", price: 154999 } })).swap.newPhone?.label, "Samsung Galaxy S26 Ultra 256GB");
});

/* ─────────────────────────── 10. draft ─────────────────────────── */

test("offer 10: a draft case can't be chosen yet — 'Not priced yet.' where the server would refuse", () => {
  const o = buildOffer(priced({ status: "draft" }));
  assert.equal(o.open, true);
  assert.equal(o.actions.repair, "Not priced yet.");
  assert.equal(o.actions.swap, "Not priced yet.");
  assert.equal(o.actions.walkAway, null, "draft → walked_away is allowed");
});

/* ─────────────────────────── 11. closed ─────────────────────────── */

test("offer 11: a locked case is closed — every action says so, nothing is asked", () => {
  for (const status of ["locked", "repair_chosen", "walked_away", "collected"]) {
    const o = buildOffer(priced({ status, upgrade: null, bonus: null }));
    assert.equal(o.open, false, status);
    assert.deepEqual(o.actions, { repair: "This case is closed.", swap: "This case is closed.", walkAway: "This case is closed." }, status);
    assert.deepEqual(o.asks, [], status);
  }
  // The numbers are still there for the finished screen.
  const locked = buildOffer(priced({ status: "locked" }));
  assert.equal(locked.swap.total, 25751);
  assert.equal(locked.swap.customerPays, 129248);
  // With the figures frozen at lock, they win over the quote and bonus JSON — a case locked before premiums was paid the market price.
  const frozen = buildOffer(priced({ status: "locked", locked: { trade: 18800, premium: null, premiumBp: null, bonus: 6199, payable: 130000 } }));
  assert.equal(frozen.swap.premium, null);
  assert.equal(frozen.swap.wePay, 18800);
  assert.equal(frozen.swap.total, 24999);
  assert.equal(frozen.swap.customerPays, 130000);
  const after = buildOffer(priced({ status: "cleared", quote: { ...CARD_QUOTE, amount: 99999 }, locked: { trade: 18800, premium: 752, premiumBp: 400, bonus: 6199, payable: 129248 } }));
  assert.deepEqual([after.swap.tradeIn, after.swap.premium, after.swap.wePay, after.swap.customerPays], [18800, { amount: 752, bp: 400 }, 19552, 129248]);
});

/* ─────────────────────────── 12. storage the customer typed ─────────────────────────── */

test("offer 12: storage the customer typed carries its note", () => {
  const o = buildOffer(priced({ variantSource: "customer" }));
  assert.deepEqual(o.storage, {
    variant: "256GB",
    source: "customer",
    note: "Customer typed this — check Settings › About phone.",
  });
  for (const source of ["measured", "catalogue", "advisor", null] as const) assert.equal(buildOffer(priced({ variantSource: source })).storage.note, null, String(source));
});

/* ─────────────────────────── 13. ask order ─────────────────────────── */

test("offer 13: several things missing — asked in one order: blocked, model, storage, partner, repair, new phone", () => {
  const blocked = "The camera says this may not be the phone on the case. It can't be priced until a store manager checks it and records why it is the right phone.";
  const many = buildOffer(storageUnknown({ quoteBlocked: blocked, repair: repairFor(["water_damage"]), upgrade: null, bonus: null }));
  assert.deepEqual(many.asks.map((a) => a.kind), ["blocked", "storage", "repair_quote", "new_phone"]);
  assert.equal(many.headline, "Check this is the right phone");
  const partner = buildOffer(priced({ quote: { status: "unpriced", amount: null, source: { kind: "none" }, partnerRef: null, reason: "No price." }, repair: repairFor(["no_power"]), upgrade: null, bonus: null }));
  assert.deepEqual(partner.asks.map((a) => a.kind), ["partner_quote", "repair_quote", "new_phone"]);
  assert.equal(partner.headline, "Enter the partner's quote");
  // No model at all: the model is the one question; nothing else can be asked of a phone with no model.
  const noModel = buildOffer(priced({ device: null, quote: null, repair: null, upgrade: null, bonus: null }));
  assert.deepEqual(noModel.asks.map((a) => a.kind), ["model"]);
  assert.deepEqual(noModel.asks[0], { kind: "model", title: "Which phone is it?", text: "The test couldn't tell — choose it on the full case." });
  // A desk-only case had no test to blame.
  assert.equal(buildOffer(priced({ device: null, quote: null, repair: null, upgrade: null, bonus: null, tested: false })).asks[0].text, "Choose it on the full case.");
  assert.equal(noModel.headline, "Which phone is it?");
  assert.equal(noModel.repair.why, "Choose the phone first.");
  assert.equal(noModel.swap.why, "Choose the phone first.");
  assert.equal(noModel.actions.swap, "Choose the phone first.");
  // Nothing missing and no decision: the honest default.
  assert.equal(buildOffer(priced({ decision: null })).headline, "Not enough to compare yet");
  assert.equal(buildOffer(priced({ decision: null })).recommendation, null);
});

test("offer: the recommended side follows decide(), never the bonus", () => {
  const cheap = priced({ repair: repairFor(["battery_drain"]) });
  assert.equal(cheap.decision!.recommendation, "repair");
  const o = buildOffer(cheap);
  assert.equal(o.recommended, "repair");
  assert.equal(o.reason, o.signals.find((s) => s.points === "repair" && s.strength === "strong")?.text, "the first strong signal the way of the recommendation");
  const bigBonus = priced({ repair: repairFor(["battery_drain"]), bonus: { amount: 6199, bp: 400, override: { bp: 500, amount: 50000 } } });
  assert.equal(buildOffer(bigBonus).recommended, "repair");
  // An expensive repair against a cheap new phone: the 50% rule says upgrade.
  const up = priced({ upgrade: { deviceId: "nd_a17", label: "Galaxy A17 5G 6GB+128GB", price: 27999, suggested: true, why: "x" }, bonus: { amount: 559, bp: 200, override: null } });
  assert.equal(up.decision!.recommendation, "upgrade");
  assert.equal(buildOffer(up).recommended, "swap");
});

test("offer: 'not enough to compare' with nothing to ask says what the comparison is missing", () => {
  // e.g. a partner quote typed in without its repaired value: decide() can't compare, and no ask applies.
  const base = priced();
  const missing = "No repaired value yet.";
  const o = buildOffer({ ...base, decision: { ...base.decision!, recommendation: "cannot_say", signals: [], missing: [missing] } });
  assert.deepEqual(o.asks, []);
  assert.equal(o.reason, missing);
});

/* ─────────────────────────── how the trade-in was reached (PriceIQ at the grade less defects) ─────────────────────────── */

const PRICEIQ_QUOTE = {
  status: "priced" as const,
  amount: 36_490,
  source: { kind: "priceiq" as const },
  partnerRef: null,
  lines: [
    { label: "Refurbished market price (Good) · PriceIQ", amount: 51_399 },
    { label: "Below the market price", bp: 200, amount: -1_028 },
    { label: "Battery drains / swollen", bp: 900, amount: -4_625 },
    { label: "Rear camera faulty", bp: 1_800, amount: -9_251 },
    { label: "Rounded down to ₹10", amount: -5 },
  ],
  priceiq: { grade: "Good" as const, gradeWanted: "Good" as const, listing: 51_399, markdownBp: 200, defects: 2, deductions: "SwapUp's % per defect", week: "2026-W35", listings: 2 },
};

test("tradeInDetail: a PriceIQ quote — one line under the figure, the details from the markdown on (its base is in the line)", () => {
  const o = buildOffer(priced({ quote: PRICEIQ_QUOTE }));
  assert.equal(o.swap.tradeIn, 36_490);
  assert.deepEqual(o.swap.tradeInDetail, {
    line: "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35",
    lines: [
      { label: "Below the market price", pct: "2%", amount: -1_028 },
      { label: "Battery drains / swollen", pct: "9%", amount: -4_625 },
      { label: "Rear camera faulty", pct: "18%", amount: -9_251 },
      { label: "Rounded down to ₹10", pct: null, amount: -5 },
    ],
    note: null,
  });
  assert.equal(o.swap.tradeInNote, null, "fresh market data, PriceIQ answered: nothing to mark");
  const lower = buildOffer(priced({ quote: { ...PRICEIQ_QUOTE, priceiq: { ...PRICEIQ_QUOTE.priceiq, grade: "Fair", gradeWanted: "Good" } } }));
  assert.equal(lower.swap.tradeInDetail?.line, "Refurbished market price ₹51,399 (Fair) − 2% − 2 defects · PriceIQ 2026-W35 · none at Good");
});

test("a swollen battery's safety warning is the answer's own line, in the open — not one of the caveats behind the toggle", () => {
  const base = priced();
  const d = base.decision!;
  const o = buildOffer({ ...base, decision: { ...d, caveats: ["Swollen battery is a safety risk — stop using and charging it.", ...d.caveats] } });
  assert.equal(o.safety, "Swollen battery is a safety risk — stop using and charging it.");
  assert.ok(!o.caveats.includes(o.safety!), "said once");
  assert.equal(buildOffer(base).safety, null);
});

test("old market data and an unreachable PriceIQ are said under the figure — and the swap still goes ahead (a price is a price)", () => {
  const stale = { ...PRICEIQ_QUOTE, priceiq: { ...PRICEIQ_QUOTE.priceiq, stale: true, ageDays: 52, note: "Refurbished market price, week 2026-W35, 52 days old." } };
  const o = buildOffer(priced({ quote: stale }));
  assert.equal(o.swap.tradeInNote, "Refurbished market price, week 2026-W35, 52 days old.");
  assert.equal(o.swap.tradeInDetail?.line, "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35, 52 days old");
  assert.equal(o.actions.swap, null);
  const down = { ...PRICEIQ_QUOTE, priceiq: { ...PRICEIQ_QUOTE.priceiq, note: "PriceIQ unreachable, last answer 2026-10-18 08:30 UTC." } };
  assert.equal(buildOffer(priced({ quote: down })).swap.tradeInNote, "PriceIQ unreachable, last answer 2026-10-18 08:30 UTC.");
  // Expired on an open case: it is being re-quoted — that is the news, not the old figure's age.
  assert.equal(buildOffer(priced({ quote: stale, quoteExpired: true })).swap.tradeInNote, "Quote expired — re-quoting.");
  // Closed: the age the trade-in was priced at stays on it.
  assert.equal(buildOffer(priced({ quote: stale, status: "locked", quoteExpired: true })).swap.tradeInNote, "Refurbished market price, week 2026-W35, 52 days old.");
});

test("tradeInDetail: a quote typed from the partner's app has nothing to break down; no trade-in, no detail", () => {
  const manual = buildOffer(priced({ quote: { status: "priced", amount: 41_000, source: { kind: "partner_manual" }, partnerRef: "PQ-12345", lines: [{ label: "Partner quote · ref PQ-12345", amount: 41_000 }] } }));
  assert.deepEqual(manual.swap.tradeInDetail, { line: null, lines: [], note: null });
  const none = buildOffer(priced({ quote: { status: "unpriced", amount: null, source: { kind: "partner_ratecard" }, partnerRef: null, reason: "No price." } }));
  assert.equal(none.swap.tradeInDetail, null);
  // an older stored quote with no lines still reads
  assert.deepEqual(buildOffer(priced()).swap.tradeInDetail, { line: null, lines: [], note: null });
});

test("tradeInDetail: the rate card answered because PriceIQ had no listing — its lines from the best-condition price, and why", () => {
  const why = "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.";
  const o = buildOffer(
    priced({
      quote: {
        ...CARD_QUOTE,
        amount: 46_220,
        lines: [
          { label: "Best-condition price on the rate card", amount: 65_100 },
          { label: "Rear camera faulty", bp: 1_800, amount: -11_718 },
          { label: "Age: Over 11 months", bp: 800, amount: -5_208 },
          { label: "Rounded down to ₹10", amount: -1 },
          { label: "Body: Light scuffs", bp: 300, amount: -1_953 },
        ],
        priceiqWhy: why,
      },
    })
  );
  assert.equal(o.swap.tradeInDetail?.line, null);
  assert.equal(o.swap.tradeInDetail?.lines[0].label, "Best-condition price on the rate card");
  assert.equal(o.swap.tradeInDetail?.lines.length, 5);
  assert.equal(o.swap.tradeInDetail?.note, why);
  assert.equal(o.swap.tradeInNote, null);
});

/* ─────────────────────────── we pay: the market price + the SwapUp premium ─────────────────────────── */

test("we pay: the same market price earns the same premium whatever priced it — a typed quote, PriceIQ or the rate card", () => {
  for (const kind of ["partner_manual", "priceiq", "partner_ratecard"] as const) {
    const o = buildOffer(priced({ quote: { status: "priced", amount: 25_000, source: { kind }, partnerRef: kind === "partner_manual" ? "QX-1" : null } }));
    assert.deepEqual(o.swap.premium, { amount: 1_000, bp: 400 }, kind);
    assert.equal(o.swap.wePay, 26_000, kind);
    assert.equal(o.answer.wePay, 26_000, kind);
    assert.equal(o.swap.total, 26_000 + 6_199, kind);
  }
});

test("the answer through buildOffer: the owner's lines for the case on the counter (fixture F1 / F6)", () => {
  const o = buildOffer(
    priced({
      condition: { ...HEALTHY, issues: [], screen: "cracked", body: "dented", accessories: { charger: true, box: false, bill: false }, age: "gt11m" },
      quote: { status: "priced", amount: 25_000, source: { kind: "partner_manual" }, partnerRef: "QX-1" },
    })
  );
  assert.deepEqual(
    o.answer.lines.map((l) => [l.text, l.note]),
    [
      ["Current grade C", "screen cracked"],
      ["Market price for grade C ₹25,000", null],
      ["We pay you ₹26,000", null],
      ["+ ₹6,199 bonus if you exchange with a new device", "Galaxy S26 Ultra 256GB"],
      ["or repair it for ₹34,096", null],
    ]
  );
  assert.equal(o.answer.ready, true);
  assert.deepEqual(o.answer.staffNotes, { market: null, we_pay: "Includes ₹1,000 SwapUp premium (4%).", bonus: "Upgrade bonus · 4%" });
  // F6's swap block.
  assert.deepEqual([o.swap.tradeIn, o.swap.premium, o.swap.wePay, o.swap.total, o.swap.customerPays], [25_000, { amount: 1_000, bp: 400 }, 26_000, 32_199, 1_22_800]);
});

test("a quote from a retired source (an older build's) is never 'ready' for the customer, and a lapsed one neither", () => {
  const retired = buildOffer(priced({ quote: { status: "priced", amount: 25_000, source: { kind: "retired" as never }, partnerRef: null }, quoteExpired: true }));
  assert.equal(retired.answer.ready, false);
  assert.deepEqual(customerAnswer(retired.answer), { ready: false, final: false, text: "The advisor is working out your price.", test: false });
  const lapsed = buildOffer(priced({ quote: { status: "priced", amount: 25_000, source: { kind: "partner_manual" }, partnerRef: "QX-1" }, quoteExpired: true }));
  assert.equal(lapsed.answer.ready, false);
});

test("a new phone cheaper than we pay + the bonus: the swap is refused in the lock's words, and nothing is floored", () => {
  const cheap = { deviceId: "nd_a17", label: "Samsung Galaxy A17 5G 128GB", model: "Galaxy A17 5G", variant: "128GB", price: 24_000 };
  const o = buildOffer(priced({ upgrade: cheap }));
  assert.equal(o.swap.customerPays, null);
  assert.equal(o.swap.vsRepair, null);
  assert.equal(o.actions.swap, "The new phone costs less than we pay plus the bonus — choose another phone.");
  // Exactly enough: the customer pays nothing, and the swap is allowed.
  const exact = buildOffer(priced({ upgrade: { ...cheap, price: 19_552 + 6_199 } }));
  assert.equal(exact.swap.customerPays, 0);
  assert.equal(exact.actions.swap, null);
});

test("a bonus the campaign's ₹ cap set says so to staff; the line is the same either way", () => {
  const o = buildOffer(priced({ bonus: { amount: 6_000, bp: 400, override: null, clampedBy: "cap", basisAmount: 154_999 } }));
  assert.equal(o.answer.staffNotes.bonus, "Upgrade bonus · capped at ₹6,000");
  assert.equal(o.answer.lines.find((l) => l.key === "bonus")!.text, "+ ₹6,000 bonus if you exchange with a new device");
  // A manager's override the cap cut short.
  const ov = buildOffer(priced({ bonus: { amount: 6_000, bp: 400, override: { bp: 500, amount: 6_000 }, clampedBy: "cap", basisAmount: 154_999 } }));
  assert.equal(ov.answer.staffNotes.bonus, "Upgrade bonus · capped at ₹6,000");
  assert.equal(buildOffer(priced()).answer.staffNotes.bonus, "Upgrade bonus · 4%");
});

test("a test programme: the answer carries test: true", () => {
  assert.equal(buildOffer(priced({ testProgramme: true })).answer.test, true);
  assert.equal(buildOffer(priced()).answer.test, false);
});
