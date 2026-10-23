import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswer, customerAnswer, defectNote, CANCELLED_TEXT, CONFIRMING, ESTIMATE_NOTE, WORKING_OUT, type Answer, type AnswerInput } from "./answer.ts";
import { HEALTHY, type ConditionAnswers } from "./condition.ts";
import { gradeAfterRefurb, tradeInGrade } from "./marketSell.ts";
import { DEFECT_DEDUCTIONS, priceFromCard, type RateCard } from "./ratecard.ts";
import { CARD } from "./fixtures.ts";

/* ─────────────────────────── fixtures (shared with swapup-mobile: copy verbatim) ─────────────────────────── */

const cond = (over: Partial<ConditionAnswers> = {}): ConditionAnswers => ({ ...HEALTHY, issues: [], accessories: { charger: true, box: false, bill: false }, age: "gt11m", ...over });
/** The S23 Ultra 256GB with a cracked screen on a dented body. */
const CRACKED_DENTED = cond({ screen: "cracked", body: "dented" });

/** F1's case, as buildOffer maps it: partner quote ₹25,000, the S26 Ultra suggested at 4% bonus, repair ₹34,096. */
function f1(over: Partial<AnswerInput> = {}): AnswerInput {
  return {
    status: "quoted",
    condition: CRACKED_DENTED,
    market: { amount: 25_000, source: "partner_manual", priceGrade: null },
    quoteExpired: false,
    quoteBlocked: false,
    repair: { amount: 34_096, covered: false, coverage: "none", nothingToRepair: false },
    newPhone: { label: "Galaxy S26 Ultra 256GB", price: 1_54_999 },
    bonus: { amount: 6_199, bp: 400, cap: null },
    bonusWhy: null,
    recommendation: "upgrade",
    locked: null,
    testProgramme: false,
    ...over,
  };
}
const LOCKED = { trade: 25_000, premium: 1_000, premiumBp: 400, bonus: 6_199, payable: 1_22_800 };

/** F1 — customer, ready, open (GET /api/device/status → answer). */
const F1 = {
  ready: true,
  final: false,
  headline: "An upgrade is worth considering",
  grade: { letter: "C", word: "Fair", note: "screen cracked" },
  market: { amount: 25000, letter: "C", word: "Fair" },
  wePay: 26000,
  bonus: { amount: 6199 },
  newPhone: { label: "Galaxy S26 Ultra 256GB" },
  repair: { amount: 34096, covered: false, nothingToRepair: false },
  lines: [
    { key: "grade", text: "Current grade C", note: "screen cracked", amount: null },
    { key: "market", text: "Market price for grade C ₹25,000", note: null, amount: 25000 },
    { key: "we_pay", text: "We pay you ₹26,000", note: null, amount: 26000 },
    { key: "bonus", text: "+ ₹6,199 bonus if you exchange with a new device", note: "Galaxy S26 Ultra 256GB", amount: 6199 },
    { key: "repair", text: "or repair it for ₹34,096", note: null, amount: 34096 },
  ],
  test: false,
};
/** F2 — customer, not ready. */
const F2 = { ready: false, final: false, text: "The advisor is working out your price.", test: false };
/** F3 — customer, traded in (final). */
const F3 = {
  ...F1,
  final: true,
  headline: "Traded in",
  lines: [
    { key: "grade", text: "Current grade C", note: "screen cracked", amount: null },
    { key: "market", text: "Market price for grade C ₹25,000", note: null, amount: 25000 },
    { key: "we_pay", text: "We paid you ₹26,000", note: null, amount: 26000 },
    { key: "bonus", text: "+ ₹6,199 bonus with the Galaxy S26 Ultra 256GB", note: null, amount: 6199 },
  ],
};
/** F4 — customer, a covered repair, nothing else wrong (lines on the display, under warranty). */
const F4 = {
  ready: true,
  final: false,
  headline: "Repair it — it's covered",
  grade: { letter: "A", word: "Superb", note: "screen lines or spots" },
  market: { amount: 30000, letter: "A", word: "Superb" },
  wePay: 31200,
  bonus: null,
  newPhone: null,
  repair: { amount: 0, covered: true, nothingToRepair: false },
  lines: [
    { key: "grade", text: "Current grade A", note: "screen lines or spots", amount: null },
    { key: "market", text: "Market price for grade A ₹30,000", note: null, amount: 30000 },
    { key: "we_pay", text: "We pay you ₹31,200", note: null, amount: 31200 },
    { key: "repair", text: "or repair it free — covered by warranty", note: null, amount: 0 },
  ],
  test: false,
};
/** F5 — customer, nothing to repair, no campaign. */
const F5 = {
  ready: true,
  final: false,
  headline: "Nothing to repair — a straight trade-in",
  grade: { letter: "A", word: "Superb", note: null },
  market: { amount: 25000, letter: "A", word: "Superb" },
  wePay: 26000,
  bonus: null,
  newPhone: { label: "Galaxy S26 Ultra 256GB" },
  repair: { amount: null, covered: false, nothingToRepair: true },
  lines: [
    { key: "grade", text: "Current grade A (Superb)", note: null, amount: null },
    { key: "market", text: "Market price for grade A ₹25,000", note: null, amount: 25000 },
    { key: "we_pay", text: "We pay you ₹26,000", note: null, amount: 26000 },
  ],
  test: false,
};
/** F6 — staff `offer.answer` (GET /api/cases/<id>) = F1 plus the staff-only fields. */
const F6 = {
  ...F1,
  text: null,
  market: { ...F1.market, source: "partner_manual" },
  premium: { amount: 1000, bp: 400, rule: "2026-10-18.1" },
  bonus: { amount: 6199, bp: 400 },
  newPhone: { label: "Galaxy S26 Ultra 256GB", price: 154999 },
  repair: { ...F1.repair, coverage: "none" },
  staffNotes: { market: null, we_pay: "Includes ₹1,000 SwapUp premium (4%).", bonus: "Upgrade bonus · 4%" },
};
/** F8 — staff, not ready: a PriceIQ trade-in is SwapUp's estimate — staff see the lines, the customer waits. */
const F8_STAFF_NOTES = { market: ESTIMATE_NOTE, we_pay: "Includes ₹1,000 SwapUp premium (4%).", bonus: "Upgrade bonus · 4%" };
const F8_CUSTOMER = { ready: false, final: false, text: "The advisor is confirming your price.", test: false };
/** F9 — repair chosen (final): the grade and the repair only. */
const F9_LINES = [
  { key: "grade", text: "Current grade C", note: "screen cracked", amount: null },
  { key: "repair", text: "Repair ₹34,096", note: null, amount: 34096 },
];
/** F10 — staff, traded: F3's lines with the locked premium in the staff note. */
const F10_STAFF_NOTES = { market: null, we_pay: "Includes ₹1,000 SwapUp premium (4%).", bonus: "Upgrade bonus · 4%" };

/** Which line keys each status shows — the same table is in swapup-mobile's tests. */
const KEYS_BY_STATUS: [string, Partial<AnswerInput>, string[]][] = [
  ["quoted, ready", {}, ["grade", "market", "we_pay", "bonus", "repair"]],
  ["draft, no price yet (not ready)", { status: "draft", market: null }, ["grade", "repair"]],
  ["quoted, PriceIQ estimate (not ready)", { market: { amount: 25_000, source: "priceiq", priceGrade: "Fair" } }, ["grade", "market", "we_pay", "bonus", "repair"]],
  ["repair_chosen", { status: "repair_chosen" }, ["grade", "repair"]],
  ["locked (traded)", { status: "locked", locked: LOCKED }, ["grade", "market", "we_pay", "bonus"]],
  ["cleared (traded)", { status: "cleared", locked: LOCKED }, ["grade", "market", "we_pay", "bonus"]],
  ["walked_away", { status: "walked_away" }, ["grade", "market", "we_pay", "bonus", "repair"]],
  ["cancelled", { status: "cancelled", locked: LOCKED }, []],
];

/* ─────────────────────────── the words and their order ─────────────────────────── */

test("answer F1: the owner's lines, word for word and in order — grade · market price · we pay · bonus · repair", () => {
  const a = buildAnswer(f1());
  assert.deepEqual(customerAnswer(a), F1);
  assert.deepEqual(a.lines.map((l) => l.key), ["grade", "market", "we_pay", "bonus", "repair"]);
  // We pay = the market price + the 4% premium (premium.ts); the premium itself is never a customer word.
  assert.equal(a.wePay, 25_000 + 1_000);
  assert.ok(!JSON.stringify(customerAnswer(a)).toLowerCase().includes("premium"));
});

test("answer F6: the staff answer is F1 plus the source, the premium, the bonus %, the new phone's price and the staff notes", () => {
  assert.deepEqual(buildAnswer(f1()), F6);
});

test("answer F2: no price yet — one sentence for the customer, never half an offer", () => {
  const a = buildAnswer(f1({ market: null }));
  assert.equal(a.ready, false);
  assert.equal(a.text, WORKING_OUT);
  assert.deepEqual(customerAnswer(a), F2);
  // Staff still see what there is: the grade and the repair.
  assert.deepEqual(a.lines.map((l) => l.key), ["grade", "repair"]);
  for (const over of [{ quoteExpired: true }, { quoteBlocked: true }] as Partial<AnswerInput>[]) {
    assert.deepEqual(customerAnswer(buildAnswer(f1(over))), F2, JSON.stringify(over));
  }
});

test("answer F3 + F10: traded in — the locked figures, 'We paid you', the bonus with the phone, no repair line, and final", () => {
  // The quote JSON has moved on since; the locked figures win.
  const a = buildAnswer(f1({ status: "locked", market: { amount: 99_999, source: "partner_manual", priceGrade: null }, locked: LOCKED }));
  assert.deepEqual(customerAnswer(a), F3);
  assert.deepEqual(a.staffNotes, F10_STAFF_NOTES);
  assert.equal(a.final, true);
  for (const s of ["locked", "in_pickup", "collected", "cleared", "regraded", "rejected", "not_received"]) {
    const t = buildAnswer(f1({ status: s, locked: LOCKED }));
    assert.equal(t.headline, "Traded in", s);
    assert.equal(t.ready && t.final, true, s);
    assert.ok(!t.lines.some((l) => l.key === "repair"), s);
  }
});

test("answer: a case locked before premiums (premium_value NULL) — we paid the market price, and no premium note", () => {
  const a = buildAnswer(f1({ status: "locked", locked: { ...LOCKED, premium: null, premiumBp: null } }));
  assert.equal(a.wePay, 25_000);
  assert.equal(a.premium, null);
  assert.equal(a.staffNotes.we_pay, null);
  assert.equal(a.lines.find((l) => l.key === "we_pay")!.text, "We paid you ₹25,000");
});

test("answer F4: a covered repair — 'or repair it free — covered by warranty' (or Care+) at ₹0, and the headline says so", () => {
  const input = f1({
    condition: cond({ screen: "lines_or_spots" }),
    market: { amount: 30_000, source: "partner_ratecard", priceGrade: null },
    repair: { amount: 0, covered: true, coverage: "warranty", nothingToRepair: false },
    newPhone: null,
    bonus: null,
    bonusWhy: "Choose the new phone to see the bonus.",
    recommendation: "repair",
  });
  assert.deepEqual(customerAnswer(buildAnswer(input)), F4);
  const care = buildAnswer({ ...input, repair: { ...input.repair, coverage: "care_plus" } });
  assert.equal(care.lines.at(-1)!.text, "or repair it free — covered by Care+");
});

test("answer F5: nothing to repair, no campaign — grade, market and we pay only", () => {
  const a = buildAnswer(f1({ condition: cond(), repair: { amount: null, covered: false, coverage: "none", nothingToRepair: true }, bonus: null, bonusWhy: "No bonus campaign today.", recommendation: "no_repair" }));
  assert.deepEqual(customerAnswer(a), F5);
  assert.equal(a.staffNotes.bonus, "No bonus campaign today.", "no bonus: the staff note is Offer.swap.bonusWhy");
});

test("answer F8: a PriceIQ trade-in — staff see every line with the estimate note; the customer is 'confirming'", () => {
  const a = buildAnswer(f1({ market: { amount: 25_000, source: "priceiq", priceGrade: "Fair" } }));
  assert.equal(a.ready, false);
  assert.equal(a.text, CONFIRMING);
  assert.deepEqual(a.staffNotes, F8_STAFF_NOTES);
  assert.deepEqual(customerAnswer(a), F8_CUSTOMER);
  assert.deepEqual(a.lines.map((l) => l.text), F6.lines.map((l) => l.text), "the same lines as a partner price would give");
  // The partner's rate card is the partner's own price: ready.
  assert.equal(buildAnswer(f1({ market: { amount: 25_000, source: "partner_ratecard", priceGrade: null } })).ready, true);
  // A retired source (an older build's quote) is never the partner's price.
  assert.equal(buildAnswer(f1({ market: { amount: 25_000, source: "retired", priceGrade: null } })).ready, false);
});

test("answer F9: repair chosen — 'Repair chosen', the grade and 'Repair ₹34,096' (or covered), final", () => {
  const a = buildAnswer(f1({ status: "repair_chosen" }));
  assert.equal(a.headline, "Repair chosen");
  assert.deepEqual(a.lines, F9_LINES);
  assert.equal(a.ready && a.final, true);
  assert.equal(a.wePay, null);
  const covered = buildAnswer(f1({ status: "repair_chosen", repair: { amount: 0, covered: true, coverage: "warranty", nothingToRepair: false } }));
  assert.equal(covered.lines.at(-1)!.text, "Repair — covered by warranty");
});

test("answer: walked away — the lines as last worked out, final; cancelled — one sentence, no lines", () => {
  const w = buildAnswer(f1({ status: "walked_away" }));
  assert.equal(w.ready, true);
  assert.equal(w.final, true);
  assert.equal(w.headline, "An upgrade is worth considering");
  const c = buildAnswer(f1({ status: "cancelled", locked: LOCKED }));
  assert.deepEqual(customerAnswer(c), { ready: false, final: true, text: CANCELLED_TEXT, test: false });
  assert.deepEqual(c.lines, []);
});

test("answer: which lines each status shows (the shared table)", () => {
  for (const [name, over, keys] of KEYS_BY_STATUS) assert.deepEqual(buildAnswer(f1(over)).lines.map((l) => l.key), keys, name);
});

test("answer: each customer headline (decide()'s, with 'your choice' for the customer)", () => {
  const rows: [AnswerInput["recommendation"], string][] = [
    ["repair", "Repair recommended"],
    ["upgrade", "An upgrade is worth considering"],
    ["either", "Either works — your choice"],
    ["no_repair", "Nothing to repair — a straight trade-in"],
    ["cannot_say", "Your offer"],
    [null, "Your offer"],
  ];
  for (const [rec, h] of rows) assert.equal(buildAnswer(f1({ recommendation: rec })).headline, h, String(rec));
});

/* ─────────────────────────── the grade line (R5) ─────────────────────────── */

test("grade: a defect prints the letter alone, with the defect as the note; no defect prints the word too", () => {
  const line = (c: ConditionAnswers) => {
    const g = buildAnswer(f1({ condition: c })).lines.find((l) => l.key === "grade")!;
    return [g.text, g.note];
  };
  // Clean body, cracked screen: the screen is a repair, so the look is Superb.
  assert.deepEqual(line(cond({ screen: "cracked" })), ["Current grade A", "screen cracked"]);
  // A cracked back: the back glass is a repair, so the look is Superb — the grade it is priced at and comes out at.
  assert.deepEqual(line(cond({ body: "back_cracked" })), ["Current grade A", "back glass cracked"]);
  // Dents are a look the letter prices: no note.
  assert.deepEqual(line(cond({ body: "dented" })), ["Current grade C (Fair)", null]);
  assert.deepEqual(line(cond({ body: "scuffed", screen: "scratched" })), ["Current grade B (Good)", null]);
  assert.deepEqual(line(cond({ body: "bent" })), ["Current grade D (Best Value)", null]);
  assert.deepEqual(line(cond()), ["Current grade A (Superb)", null]);
});

test("ONE grade: the grade line is the grade the trade-in is priced at and the grade after refurb — for every screen and body", () => {
  for (const screen of ["flawless", "scratched", "lines_or_spots", "cracked", "not_working"] as const)
    for (const body of ["flawless", "scuffed", "dented", "back_cracked", "bent"] as const) {
      const c = cond({ screen, body });
      const g = buildAnswer(f1({ condition: c, market: { amount: 25_000, source: "partner_ratecard", priceGrade: tradeInGrade(c) } }));
      assert.equal(g.grade!.word, tradeInGrade(c), `${screen}/${body}: shown = priced`);
      assert.equal(g.grade!.word, gradeAfterRefurb(c), `${screen}/${body}: shown = after refurb`);
      assert.equal(g.market!.word, g.grade!.word, `${screen}/${body}: the market line names the grade line's grade`);
    }
  assert.equal(buildAnswer(f1({ condition: null })).lines[0].key, "market", "no condition, no grade line");
  assert.equal(buildAnswer(f1({ condition: null })).lines[0].text, "Market price ₹25,000");
});

test("grade note: a dead phone says only that; at most two defects, then '+N more'; never scratches, scuffs, dents or a bent frame", () => {
  assert.equal(defectNote(cond({ powersOn: false, screen: "cracked", issues: ["battery"] })), "doesn't switch on");
  assert.equal(defectNote(cond({ calls: false })), "calls don't work");
  assert.equal(defectNote(cond({ screen: "not_working" })), "screen not working");
  assert.equal(defectNote(cond({ screen: "cracked", body: "back_cracked" })), "screen cracked, back glass cracked");
  assert.equal(defectNote(cond({ calls: false, screen: "cracked", body: "back_cracked", issues: ["battery", "mic"] })), "calls don't work, screen cracked, +3 more");
  assert.equal(defectNote(cond({ issues: ["speaker"] })), "speaker faulty");
  for (const c of [cond({ screen: "scratched" }), cond({ body: "scuffed" }), cond({ body: "dented" }), cond({ body: "bent" })]) assert.equal(defectNote(c), null);
});

test("market line: priced from a LOWER grade than the phone's — 'Market price ₹X' with no grade; the detail is staff-only", () => {
  // The phone looks Good (scuffs); the only listing was at Fair.
  const a = buildAnswer(f1({ condition: cond({ body: "scuffed" }), market: { amount: 25_000, source: "partner_ratecard", priceGrade: "Fair" } }));
  assert.equal(a.lines.find((l) => l.key === "market")!.text, "Market price ₹25,000");
  assert.equal(a.market!.letter, null);
  assert.equal(a.staffNotes.market, "Priced at grade C — none listed at grade B.");
  assert.equal(customerAnswer(a).ready, true);
  // At the phone's own grade: named.
  const own = buildAnswer(f1({ condition: cond({ body: "scuffed" }), market: { amount: 25_000, source: "partner_ratecard", priceGrade: "Good" } }));
  assert.equal(own.lines.find((l) => l.key === "market")!.text, "Market price for grade B ₹25,000");
  assert.equal(own.staffNotes.market, null);
});

/**
 * F11 — a cracked back on a per-grade card (max 40,000 · good 30,000 · fair 25,000 · best value
 * 20,000): its look is Superb, so the card prices it off grade A less 15% back glass = ₹34,000.
 * ONE grade (owner, 2026-10-22: "grade match"): the grade line shows grade A, the market line names
 * grade A, and its note is the sum — "₹40,000 less ₹6,000 for back glass cracked".
 */
const PER_GRADE: RateCard = {
  ...CARD,
  deductions: DEFECT_DEDUCTIONS,
  source: { kind: "partner_ratecard", label: "Week 43", effectiveFrom: "2026-10-19" },
  entries: [{ modelId: "galaxy-s23-ultra", variant: "256GB", maxPrice: 40_000, gradePrices: { Good: 30_000, Fair: 25_000, "Best Value": 20_000 } }],
};
const BACK_CRACKED = cond({ body: "back_cracked", accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
const F11_LINES = [
  { key: "grade", text: "Current grade A", note: "back glass cracked", amount: null },
  { key: "market", text: "Market price for grade A ₹34,000", note: "₹40,000 less ₹6,000 for back glass cracked", amount: 34000 },
  { key: "we_pay", text: "We pay you ₹35,020", note: null, amount: 35020 },
];
/** What offer.ts hands the answer for a rate-card quote: the grade's price (the trace's base) and the words taken off. */
const fromQuote = (q: Extract<ReturnType<typeof priceFromCard>, { status: "priced" }>): AnswerInput["market"] => ({
  amount: q.amount,
  source: "partner_ratecard",
  priceGrade: q.grade ?? null,
  gradePrice: q.lines[0].amount,
  takenOff: q.lines.flatMap((l) => (l.word && l.amount < 0 ? [l.word] : [])),
});

test("market line F11: a cracked back on a per-grade card — grade A shown, grade A priced, the deduction worked out on the line", () => {
  const q = priceFromCard(PER_GRADE, "galaxy-s23-ultra", "256GB", BACK_CRACKED);
  assert.ok(q.status === "priced");
  if (q.status !== "priced") return;
  assert.deepEqual([q.amount, q.grade], [34_000, "Superb"], "grade A's price less 15% back glass");
  const a = buildAnswer(f1({ condition: BACK_CRACKED, market: fromQuote(q), newPhone: null, bonus: null, repair: { amount: null, covered: false, coverage: "none", nothingToRepair: true } }));
  const c = customerAnswer(a);
  assert.ok(c.ready);
  if (!c.ready) return;
  assert.deepEqual(c.lines, F11_LINES);
  assert.deepEqual(c.grade, { letter: "A", word: "Superb", note: "back glass cracked" });
  assert.deepEqual(c.market, { amount: 34_000, letter: "A", word: "Superb" });
  assert.equal(a.staffNotes.market, null, "nothing for staff to explain: the line says it");
  // Only a LOWER grade's price names no grade: a card with nothing listed at the phone's grade.
  const atC = buildAnswer(f1({ condition: cond({ body: "scuffed" }), market: { amount: 21_250, source: "partner_ratecard", priceGrade: "Fair", gradePrice: 25_000 } }));
  assert.equal(atC.lines.find((l) => l.key === "market")!.text, "Market price ₹21,250");
  assert.equal(atC.lines.find((l) => l.key === "market")!.note, null);
  assert.equal(atC.staffNotes.market, "Priced at grade C (₹25,000 less ₹3,750) — none listed at grade B.");
  // Every look names its own grade, with nothing taken off: no note.
  for (const body of ["flawless", "scuffed", "dented", "bent"] as const) {
    const ph = cond({ body, accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
    const pq = priceFromCard(PER_GRADE, "galaxy-s23-ultra", "256GB", ph);
    assert.ok(pq.status === "priced");
    if (pq.status !== "priced") continue;
    const own = buildAnswer(f1({ condition: ph, market: fromQuote(pq) }));
    assert.equal(own.market!.word, tradeInGrade(ph), body);
    assert.equal(own.lines.find((l) => l.key === "market")!.note, null, body);
    assert.equal(own.staffNotes.market, null, body);
  }
});

test("market line: every rate-card price adds up on the line — grade price less what was taken off is M, whatever the condition", () => {
  const screens = ["flawless", "scratched", "lines_or_spots", "cracked", "not_working"] as const;
  const bodies = ["flawless", "scuffed", "dented", "back_cracked", "bent"] as const;
  const extras: Partial<ConditionAnswers>[] = [
    {},
    { issues: ["liquid"] },
    { issues: ["battery", "rear_camera", "speaker"] },
    { calls: false },
    { powersOn: false },
    { accessories: { charger: false, box: false, bill: false }, age: "gt11m" },
  ];
  for (const screen of screens)
    for (const body of bodies)
      for (const x of extras) {
        const c = cond({ screen, body, ...x });
        const q = priceFromCard(PER_GRADE, "galaxy-s23-ultra", "256GB", c);
        const where = `${screen}/${body}/${JSON.stringify(x)}`;
        assert.ok(q.status === "priced", where);
        if (q.status !== "priced") continue;
        const a = buildAnswer(f1({ condition: c, market: fromQuote(q) }));
        const g = a.lines.find((l) => l.key === "grade")!;
        const m = a.lines.find((l) => l.key === "market")!;
        const letter = a.grade!.letter;
        assert.equal(q.grade, tradeInGrade(c), `${where}: priced at the SwapUp grade`);
        assert.match(g.text, new RegExp(`^Current grade ${letter}\\b`), where);
        assert.equal(m.text, `Market price for grade ${letter} ₹${q.amount.toLocaleString("en-IN")}`, `${where}: the grade shown is the grade priced`);
        if (q.amount < q.lines[0].amount) {
          const sum = /^₹([\d,]+) less ₹([\d,]+)( for .+)?$/.exec(m.note ?? "");
          assert.ok(sum, `${where}: ${m.note}`);
          const n = (s: string) => Number(s.replace(/,/g, ""));
          assert.equal(n(sum![1]) - n(sum![2]), q.amount, `${where}: the sum adds up`);
          assert.equal(n(sum![1]), q.lines[0].amount, `${where}: from the grade's own price`);
        } else assert.equal(m.note, null, where);
      }
});

/* ─────────────────────────── staff notes ─────────────────────────── */

test("staff notes: a lifted premium says so; a capped bonus says the cap", () => {
  const lifted = buildAnswer(f1({ market: { amount: 15_001, source: "partner_manual", priceGrade: null } }));
  assert.equal(lifted.wePay, 15_750);
  assert.equal(lifted.staffNotes.we_pay, "Includes ₹749 SwapUp premium (4%, lifted to what ₹15,000 earns).");
  const capped = buildAnswer(f1({ bonus: { amount: 6_000, bp: 400, cap: 6_000 } }));
  assert.equal(capped.staffNotes.bonus, "Upgrade bonus · capped at ₹6,000");
  assert.equal(capped.lines.find((l) => l.key === "bonus")!.text, "+ ₹6,000 bonus if you exchange with a new device");
});

test("no new phone, no bonus line — and no market price, no bonus line either", () => {
  assert.ok(!buildAnswer(f1({ newPhone: null })).lines.some((l) => l.key === "bonus"));
  assert.ok(!buildAnswer(f1({ market: null })).lines.some((l) => l.key === "bonus"));
  assert.ok(!buildAnswer(f1({ bonus: { amount: 0, bp: 0, cap: null } })).lines.some((l) => l.key === "bonus"));
});

test("a test programme carries test: true on both slices", () => {
  const a = buildAnswer(f1({ testProgramme: true }));
  assert.equal(a.test, true);
  assert.equal(customerAnswer(a).test, true);
  assert.equal(customerAnswer(buildAnswer(f1({ testProgramme: true, market: null }))).test, true);
});

/* ─────────────────────────── the customer slice is a strict whitelist ─────────────────────────── */

const ALLOWED_PATHS = new Set([
  "ready", "final", "text", "test", "headline",
  "grade", "grade.letter", "grade.word", "grade.note",
  "market", "market.amount", "market.letter", "market.word",
  "wePay", "bonus", "bonus.amount", "newPhone", "newPhone.label",
  "repair", "repair.amount", "repair.covered", "repair.nothingToRepair",
  "lines", "lines[].key", "lines[].text", "lines[].note", "lines[].amount",
]);
function paths(x: unknown, at = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((v) => paths(v, `${at}[]`));
  if (!x || typeof x !== "object") return [];
  return Object.entries(x).flatMap(([k, v]) => {
    const p = at ? `${at}.${k}` : k;
    return [p, ...paths(v, p)];
  });
}

test("customer slice: every key on a strict whitelist — never a source, %, premium, staff note or the new phone's price", () => {
  const all: Answer[] = [
    ...KEYS_BY_STATUS.map(([, over]) => buildAnswer(f1(over))),
    buildAnswer(f1({ testProgramme: true })),
    buildAnswer(f1({ market: { amount: 15_001, source: "partner_manual", priceGrade: null } })),
  ];
  for (const a of all) {
    const c = customerAnswer(a);
    for (const p of paths(c)) assert.ok(ALLOWED_PATHS.has(p.replace(/^lines\[\]\[\]/, "lines[]")), `${p} is not on the whitelist`);
    const json = JSON.stringify(c);
    for (const word of ["premium", "source", "staffNotes", "partner", "priceiq", "154999", "\"bp\""]) assert.ok(!json.toLowerCase().includes(word.toLowerCase()), word);
  }
});

test("every line is at most 15 words, one sentence", () => {
  const all = KEYS_BY_STATUS.flatMap(([, over]) => buildAnswer(f1(over)).lines);
  for (const l of [...all, ...F1.lines, ...F3.lines, ...F4.lines, ...F5.lines]) {
    assert.ok(l.text.split(/\s+/).length <= 15, l.text);
    assert.ok(!/[.!?]\s/.test(l.text), l.text);
  }
});

test("a rate-card price with something taken off names its grade and works it out (liquid damage on a grade-A phone)", () => {
  const a = buildAnswer(
    f1({
      condition: { powersOn: true, calls: true, screen: "flawless", body: "flawless", issues: ["liquid"] },
      market: { amount: 19_220, source: "partner_ratecard", priceGrade: "Superb", gradePrice: 34_960, takenOff: ["signs of liquid damage"] },
    }),
  );
  const m = a.lines.find((l) => l.key === "market")!;
  assert.equal(m.text, "Market price for grade A ₹19,220");
  assert.equal(m.note, "₹34,960 less ₹15,740 for signs of liquid damage");
  assert.equal(a.staffNotes.market, null);
  // Three things taken off: at most two named, then "+N more"; a quote from before words: the sum alone.
  const three = buildAnswer(f1({ condition: cond(), market: { amount: 30_000, source: "partner_ratecard", priceGrade: "Superb", gradePrice: 34_960, takenOff: ["no charger", "no box", "age over 11 months"] } }));
  assert.equal(three.lines.find((l) => l.key === "market")!.note, "₹34,960 less ₹4,960 for no charger, no box, +1 more");
  const old = buildAnswer(f1({ condition: cond(), market: { amount: 30_000, source: "partner_ratecard", priceGrade: "Superb", gradePrice: 34_960 } }));
  assert.equal(old.lines.find((l) => l.key === "market")!.note, "₹34,960 less ₹4,960");
  // Nothing taken off: named exactly as before.
  const b = buildAnswer(
    f1({ condition: { powersOn: true, calls: true, screen: "flawless", body: "flawless", issues: [] }, market: { amount: 34_960, source: "partner_ratecard", priceGrade: "Superb", gradePrice: 34_960 } }),
  );
  const n = b.lines.find((l) => l.key === "market")!;
  assert.deepEqual([n.text, n.note], ["Market price for grade A ₹34,960", null]);
});

test("a card row with only its top price (the week-42 iPhone rows) is grade A's price: a grade-A phone names A and works it out; B–D name no grade", () => {
  const TOP_ONLY: RateCard = { ...PER_GRADE, entries: [{ modelId: "iphone-14", variant: "128GB", maxPrice: 27_780 }] };
  const quote = (c: ConditionAnswers) => {
    const q = priceFromCard(TOP_ONLY, "iphone-14", "128GB", c);
    assert.ok(q.status === "priced" && q.grade === undefined);
    return q as Extract<typeof q, { status: "priced" }>;
  };
  // What offer.ts hands the answer for such a row: priced at grade A, from the row's top price.
  const fromTop = (q: ReturnType<typeof quote>): AnswerInput["market"] => ({ ...fromQuote(q)!, priceGrade: "Superb" });
  const back = cond({ body: "back_cracked", accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
  const a = buildAnswer(f1({ condition: back, market: fromTop(quote(back)) }));
  const m = a.lines.find((l) => l.key === "market")!;
  assert.deepEqual([m.text, m.note], ["Market price for grade A ₹23,610", "₹27,780 less ₹4,170 for back glass cracked"]);
  const scuffedCracked = cond({ screen: "cracked", body: "scuffed", accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
  const b = buildAnswer(f1({ condition: scuffedCracked, market: fromTop(quote(scuffedCracked)) }));
  const n = b.lines.find((l) => l.key === "market")!;
  assert.deepEqual([b.grade!.letter, n.text, n.note], ["B", "Market price ₹15,830", null]);
  assert.equal(b.staffNotes.market, "Priced at grade A (₹27,780 less ₹11,950) — none listed at grade B.");
});

test("the market note's words read as a sum for a dead phone and dead calls", () => {
  const dead = cond({ powersOn: false, accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
  const q = priceFromCard(PER_GRADE, "galaxy-s23-ultra", "256GB", dead);
  assert.ok(q.status === "priced");
  if (q.status !== "priced") return;
  assert.match(buildAnswer(f1({ condition: dead, market: fromQuote(q) })).lines.find((l) => l.key === "market")!.note ?? "", / for not switching on$/);
  const calls = cond({ calls: false, accessories: { charger: true, box: true, bill: true }, age: "lt3m" });
  const c = priceFromCard(PER_GRADE, "galaxy-s23-ultra", "256GB", calls);
  if (c.status !== "priced") return assert.fail("priced");
  assert.match(buildAnswer(f1({ condition: calls, market: fromQuote(c) })).lines.find((l) => l.key === "market")!.note ?? "", / for calls not working$/);
});
