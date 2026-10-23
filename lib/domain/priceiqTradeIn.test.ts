import { test } from "node:test";
import assert from "node:assert/strict";
import { priceiqTradeIn, tradeInGrade, tradeInLine, priceiqLabel, SWAPUP_DEDUCTIONS, type DeductionTable } from "./priceiqTradeIn.ts";
import { marketSell, sellFromListing, type ListingRow, type MarketAnswer } from "./marketSell.ts";
import { DEFECT_DEDUCTIONS, linesSum, type QuoteLine } from "./ratecard.ts";
import type { ConditionAnswers, IssueId } from "./condition.ts";
import { CARD } from "./fixtures.ts";

// PriceIQ's answer for the Galaxy S23 Ultra 256GB — the contract's acceptance figures: the LOWEST listing per grade.
const S23U: ListingRow[] = [
  { grade: "Superb", price: 53_499, week: "2026-W35", points: 2 },
  { grade: "Good", price: 51_399, week: "2026-W35", points: 2 },
  { grade: "Fair", price: 49_399, week: "2026-W35", points: 2 },
  { grade: "Best Value", price: 47_199, week: "2026-W35", points: 1 },
];
const ASOF = "2026-10-18T09:00:00.000Z";
const ans = (rows: ListingRow[] = S23U, over: Partial<MarketAnswer> = {}): MarketAnswer => ({
  rows,
  week: "2026-W35",
  observedAt: "2026-10-12T06:57:05.000Z", // 6 days before ASOF: fresh
  fetchedAt: "2026-10-18T08:30:00.000Z",
  unreachable: false,
  ...over,
});
const LABEL = "Galaxy S23 Ultra 256GB";
const piq = (x: Omit<Parameters<typeof priceiqTradeIn>[0], "answer" | "asOf" | "label"> & { rows?: ListingRow[]; answer?: MarketAnswer | null; asOf?: string; label?: string }) =>
  priceiqTradeIn({ answer: x.answer === undefined ? ans(x.rows) : x.answer, asOf: x.asOf ?? ASOF, label: x.label ?? LABEL, ...x });

const cond = (over: Partial<ConditionAnswers> = {}): ConditionAnswers => ({
  powersOn: true,
  calls: true,
  screen: "flawless",
  body: "flawless",
  issues: [],
  accessories: { charger: true, box: true, bill: true },
  age: "gt11m",
  ...over,
});
const lineAmounts = (lines: QuoteLine[]) => lines.map((l) => [l.label, l.bp ?? null, l.amount]);

test("the grade it is priced at: the SwapUp grade's look — a defect is deducted, never graded down as well", () => {
  const rows: [Partial<ConditionAnswers>, string | null][] = [
    [{}, "Superb"],
    [{ screen: "scratched" }, "Good"],
    [{ body: "scuffed" }, "Good"],
    [{ body: "dented" }, "Fair"],
    [{ body: "bent" }, "Best Value"],
    [{ screen: "scratched", body: "dented" }, "Fair"],
    // what the grade can't see is a defect: the other part sets the grade
    [{ screen: "cracked" }, "Superb"],
    [{ screen: "lines_or_spots", body: "scuffed" }, "Good"],
    [{ screen: "not_working", body: "dented" }, "Fair"],
    [{ body: "back_cracked" }, "Superb"],
    [{ screen: "scratched", body: "back_cracked" }, "Good"],
  ];
  for (const [over, want] of rows) assert.equal(tradeInGrade(cond(over)), want, JSON.stringify(over));
  assert.equal(tradeInGrade(null), null);
});

test("table: the trade-in for each kind of phone, rupee for rupee — listing − the 5%→2% markdown − SwapUp's % per defect", () => {
  type Row = { name: string; rows?: ListingRow[]; c: Partial<ConditionAnswers>; table?: DeductionTable; amount: number; grade: string; wanted: string; defects: number; lines: (string | number | null)[][] };
  const table: Row[] = [
    {
      name: "the contract's check: a flawless S23 Ultra 256GB starts from ₹53,499 (Superb), less 2%",
      c: {},
      amount: 52_420,
      grade: "Superb",
      wanted: "Superb",
      defects: 0,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070], // 53,499 × 98% = 52,429.02 → 52,429
        ["Rounded down to ₹10", null, -9],
      ],
    },
    {
      name: "no defects: the Good listing less 2% (over ₹50,000), rounded down to ₹10",
      c: { body: "scuffed" },
      amount: 50_370,
      grade: "Good",
      wanted: "Good",
      defects: 0,
      lines: [
        ["Refurbished market price (Good) · PriceIQ", null, 51_399],
        ["Below the market price", 200, -1_028],
        ["Rounded down to ₹10", null, -1],
      ],
    },
    {
      name: "the owner's case: Good, rear camera failed, battery under 80% — two defects, each % of the listing",
      c: { body: "scuffed", issues: ["battery", "rear_camera"] },
      amount: 36_490,
      grade: "Good",
      wanted: "Good",
      defects: 2,
      lines: [
        ["Refurbished market price (Good) · PriceIQ", null, 51_399],
        ["Below the market price", 200, -1_028],
        ["Battery drains / swollen", 900, -4_625], // 4,625.91 → down
        ["Rear camera faulty", 1_800, -9_251], // 9,251.82 → down
        ["Rounded down to ₹10", null, -5],
      ],
    },
    {
      name: "no Fair listing: the next LOWER grade, named — never a higher one; 3% under ₹50,000",
      rows: S23U.filter((r) => r.grade !== "Fair"),
      c: { body: "dented" },
      amount: 45_780,
      grade: "Best Value",
      wanted: "Fair",
      defects: 0,
      lines: [
        ["Refurbished market price (Best Value) · PriceIQ", null, 47_199],
        ["Below the market price", 300, -1_416],
        ["Rounded down to ₹10", null, -3],
      ],
    },
    {
      name: "scratches and dents are the grade's: nothing deducted for them again",
      c: { screen: "scratched", body: "dented" },
      amount: 47_910,
      grade: "Fair",
      wanted: "Fair",
      defects: 0,
      lines: [
        ["Refurbished market price (Fair) · PriceIQ", null, 49_399],
        ["Below the market price", 300, -1_482],
        ["Rounded down to ₹10", null, -7],
      ],
    },
    {
      name: "a cracked back is a defect: deducted, and the grade is the screen's",
      c: { body: "back_cracked" },
      amount: 44_400,
      grade: "Superb",
      wanted: "Superb",
      defects: 1,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070],
        ["Body: Back glass cracked", 1_500, -8_024],
        ["Rounded down to ₹10", null, -5],
      ],
    },
    {
      name: "a dead phone is priced on that alone — nothing else can be assessed",
      c: { powersOn: false, screen: "not_working", issues: ["touch"] },
      amount: 12_300,
      grade: "Superb",
      wanted: "Superb",
      defects: 1,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070],
        ["Does not switch on (priced as non-working)", 7_500, -40_124],
        ["Rounded down to ₹10", null, -5],
      ],
    },
    {
      name: "no calls is a defect",
      c: { calls: false },
      amount: 41_730,
      grade: "Superb",
      wanted: "Superb",
      defects: 1,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070],
        ["Calls / network not working", 2_000, -10_699],
      ],
    },
    {
      name: "several defects past the cap: SwapUp's 85% cap gives the rest back, as its own line",
      c: { screen: "cracked", issues: ["liquid", "touch"] },
      amount: 6_950,
      grade: "Superb",
      wanted: "Superb",
      defects: 3,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070],
        ["Screen: Cracked glass", 4_000, -21_399],
        ["Signs of liquid damage", 4_500, -24_074],
        ["Touch not responding", 3_000, -16_049],
        ["Deductions capped", null, 16_048], // 61,522 off → 45,474 (85% of 53,499)
        ["Rounded down to ₹10", null, -5],
      ],
    },
    {
      name: "the table's minimum: never below its floor % of the listing",
      c: { powersOn: false },
      table: { ...SWAPUP_DEDUCTIONS, maxDeductionBp: 10_000, deductions: { ...DEFECT_DEDUCTIONS, deadBp: 9_900 } },
      amount: 3_200,
      grade: "Superb",
      wanted: "Superb",
      defects: 1,
      lines: [
        ["Refurbished market price (Superb) · PriceIQ", null, 53_499],
        ["Below the market price", 200, -1_070],
        ["Does not switch on (priced as non-working)", 9_900, -52_964],
        ["Raised to the card's minimum for this model", null, 3_744], // 6% of 53,499 = 3,209
        ["Rounded down to ₹10", null, -9],
      ],
    },
  ];
  for (const t of table) {
    const p = piq({ rows: t.rows, condition: cond(t.c), table: t.table });
    assert.equal(p.status, "priced", t.name);
    if (p.status !== "priced") continue;
    assert.deepEqual(lineAmounts(p.lines), t.lines, t.name);
    assert.equal(p.amount, t.amount, t.name);
    assert.equal(linesSum(p.lines), p.amount, `${t.name}: the lines add up`);
    assert.equal(p.grade, t.grade, t.name);
    assert.equal(p.gradeWanted, t.wanted, t.name);
    assert.equal(p.defects, t.defects, t.name);
    assert.equal(p.listings, S23U.find((r) => r.grade === t.grade)!.points, `${t.name}: PriceIQ's distinct prices`);
  }
});

test("the markdown is the SELL side's own (owner: one margin below the market price everywhere) — 5%, 4%, 3%, 2% by band", () => {
  const at = (price: number) => piq({ rows: [{ grade: "Superb", price, week: "2026-W35" }], condition: cond() });
  for (const [price, bp] of [
    [12_999, 500],
    [15_000, 500],
    [22_999, 400],
    [30_000, 400],
    [41_999, 300],
    [50_000, 300],
    [50_001, 200],
  ] as const) {
    const p = at(price);
    assert.equal(p.status, "priced");
    if (p.status !== "priced") continue;
    assert.equal(p.markdownBp, bp, `₹${price}`);
    assert.equal(p.lines[1].amount, sellFromListing(price).amount - price, `₹${price}: the same rupees as the sell price's markdown`);
  }
  // With no defects the trade-in IS the sell price, rounded down to the ₹10 step — no second, hidden margin.
  const sell = marketSell({ answer: ans(), condition: cond({ body: "scuffed" }), label: LABEL, asOf: ASOF });
  const p = piq({ condition: cond({ body: "scuffed" }) });
  assert.ok(p.status === "priced" && sell.amount !== null);
  if (p.status === "priced" && sell.amount !== null) assert.equal(p.amount, Math.floor(sell.amount / 10) * 10);
});

test("no listing, no price — with why; never a neighbour's model or a guessed grade", () => {
  assert.deepEqual(piq({ rows: [], answer: ans([], { week: null, observedAt: null }), condition: cond(), label: "Galaxy Z Fold6 256GB" }), {
    status: "unpriced",
    reason: "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.",
  });
  // listed only at a better grade than the phone: no price at that grade or below
  assert.deepEqual(piq({ rows: S23U.filter((r) => r.grade === "Superb"), condition: cond({ body: "scuffed" }) }), {
    status: "unpriced",
    reason: 'The market lists the Galaxy S23 Ultra 256GB only above "Good".',
  });
  assert.deepEqual(piq({ condition: null }), { status: "unpriced", reason: "The phone's condition isn't on the case yet." });
  // rows with no usable price are no listing at that grade
  const bad = piq({ rows: [{ grade: "Good", price: 0, week: "2026-W35" }, { grade: "Good", price: 12.5, week: "2026-W35" }], condition: cond({ body: "scuffed" }) });
  assert.equal(bad.status, "unpriced");
  // no answer from PriceIQ at all: no price yet — and the caller's reason when it has one
  assert.deepEqual(piq({ answer: null, condition: cond() }), { status: "unpriced", reason: "No refurbished market price yet." });
  assert.deepEqual(piq({ answer: null, noAnswerWhy: "No refurbished market price yet — PriceIQ isn't connected.", condition: cond() }), {
    status: "unpriced",
    reason: "No refurbished market price yet — PriceIQ isn't connected.",
  });
});

test("accessories and age are not defects — nothing taken off for them", () => {
  const p = piq({ condition: cond({ body: "scuffed", accessories: { charger: false, box: false, bill: false }, age: "gt11m" }) });
  assert.equal(p.status === "priced" && p.amount, 50_370);
});

test("SwapUp's own % table is the default; another table, when given, is used exactly as given", () => {
  const p = piq({ condition: cond({ body: "scuffed", issues: ["rear_camera"] }) });
  assert.ok(p.status === "priced");
  if (p.status === "priced") assert.deepEqual(p.lines[2], { label: "Rear camera faulty", bp: 1_800, amount: -9_251, word: "rear camera faulty" }); // SwapUp's 18%
  const card: DeductionTable = { deductions: CARD.deductions, maxDeductionBp: CARD.maxDeductionBp, floorBp: CARD.floorBp, roundTo: CARD.roundTo };
  const c = piq({ condition: cond({ body: "scuffed", issues: ["rear_camera"] }), table: card });
  assert.ok(c.status === "priced");
  if (c.status === "priced") assert.deepEqual(c.lines[2], { label: "Rear camera faulty", bp: 1_500, amount: -7_709, word: "rear camera faulty" }); // the test card's 15%
});

test("every condition: whole rupees, a multiple of the cash step, never above the marked-down listing, lines add up", () => {
  const screens = ["flawless", "scratched", "lines_or_spots", "cracked", "not_working"] as const;
  const bodies = ["flawless", "scuffed", "dented", "back_cracked", "bent"] as const;
  const issueSets: IssueId[][] = [[], ["battery"], ["rear_camera", "front_camera"], ["liquid", "touch", "charging", "speaker"]];
  for (const screen of screens)
    for (const body of bodies)
      for (const issues of issueSets)
        for (const powersOn of [true, false]) {
          const p = piq({ condition: cond({ screen, body, issues, powersOn }) });
          assert.equal(p.status, "priced");
          if (p.status !== "priced") continue;
          const where = `${screen}/${body}/${issues.join("+")}/${powersOn}`;
          assert.ok(Number.isInteger(p.amount) && p.amount % 10 === 0, where);
          assert.ok(p.amount <= sellFromListing(p.listing).amount, where);
          assert.ok(p.amount >= Math.floor(Math.floor((p.listing * 600) / 10_000) / 10) * 10, `${where}: never below the minimum`);
          assert.equal(linesSum(p.lines), p.amount, where);
          assert.ok(!p.lines.some((l) => /^Screen: (Visible scratches)|^Body: (Light scuffs|Dents|Bent)/.test(l.label)), `${where}: a look is never deducted`);
        }
});

test("old data: over 14 days the price stands WITH its age; over 90 days there is none", () => {
  // The data on file: week 2026-W35, observed 27 Aug 2026 — 52 days old on 18 Oct.
  const old = piq({ answer: ans(S23U, { observedAt: "2026-08-27T06:57:05.000Z" }), condition: cond({ body: "scuffed" }) });
  assert.equal(old.status, "priced");
  if (old.status === "priced") {
    assert.equal(old.amount, 50_370);
    assert.equal(old.ageDays, 52);
    assert.equal(old.stale, true);
    assert.equal(old.note, "Refurbished market price, week 2026-W35, 52 days old.");
  }
  const fresh = piq({ condition: cond({ body: "scuffed" }) });
  assert.ok(fresh.status === "priced" && fresh.stale === false && fresh.note === null && fresh.ageDays === 6);
  const tooOld = piq({ answer: ans(S23U, { observedAt: "2026-07-19T09:00:00.000Z", week: "2026-W29" }), condition: cond({ body: "scuffed" }) });
  assert.deepEqual(tooOld, { status: "unpriced", reason: "PriceIQ's prices for the Galaxy S23 Ultra 256GB are from 2026-W29 (91 days old) — too old to price." });
});

test("PriceIQ unreachable: the last good answer still prices, labelled with when it was got", () => {
  const p = piq({ answer: ans(S23U, { unreachable: true }), condition: cond({ body: "scuffed" }) });
  assert.ok(p.status === "priced");
  if (p.status === "priced") {
    assert.equal(p.amount, 50_370);
    assert.equal(p.note, "PriceIQ unreachable, last answer 2026-10-18 08:30 UTC.");
  }
});

test("the repaired value is priced like the trade-in: the grade after refurb, the same markdown, and every defect the repair doesn't explain", () => {
  // the owner's case after the camera and battery are replaced: Good (the scuffs stay), nothing left to deduct
  const r = piq({ condition: cond({ body: "scuffed" }), grade: "Good" });
  assert.equal(r.status === "priced" && r.amount, 50_370);
  // a ticked Wi-Fi issue nobody repairs stays deducted after a camera repair
  const w = piq({ condition: cond({ body: "scuffed", issues: ["wifi_bt"] }), grade: "Good" });
  assert.ok(w.status === "priced" && w.defects === 1 && w.amount < 50_370);
});

test("the one line and the label — the store margin's own words for the base, with the data's age when it is old", () => {
  assert.equal(
    tradeInLine({ grade: "Good", gradeWanted: "Good", listing: 51_399, markdownBp: 200, defects: 2, week: "2026-W35" }),
    "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35"
  );
  assert.equal(
    tradeInLine({ grade: "Good", gradeWanted: "Good", listing: 51_399, markdownBp: 200, defects: 2, week: "2026-W35", stale: true, ageDays: 52 }),
    "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35, 52 days old"
  );
  assert.equal(tradeInLine({ grade: "Good", gradeWanted: "Good", listing: 51_399, markdownBp: 200, defects: 1 }), "Refurbished market price ₹51,399 (Good) − 2% − 1 defect · PriceIQ");
  assert.equal(tradeInLine({ grade: "Good", gradeWanted: "Good", listing: 51_399, markdownBp: 200, defects: 0 }), "Refurbished market price ₹51,399 (Good) − 2% · PriceIQ");
  assert.equal(
    tradeInLine({ grade: "Best Value", gradeWanted: "Fair", listing: 47_199, markdownBp: 300, defects: 0 }),
    "Refurbished market price ₹47,199 (Best Value) − 3% · PriceIQ · none at Fair"
  );
  assert.equal(priceiqLabel({ grade: "Good", defects: 2 }), "PriceIQ · Good − defects");
  assert.equal(priceiqLabel({ grade: "Good", defects: 0 }), "PriceIQ · Good");
});
