import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffer, type OfferInput } from "../../lib/domain/offer.ts";
import type { CaseView } from "../../lib/server/cases.ts";
import type { PriceSourceKind } from "../../lib/domain/ratecard.ts";
import { ASK_MANAGER, askControl, autoRequoteKey, cashifyLapsed, cashifyQuoteProblem, identityReasonOk, requotable, swapRefusal, unlistedSize, wholeRupees } from "./answerAsks.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */
// The answer as the server builds it (lib/domain/offer.ts), for an S23 Ultra on the sample card.

const S26U = { deviceId: "nd_s26u_256", label: "Samsung Galaxy S26 Ultra 256GB", model: "Galaxy S26 Ultra", variant: "256GB", price: 154999 };
const SAMPLE = { status: "priced" as const, amount: 18800, source: { kind: "sample" as const }, partnerRef: null };
const MANUAL = { status: "priced" as const, amount: 19500, source: { kind: "partner_manual" as const }, partnerRef: "CF-EXP-0001" };

function input(over: Partial<OfferInput> = {}): OfferInput {
  return {
    status: "quoted",
    device: { label: "Samsung Galaxy S23 Ultra", variant: "256GB", variants: ["256GB", "512GB"] },
    variantSource: "measured",
    measuredStorage: null,
    storageQuotes: null,
    faultCount: 1,
    coverage: "none",
    repair: null,
    manualRepair: null,
    repairNotServiced: null,
    quote: SAMPLE,
    quoteExpired: false,
    quoteBlocked: null,
    conditionProblems: [],
    hasCondition: true,
    upgrade: S26U,
    bonus: { amount: 6199, bp: 400, override: null },
    decision: null,
    ...over,
  };
}

const NO_STORAGE: Partial<OfferInput> = { device: { label: "Samsung Galaxy S23 Ultra", variant: null, variants: ["256GB", "512GB"] }, variantSource: null, quote: null };
const PM = { amount: 19500, reference: "CF-EXP-0001", validUntil: "2026-10-13T10:00:00.000Z", repairedAmount: null, by: "Asha", at: "2026-10-10T10:00:00.000Z" };
const NOTHING_ON_CASE: Pick<CaseView, "partnerManual" | "measuredStorage"> = { partnerManual: null, measuredStorage: null };

function ask(i: OfferInput, kind: string) {
  const a = buildOffer(i).asks.find((x) => x.kind === kind);
  assert.ok(a, `expected a ${kind} ask`);
  return a;
}

/* ─────────────────────────── the control under each ask ─────────────────────────── */

test("storage chips priced off the sample card carry the server's sample note under them", () => {
  const a = ask(
    input({
      ...NO_STORAGE,
      storageQuotes: [
        { variant: "512GB", amount: 20300, reason: null, sample: true },
        { variant: "256GB", amount: 18800, reason: null, sample: true },
      ],
    }),
    "storage"
  );
  const c = askControl(a, NOTHING_ON_CASE, false);
  assert.equal(c.kind, "chips");
  if (c.kind !== "chips") return;
  assert.equal(c.note, "Sample price — not a real quote.");
  assert.deepEqual(
    c.options.map((o) => [o.variant, o.tradeIn, o.sample]),
    [
      ["256GB", 18800, true],
      ["512GB", 20300, true],
    ]
  );
});

test("storage chips from the model's sizes alone (no prices) have no note", () => {
  const c = askControl(ask(input({ ...NO_STORAGE }), "storage"), NOTHING_ON_CASE, false);
  assert.equal(c.kind, "chips");
  if (c.kind === "chips") assert.equal(c.note, null);
});

test("a measured size that isn't on file gets the Cashify quote on the card, never a chip or a jump to step 1", () => {
  const a = ask(input({ ...NO_STORAGE, measuredStorage: "1TB" }), "storage");
  assert.equal(a.kind === "storage" && a.options.length, 0);
  assert.deepEqual(askControl(a, { partnerManual: null, measuredStorage: "1TB" }, false), { kind: "cashify", why: "unlisted", size: "1TB" });
});

test("a storage ask with no chips and no measurement still goes to step 1", () => {
  const a = ask(input({ ...NO_STORAGE, device: { label: "Samsung Galaxy S23 Ultra", variant: null, variants: [] } }), "storage");
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "step", step: "step-phone", button: "Choose it in step 1" });
});

test("a lapsed Cashify-app quote is re-entered on the card, where the advisor is (step 5 is folded away under the answer)", () => {
  const a = ask(input({ quote: MANUAL, quoteExpired: true }), "partner_quote");
  assert.equal(a.text, "Cashify quote (ref CF-EXP-0001) expired — enter today's quote.");
  assert.deepEqual(askControl(a, { partnerManual: PM, measuredStorage: null }, false), { kind: "cashify", why: "lapsed", size: null });
});

test("a partner with no price still sends the advisor to step 5, where the form opens by itself", () => {
  const a = ask(input({ quote: { status: "unpriced", amount: null, source: { kind: "partner_ratecard" }, partnerRef: null, reason: "No price for this model." } }), "partner_quote");
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "step", step: "step-tradein", button: "Enter the Cashify quote" });
});

test("the camera's identity block: a store manager gets the override, an advisor is told who can", () => {
  const blocked = "The camera says this may not be the phone on the case (IMEI differs). It can't be priced until a store manager checks it and records why it is the right phone.";
  const a = ask(input({ quoteBlocked: blocked }), "blocked");
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, true), { kind: "identity_override" });
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "ask_manager", text: ASK_MANAGER });
  assert.equal(ASK_MANAGER, "Ask your store manager to confirm it.");
});

test("the other asks keep their jump to the step that answers them", () => {
  assert.deepEqual(askControl(ask(input({ device: null, quote: null }), "model"), NOTHING_ON_CASE, false), { kind: "step", step: "step-phone", button: "Choose the model" });
  assert.deepEqual(askControl(ask(input({ upgrade: null }), "new_phone"), NOTHING_ON_CASE, false), { kind: "step", step: "step-upgrade", button: "Choose the new phone" });
});

/* ─────────────────────────── the quiet re-quote ─────────────────────────── */

function caseWith(q: { kind: PriceSourceKind; quotedAt?: string } | null, over: Partial<Pick<CaseView, "quoteExpired" | "offer">> = {}): Pick<CaseView, "id" | "quoteExpired" | "quote" | "offer"> {
  return {
    id: "case_1",
    quoteExpired: true,
    quote: q
      ? {
          status: "priced",
          amount: 18800,
          lines: [],
          source: { kind: q.kind, label: "Rate card" },
          partner: "Cashify",
          partnerRef: null,
          quotedAt: q.quotedAt ?? "2026-10-10T10:00:00.000Z",
          validUntil: "2026-10-13T10:00:00.000Z",
        }
      : null,
    offer: buildOffer(input()),
    ...over,
  };
}

test("an expired rate-card, live or sample quote on an open case is re-quoted once, keyed by that quote", () => {
  for (const kind of ["partner_ratecard", "partner_live", "sample"] as const) {
    const key = autoRequoteKey(caseWith({ kind }));
    assert.ok(key, kind);
    assert.equal(requotable(caseWith({ kind })), true);
    // The same quote → the same key, so the card's ref stops a second call; a new quote that also ran out gets its own.
    assert.equal(autoRequoteKey(caseWith({ kind })), key);
    assert.notEqual(autoRequoteKey(caseWith({ kind, quotedAt: "2026-10-14T10:00:00.000Z" })), key);
  }
});

test("nothing to re-quote: a Cashify-app quote, a fresh quote, no quote, a closed case", () => {
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_manual" })), null);
  assert.equal(requotable(caseWith({ kind: "partner_manual" })), false);
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { quoteExpired: false })), null);
  assert.equal(autoRequoteKey(caseWith(null)), null);
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { offer: buildOffer(input({ status: "walked_away" })) })), null);
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { offer: null })), null);
});

/* ─────────────────────────── step 5's form, for what re-quoting and step 1 can't do ─────────────────────────── */

function quoteOf(kind: PriceSourceKind): CaseView["quote"] {
  return caseWith({ kind }).quote;
}

test("step 5: a lapsed Cashify-app quote opens the form for today's quote instead of a Re-quote that can't renew it", () => {
  assert.equal(cashifyLapsed({ partnerManual: PM, quoteExpired: true, quote: quoteOf("partner_manual") }), true);
  // Still valid, or not a quote from the app: nothing lapsed (an expired rate-card quote keeps its Re-quote).
  assert.equal(cashifyLapsed({ partnerManual: PM, quoteExpired: false, quote: quoteOf("partner_manual") }), false);
  assert.equal(cashifyLapsed({ partnerManual: null, quoteExpired: true, quote: quoteOf("partner_ratecard") }), false);
  // A Cashify quote kept while the description is incomplete prices nothing (no quote): not "lapsed".
  assert.equal(cashifyLapsed({ partnerManual: PM, quoteExpired: false, quote: null }), false);
});

test("step 5: a size the phone measured that step 1 doesn't list is priced there, from the server's chip-less storage ask", () => {
  const dev = (variant: string | null): CaseView["device"] => ({ modelId: "galaxy-s23-ultra", brand: "Samsung", model: "Galaxy S23 Ultra", series: "S", variant, releaseYear: 2023, supportEndYear: 2030, ageYears: 3 });
  const offer1TB = buildOffer(input({ ...NO_STORAGE, measuredStorage: "1TB" }));
  assert.equal(unlistedSize({ device: dev(null), measuredStorage: "1TB", offer: offer1TB }), "1TB");
  // Settled (the Cashify quote set the storage), measured on the list, never measured, or no answer: nothing to say.
  assert.equal(unlistedSize({ device: dev("1TB"), measuredStorage: "1TB", offer: buildOffer(input({ measuredStorage: "1TB" })) }), null);
  assert.equal(unlistedSize({ device: dev(null), measuredStorage: "512GB", offer: buildOffer(input({ ...NO_STORAGE, measuredStorage: "512GB" })) }), null);
  assert.equal(unlistedSize({ device: dev(null), measuredStorage: null, offer: buildOffer(input({ ...NO_STORAGE })) }), null);
  assert.equal(unlistedSize({ device: dev(null), measuredStorage: "1TB", offer: null }), null);
  assert.equal(unlistedSize({ device: null, measuredStorage: "1TB", offer: offer1TB }), null);
});

/* ─────────────────────────── what the card's forms accept ─────────────────────────── */

test("the identity override needs at least 8 characters after trimming, like the server", () => {
  assert.equal(identityReasonOk("checked"), false);
  assert.equal(identityReasonOk("   1234567   "), false);
  assert.equal(identityReasonOk("*#06# matches the box"), true);
  assert.equal(identityReasonOk("12345678"), true);
});

test("a Cashify quote typed on the card: whole rupees, the app's reference, a repaired value not below it", () => {
  assert.equal(wholeRupees("19,500"), 19500);
  assert.equal(wholeRupees("₹ 19500"), 19500);
  assert.equal(wholeRupees("19500.50"), null);
  assert.equal(cashifyQuoteProblem("19,500", "cf-exp-0002", ""), null);
  assert.equal(cashifyQuoteProblem("19500", "CF-EXP-0002", "26000"), null);
  assert.equal(cashifyQuoteProblem("", "CF-EXP-0002", ""), "Enter the partner's quote as a whole rupee amount.");
  assert.equal(cashifyQuoteProblem("0", "CF-EXP-0002", ""), "Enter the partner's quote as a whole rupee amount.");
  assert.equal(cashifyQuoteProblem("500001", "CF-EXP-0002", ""), "Enter the partner's quote as a whole rupee amount.");
  assert.equal(cashifyQuoteProblem("19500", "CF", ""), "Enter the reference code the partner's app shows for this quote.");
  assert.equal(cashifyQuoteProblem("19500", "CF 0002", ""), "Enter the reference code the partner's app shows for this quote.");
  assert.equal(cashifyQuoteProblem("19500", "CF-EXP-0002", "19000"), "The repaired value must be a whole rupee amount, at least the as-is quote.");
});

/* ─────────────────────────── the "Swap up" refusal, said once ─────────────────────────── */

test("no new phone: the tile's own link says it, so the refusal isn't repeated under it", () => {
  const o = buildOffer(input({ upgrade: null }));
  assert.equal(o.actions.swap, "Choose the new phone.");
  assert.equal(swapRefusal(o), null);
});

test("a lapsed Cashify quote: the warn note says it, so the refusal isn't repeated", () => {
  const o = buildOffer(input({ quote: MANUAL, quoteExpired: true }));
  assert.equal(o.actions.swap, o.swap.tradeInNote);
  assert.equal(swapRefusal(o), null);
});

test("no trade-in: the tile's why says it; any other refusal is said once", () => {
  assert.equal(swapRefusal(buildOffer(input({ ...NO_STORAGE }))), null);
  assert.equal(swapRefusal(buildOffer(input({ status: "draft" }))), "Not priced yet.");
  assert.equal(swapRefusal(buildOffer(input())), null);
});
