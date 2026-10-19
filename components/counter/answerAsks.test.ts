import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffer, type OfferInput } from "../../lib/domain/offer.ts";
import type { CaseView } from "../../lib/server/cases.ts";
import type { PriceSourceKind } from "../../lib/domain/ratecard.ts";
import { namesBrand } from "../../lib/domain/testing/brand.ts";
import {
  ASK_MANAGER,
  ASK_STEP,
  CAMERA_REASON_MIN,
  askControl,
  autoRequoteKey,
  cameraReasonOk,
  heldForReason,
  identityReasonOk,
  requotable,
  requoteSpot,
  swapRefusal,
  unlistedSize,
  withCameraReason,
} from "./answerAsks.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */
// The answer as the server builds it (lib/domain/offer.ts), for an S23 Ultra priced off the partner's rate card.

const S26U = { deviceId: "nd_s26u_256", label: "Samsung Galaxy S26 Ultra 256GB", model: "Galaxy S26 Ultra", variant: "256GB", price: 154999 };
const CARD = { status: "priced" as const, amount: 18800, source: { kind: "partner_ratecard" as const }, partnerRef: null };
// A quote an older build let staff type in, still on a case: history only — the system re-asks it.
const MANUAL = { status: "priced" as const, amount: 19500, source: { kind: "partner_manual" as const }, partnerRef: "QX-OLD-0001" };
const NO_PRICE = { status: "unpriced" as const, amount: null, source: { kind: "none" as const }, partnerRef: null, reason: "No rate card is active yet." };

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
    quote: CARD,
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
const NOTHING_ON_CASE: Pick<CaseView, "measuredStorage"> = { measuredStorage: null };

function ask(i: OfferInput, kind: string) {
  const a = buildOffer(i).asks.find((x) => x.kind === kind);
  assert.ok(a, `expected a ${kind} ask`);
  return a;
}

/* ─────────────────────────── the control under each ask ─────────────────────────── */

test("storage chips priced off old market data carry the server's note (its age) under them", () => {
  const AGE = "Refurbished market price, week 2026-W35, 52 days old.";
  const a = ask(
    input({
      ...NO_STORAGE,
      storageQuotes: [
        { variant: "512GB", amount: 20300, reason: null, note: AGE },
        { variant: "256GB", amount: 18800, reason: null, note: AGE },
      ],
    }),
    "storage"
  );
  const c = askControl(a, NOTHING_ON_CASE, false);
  assert.equal(c.kind, "chips");
  if (c.kind !== "chips") return;
  assert.equal(c.note, AGE);
  assert.deepEqual(
    c.options.map((o) => [o.variant, o.tradeIn]),
    [
      ["256GB", 18800],
      ["512GB", 20300],
    ]
  );
});

test("storage chips from the model's sizes alone (no prices) have no note", () => {
  const c = askControl(ask(input({ ...NO_STORAGE }), "storage"), NOTHING_ON_CASE, false);
  assert.equal(c.kind, "chips");
  if (c.kind === "chips") assert.equal(c.note, null);
});

test("a measured size that isn't on file is said, text only — no chip, no jump to step 1, no form, never a guessed size", () => {
  const a = ask(input({ ...NO_STORAGE, measuredStorage: "1TB" }), "storage");
  assert.equal(a.kind === "storage" && a.options.length, 0);
  assert.equal(a.text, "Phone measures 1TB, not on file — no trade-in price for that size.");
  assert.deepEqual(askControl(a, { measuredStorage: "1TB" }, false), { kind: "none" });
});

test("a storage ask with no chips and no measurement still goes to the Phone step", () => {
  const a = ask(input({ ...NO_STORAGE, device: { label: "Samsung Galaxy S23 Ultra", variant: null, variants: [] } }), "storage");
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "step", step: "step-phone", button: "Choose storage" });
});

test("nothing priced it: the no_price ask is text only — its reason, no button, no step to jump to, nothing to type", () => {
  const o = buildOffer(input({ quote: NO_PRICE }));
  const a = ask(input({ quote: NO_PRICE }), "no_price");
  assert.deepEqual(a, { kind: "no_price", title: "No market price yet", text: "No rate card is active yet." });
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "none" });
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, true), { kind: "none" });
  assert.equal(ASK_STEP.no_price, undefined);
  // Said once: the headline is the title, the sentence under it the reason — the card drops both from the ask box.
  assert.equal(o.headline, "No market price yet");
  assert.equal(o.reason, "No rate card is active yet.");
  // Swap up is refused with that reason; the repair and walking away stay choosable.
  assert.equal(o.actions.swap, "No rate card is active yet.");
  assert.equal(o.actions.walkAway, null);
  assert.equal(o.swap.tradeIn, null);
  assert.ok(!o.asks.some((x) => (x.kind as string) === "partner_quote"));
});

test("a leftover typed quote that ran out is the system's to re-quote, like any other — never 'enter today's quote'", () => {
  const o = buildOffer(input({ quote: MANUAL, quoteExpired: true }));
  assert.equal(o.swap.tradeInNote, "Quote expired — re-quoting.");
  assert.ok(!o.asks.some((x) => x.kind === "no_price"));
  assert.ok(!/today's quote|partner ref|enter a quote|partner's quote/i.test(JSON.stringify(o)), JSON.stringify(o.asks));
});

test("the camera's identity block: a store manager gets the override, an advisor is told who can", () => {
  const blocked = "The camera says this may not be the phone on the case (IMEI differs). It can't be priced until a store manager checks it and records why it is the right phone.";
  const a = ask(input({ quoteBlocked: blocked }), "blocked");
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, true), { kind: "identity_override" });
  assert.deepEqual(askControl(a, NOTHING_ON_CASE, false), { kind: "ask_manager", text: ASK_MANAGER });
  assert.equal(ASK_MANAGER, "Ask your manager to confirm it.");
});

test("the other asks keep their jump to the step that answers them", () => {
  assert.deepEqual(askControl(ask(input({ device: null, quote: null }), "model"), NOTHING_ON_CASE, false), { kind: "step", step: "step-phone", button: "Choose model" });
  assert.deepEqual(askControl(ask(input({ upgrade: null }), "new_phone"), NOTHING_ON_CASE, false), { kind: "step", step: "step-upgrade", button: "Choose new phone" });
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
          partner: "Buyback Partner (demo)",
          partnerRef: null,
          quotedAt: q.quotedAt ?? "2026-10-10T10:00:00.000Z",
          validUntil: "2026-10-13T10:00:00.000Z",
        }
      : null,
    offer: buildOffer(input()),
    ...over,
  };
}

test("an expired rate-card or PriceIQ quote on an open case is re-quoted once, keyed by that quote", () => {
  for (const kind of ["partner_ratecard", "priceiq"] as const) {
    const key = autoRequoteKey(caseWith({ kind }));
    assert.ok(key, kind);
    assert.equal(requotable(caseWith({ kind })), true);
    // The same quote → the same key, so the card's ref stops a second call; a new quote that also ran out gets its own.
    assert.equal(autoRequoteKey(caseWith({ kind })), key);
    assert.notEqual(autoRequoteKey(caseWith({ kind, quotedAt: "2026-10-14T10:00:00.000Z" })), key);
  }
});

test("an older build's typed quote that ran out is re-quoted by the system too", () => {
  assert.ok(autoRequoteKey(caseWith({ kind: "partner_manual" })));
  assert.equal(requotable(caseWith({ kind: "partner_manual" })), true);
});

test("an unpriced quote on an open case is asked again once on open, expired or not (a rate card uploaded since prices it)", () => {
  const unpriced = (over: Partial<Pick<CaseView, "quoteExpired" | "offer">> = {}) => {
    const v = caseWith({ kind: "none" }, { quoteExpired: false, ...over });
    return { ...v, quote: { ...v.quote!, status: "unpriced" as const, amount: null, validUntil: null, reason: "No rate card is active yet." } };
  };
  const key = autoRequoteKey(unpriced());
  assert.ok(key);
  assert.equal(autoRequoteKey(unpriced()), key, "the same quote, the same key: asked once");
  assert.equal(autoRequoteKey(unpriced({ offer: buildOffer(input({ status: "walked_away" })) })), null);
});

test("nothing to re-quote: a fresh priced quote, no quote, a closed case", () => {
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { quoteExpired: false })), null);
  assert.equal(autoRequoteKey(caseWith(null)), null);
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { offer: buildOffer(input({ status: "walked_away" })) })), null);
  assert.equal(autoRequoteKey(caseWith({ kind: "partner_ratecard" }, { offer: null })), null);
});

/* ─────────────────────────── the trade-in step: one Re-quote, and a size not on file ─────────────────────────── */

function quoteOf(kind: PriceSourceKind): CaseView["quote"] {
  return caseWith({ kind }).quote;
}

test("the trade-in step offers exactly ONE Re-quote: on the step when expired or unpriced, behind the details while the price is good", async () => {
  const priced = quoteOf("partner_ratecard")!;
  const unpriced = { ...priced, status: "unpriced" as const, amount: null, validUntil: null, reason: "This phone isn't on the rate card yet." };
  assert.equal(requoteSpot({ quote: priced, quoteExpired: false }, true), "details");
  assert.equal(requoteSpot({ quote: priced, quoteExpired: true }, true), "step");
  assert.equal(requoteSpot({ quote: unpriced, quoteExpired: false }, true), "step");
  assert.equal(requoteSpot({ quote: null, quoteExpired: false }, true), null);
  assert.equal(requoteSpot({ quote: priced, quoteExpired: true }, false), null);
  // The step draws each of its two buttons only for its own spot, so at most one is ever on screen.
  const step = (await import("node:fs")).readFileSync(new URL("./StepTradeIn.tsx", import.meta.url), "utf8");
  assert.equal(step.match(/"↻ Re-quote"|"Re-quote"/g)?.length, 2);
  assert.match(step, /retry === "details" \? \(\s*<button[^]*?"↻ Re-quote"/);
  assert.match(step, /retry === "step" \? \(\s*<button[^]*?"Re-quote"/);
});

test("step 5: a size the phone measured that step 1 doesn't list is named there, from the server's chip-less storage ask", () => {
  const dev = (variant: string | null): CaseView["device"] => ({ modelId: "galaxy-s23-ultra", brand: "Samsung", model: "Galaxy S23 Ultra", series: "S", variant, releaseYear: 2023, supportEndYear: 2030, ageYears: 3 });
  const offer1TB = buildOffer(input({ ...NO_STORAGE, measuredStorage: "1TB" }));
  assert.equal(unlistedSize({ device: dev(null), measuredStorage: "1TB", offer: offer1TB }), "1TB");
  // Settled (a size on the case), measured on the list, never measured, or no answer: nothing to say.
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

test("a fault or condition change the camera refuses is held for ONE reason, then sent again with it — the server's rule, the server's shape", () => {
  const WHY = 'Camera confirmed "Cracked screen", photo 2 — removing it needs a reason.';
  const patch = { faults: [], condition: { powersOn: true } };
  assert.deepEqual(heldForReason(patch, WHY), { patch, why: WHY });
  assert.deepEqual(heldForReason({ conditionFromFaults: true }, 'Camera confirmed the screen "Cracked" — "Flawless" needs a reason.')?.patch, { conditionFromFaults: true });
  // Nothing held: the save went through, failed for another reason, wasn't a condition change, or already carried a reason.
  assert.equal(heldForReason(patch, null), null);
  assert.equal(heldForReason(patch, "The case is past the counter."), null);
  assert.equal(heldForReason({ variant: "256GB" }, WHY), null);
  assert.equal(heldForReason({ ...patch, cameraOverride: { reason: "seen it, no crack" } }, WHY), null);
  // Sent again as updateCase reads it: the same change, plus cameraOverride {reason}, trimmed.
  assert.deepEqual(withCameraReason(patch, "  Glass protector cracked, screen fine  "), { ...patch, cameraOverride: { reason: "Glass protector cracked, screen fine" } });
  assert.equal(CAMERA_REASON_MIN, 8);
  assert.equal(cameraReasonOk("   1234567   "), false);
  assert.equal(cameraReasonOk("12345678"), true);
});

/* ─────────────────────────── the "Swap up" refusal, said once ─────────────────────────── */

test("no new phone: the tile's own link says it, so the refusal isn't repeated under it", () => {
  const o = buildOffer(input({ upgrade: null }));
  assert.equal(o.actions.swap, "Choose the new phone.");
  assert.equal(swapRefusal(o), null);
});

test("no trade-in: the tile's why says it; any other refusal is said once", () => {
  assert.equal(swapRefusal(buildOffer(input({ ...NO_STORAGE }))), null);
  assert.equal(swapRefusal(buildOffer(input({ status: "draft" }))), "Not priced yet.");
  assert.equal(swapRefusal(buildOffer(input())), null);
});

/* ─────────────────────────── one name for the partner ─────────────────────────── */

test("the answer's asks and buttons never name the partner's brand — 'the partner' or the partner's name from data", () => {
  const offers = [
    buildOffer(input()),
    buildOffer(input({ quote: NO_PRICE })),
    buildOffer(input({ ...NO_STORAGE, measuredStorage: "1TB" })),
    buildOffer(input({ quote: { status: "unpriced", amount: null, source: { kind: "partner_ratecard" }, partnerRef: null, reason: "No price for this model." } })),
    buildOffer(input({ quote: { ...CARD, source: { kind: "partner_ratecard" } }, quoteExpired: true })),
  ];
  for (const o of offers) assert.ok(!namesBrand(JSON.stringify(o)), JSON.stringify(o.asks));
  for (const a of Object.values(ASK_STEP)) assert.ok(!namesBrand(a!.button), a!.button);
});

test("a decision made under an older ruleset is re-decided once, quietly — never a re-quote, never on a closed case", async () => {
  const { staleDecisionKey } = await import("./answerAsks.ts");
  const { RULESET_VERSION } = await import("../../lib/domain/decision.ts");
  const open = { open: true } as never;
  assert.equal(staleDecisionKey({ id: "c1", offer: open, decision: { version: "2026-10-15.2" } }), "c1 ruleset 2026-10-15.2");
  assert.equal(staleDecisionKey({ id: "c1", offer: open, decision: { version: RULESET_VERSION } }), null);
  assert.equal(staleDecisionKey({ id: "c1", offer: open, decision: null }), null);
  assert.equal(staleDecisionKey({ id: "c1", offer: { open: false } as never, decision: { version: "2026-10-15.2" } }), null);
  // The card runs it as a plain reprice (requote:false): the partner is not asked again.
  const card = (await import("node:fs")).readFileSync(new URL("./AnswerCard.tsx", import.meta.url), "utf8");
  assert.match(card, /autoRequoteKey\(view\) \?\? staleDecisionKey\(view\)/);
  assert.match(card, /act\("reprice"\)\.then/);
});

test("the answer card prints the server's lines — no figure of its own beside them (each number once)", async () => {
  const card = (await import("node:fs")).readFileSync(new URL("./AnswerCard.tsx", import.meta.url), "utf8");
  assert.match(card, /o\.answer\.lines/);
  assert.ok(!/inr\(w\.total\)|inr\(r\.amount\)/.test(card), "the old tile figures are gone");
  assert.match(card, /<GradeRow view=\{view\} hideLabel=/);
});

/* ─────────────────────────── no price is typed in anywhere on the desk ─────────────────────────── */

test("the desk has no trade-in entry left: no partner-quote form, field, button or patch", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x) && !x.endsWith(".test.ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/partnerQuote|PartnerQuote(?:Form|Entry)/.test(src), f);
    assert.ok(!/partner_quote|enter (?:the )?partner|today's quote|reference code|typed quote/i.test(src), f);
  }
});
