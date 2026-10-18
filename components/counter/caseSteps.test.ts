import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RepairEstimate } from "../../lib/domain/repair.ts";
import type { ConditionAnswers } from "../../lib/domain/condition.ts";
import {
  STEP_ANCHOR,
  answerPage,
  canShow,
  conditionLine,
  faultsLine,
  landingStep,
  neighbours,
  phoneLine,
  progressLabel,
  repairLines,
  repairQuotePatch,
  repairQuoteProblem,
  repairStep,
  stepDone,
  stepFromAnchor,
  stepOrder,
  testedCase,
  type DoneView,
  type StepId,
} from "./caseSteps.ts";

/* ─────────────────────────── fixtures ─────────────────────────── */

const COND: ConditionAnswers = {
  powersOn: true,
  calls: true,
  screen: "cracked",
  body: "scuffed",
  issues: ["battery"],
  accessories: { charger: true, box: false, bill: false },
  age: "gt11m",
};
const DEVICE = { modelId: "m_s23u", brand: "Samsung", model: "Galaxy S23 Ultra", series: "S", variant: "256GB", releaseYear: 2023, supportEndYear: 2030, ageYears: 3 };
const SOURCE = { kind: "oem_public" as const, label: "Samsung India list price, excl. GST & labour (premium colour / max storage)", url: "https://example.invalid/price" };

function estimate(over: Partial<RepairEstimate> = {}): RepairEstimate {
  return {
    status: "quoted",
    basis: "book",
    lines: [
      { part: "battery", label: "Battery", faults: ["battery_drain"], listPrice: 2760, charged: 2760, covered: false, source: SOURCE },
      { part: "display", label: "Display assembly", faults: ["screen_cracked"], listPrice: 28470, charged: 28470, covered: false, source: SOURCE },
    ],
    labour: 500,
    gst: 5714,
    carePlusFee: 0,
    customerPays: 37444,
    listTotal: 37444,
    coverage: "none",
    inspectionFaults: [],
    missingParts: [],
    notes: ["Includes GST at 18% on parts and labour."],
    ...over,
  };
}

/** The owner's screen: a battery and a screen the book prices, a rear camera it doesn't, and liquid damage. */
const OWNERS_SCREEN = estimate({
  status: "needs_inspection",
  basis: null,
  lines: [
    { part: "battery", label: "Battery", faults: ["battery_drain"], listPrice: 2760, charged: 2760, covered: false, source: SOURCE },
    { part: "display", label: "Display assembly", faults: ["screen_cracked"], listPrice: 28470, charged: 28470, covered: false, source: SOURCE },
    { part: "rear_camera", label: "Rear camera", faults: ["rear_camera"], listPrice: null, charged: 0, covered: false, source: null },
  ],
  labour: 0,
  gst: 0,
  customerPays: null,
  listTotal: null,
  inspectionFaults: ["water_damage"],
  missingParts: ["rear_camera"],
  notes: ["Liquid damage can only be priced after a bench diagnosis — enter the service centre's quote."],
});

function view(over: Partial<DoneView & { manualRepair: unknown; repairNotServiced: string | null; imei: string | null; imeiCheck: "valid" | "invalid" | null; coverage: "none" | "warranty" | "care_plus" }> = {}) {
  return {
    device: DEVICE,
    faults: ["battery_drain", "screen_cracked"],
    condition: COND,
    conditionProblems: [],
    repair: estimate(),
    manualRepair: null,
    repairNotServiced: null,
    quote: { status: "priced", amount: 32000 },
    quoteExpired: false,
    upgrade: { label: "Samsung Galaxy S26 Ultra 256GB" },
    imei: "356938035643809",
    imeiCheck: "valid",
    coverage: "none",
    ...over,
  } as never;
}

const ALL: StepId[] = ["phone", "faults", "answer"];
const PARTNER: StepId[] = ["phone", "faults", "tradein"];
const land = (over: Partial<Parameters<typeof landingStep>[0]> = {}) =>
  landingStep({ steps: ALL, anchor: null, answerFirst: false, tested: false, editable: true, canLock: true, done: () => false, ...over });

/* ─────────────────────────── order, progress, back / next ─────────────────────────── */

test("the steps run Phone → What's wrong → The answer — the store app's order; Take the trade-in only once Swap up opened it", () => {
  assert.deepEqual(stepOrder({ answer: true, lock: false }), ALL);
  assert.deepEqual(stepOrder({ answer: true, lock: true }), [...ALL, "lock"]);
  // The partner gets no answer and never the store's repair quote: Trade-in is its step, and there is no trade-in to take.
  assert.deepEqual(stepOrder({ answer: false, lock: true }), PARTNER);
});

test("Repair quote and Trade-in are the answer's own pages, not steps to walk through", () => {
  assert.equal(answerPage(ALL, "repair"), true);
  assert.equal(answerPage(ALL, "tradein"), true);
  assert.equal(answerPage(ALL, "faults"), false);
  assert.equal(answerPage(PARTNER, "tradein"), false, "the partner's are steps");
  assert.equal(canShow(PARTNER, "repair"), false, "the store's repair quote is not the partner's");
  assert.equal(canShow(ALL, "tradein"), true);
  assert.equal(canShow(ALL, "lock"), false, "the trade-in to take only once Swap up opened it");
});

test("the progress header: 'Step 2 of 3 · What's wrong'; an answer page says where it belongs", () => {
  assert.equal(progressLabel(ALL, "faults"), "Step 2 of 3 · What's wrong");
  assert.equal(progressLabel(ALL, "answer"), "Step 3 of 3 · The answer");
  assert.equal(progressLabel([...ALL, "lock"], "lock"), "Step 4 of 4 · Take the trade-in");
  assert.equal(progressLabel(ALL, "repair"), "The answer › Repair quote");
  assert.equal(progressLabel(ALL, "tradein"), "The answer › Trade-in");
  assert.equal(progressLabel(PARTNER, "tradein"), "Step 3 of 3 · Trade-in");
});

test("Back and Next: none before the first step; the answer and the trade-in have no Next — their own buttons go on; an answer page goes back to it", () => {
  assert.deepEqual(neighbours(ALL, "phone"), { back: null, next: "faults" });
  assert.deepEqual(neighbours(ALL, "faults"), { back: "phone", next: "answer" });
  assert.deepEqual(neighbours(ALL, "answer"), { back: "faults", next: null });
  assert.deepEqual(neighbours(ALL, "repair"), { back: "answer", next: null });
  assert.deepEqual(neighbours(ALL, "tradein"), { back: "answer", next: null });
  assert.deepEqual(neighbours([...ALL, "lock"], "answer"), { back: "faults", next: null });
  assert.deepEqual(neighbours([...ALL, "lock"], "lock"), { back: "answer", next: null });
  assert.deepEqual(neighbours(PARTNER, "tradein"), { back: "faults", next: null });
});

/* ─────────────────────────── links ─────────────────────────── */

test("every link the page, the answer card and the store app send lands on the step that holds it", () => {
  assert.equal(stepFromAnchor("#step-phone"), "phone");
  assert.equal(stepFromAnchor("step-faults"), "faults");
  assert.equal(stepFromAnchor("#step-condition"), "faults", "the condition is inside What's wrong now");
  assert.equal(stepFromAnchor("#step-repair"), "repair");
  assert.equal(stepFromAnchor("#step-tradein"), "tradein");
  assert.equal(stepFromAnchor("#step-upgrade"), "tradein", "the new phone is inside Trade-in now");
  assert.equal(stepFromAnchor("#answer"), "answer", "the store app's hand-off for a size not on file");
  assert.equal(stepFromAnchor("#step-lock"), "lock");
  assert.equal(stepFromAnchor("#nonsense"), null);
  assert.equal(stepFromAnchor("#constructor"), null);
  assert.equal(stepFromAnchor(""), null);
  // The answer card's and the asks' targets are all known anchors.
  for (const id of Object.keys(STEP_ANCHOR) as StepId[]) assert.equal(stepFromAnchor(STEP_ANCHOR[id]), id);
});

/* ─────────────────────────── landing ─────────────────────────── */

test("a tested case, and the store app's ?view=answer, land on the answer", () => {
  assert.equal(land({ tested: true }), "answer");
  assert.equal(land({ answerFirst: true }), "answer");
});

test("tested: SwapUp Check's results on the case, or an attached Phonecheck report — not a phone described at the desk", () => {
  assert.equal(testedCase({ camera: {} as never, grading: null }), true);
  assert.equal(testedCase({ camera: null, grading: { status: "graded" } as never }), true, "a Phonecheck report graded it");
  assert.equal(testedCase({ camera: null, grading: { status: "not_tested" } as never }), false);
  assert.equal(testedCase({ camera: null, grading: null }), false);
});

test("a link to a step wins — #step-repair opens the answer's repair page even on a tested case", () => {
  assert.equal(land({ tested: true, anchor: "#step-repair" }), "repair");
  assert.equal(land({ answerFirst: true, anchor: "#step-phone" }), "phone");
  assert.equal(land({ anchor: "#step-upgrade" }), "tradein");
});

test("#step-lock opens the trade-in only where it can be taken; otherwise the answer", () => {
  assert.equal(land({ anchor: "#step-lock" }), "lock");
  assert.equal(land({ anchor: "#step-lock", canLock: false }), "answer");
  assert.equal(land({ anchor: "#step-lock", steps: PARTNER, canLock: true }), "tradein");
});

test("an untested case opens on the first step not answered yet, and on the answer once both are — a missing quote or phone is the answer's ask", () => {
  const v = view({ device: null });
  assert.equal(land({ done: (s) => stepDone(v, s) }), "phone");
  assert.equal(land({ done: (s) => stepDone(view({ condition: null, faults: [] }), s) }), "faults");
  const needsQuote = view({ repair: OWNERS_SCREEN });
  assert.equal(land({ done: (s) => stepDone(needsQuote, s) }), "answer", "the answer asks for the service centre's quote");
  assert.equal(land({ done: (s) => stepDone(view({ upgrade: null }), s) }), "answer", "the answer asks for the new phone");
  assert.equal(land({ done: (s) => stepDone(view(), s) }), "answer");
  // The partner has no answer: its first unanswered step.
  assert.equal(land({ steps: PARTNER, done: (s) => stepDone(needsQuote, s) }), "tradein");
});

test("a case this viewer can't change (closed, read-only) opens on the answer; the partner, who has none, on the trade-in", () => {
  assert.equal(land({ editable: false }), "answer");
  assert.equal(land({ editable: false, steps: PARTNER }), "tradein");
});

test("done: storage chosen; condition consistent; repair priced or nothing to repair; a live trade-in and a new phone", () => {
  assert.equal(stepDone(view({ device: { ...DEVICE, variant: null } }), "phone"), false);
  assert.equal(stepDone(view(), "phone"), true);
  assert.equal(stepDone(view({ conditionProblems: ["Screen is recorded better than the faults allow."] }), "faults"), false);
  assert.equal(stepDone(view({ condition: null, faults: [] }), "faults"), false);
  assert.equal(stepDone(view({ faults: [], repair: null }), "repair"), true, "nothing wrong — just trading in");
  assert.equal(stepDone(view({ repair: OWNERS_SCREEN }), "repair"), false);
  assert.equal(stepDone(view({ quoteExpired: true }), "tradein"), false);
  assert.equal(stepDone(view(), "answer"), false, "the answer is a choice, never ticked");
});

/* ─────────────────────────── one line each ─────────────────────────── */

test("the phone step's one line", () => {
  assert.equal(phoneLine(view()), "Galaxy S23 Ultra · 256GB · IMEI recorded · No cover");
  assert.equal(phoneLine(view({ imei: null, coverage: "care_plus", device: { ...DEVICE, variant: null } })), "Galaxy S23 Ultra · storage not chosen · no IMEI yet · Care+");
  assert.equal(phoneLine(view({ imeiCheck: "invalid" })), "Galaxy S23 Ultra · 256GB · IMEI check digit fails · No cover");
  assert.equal(phoneLine(view({ device: null })), "No phone chosen yet.");
});

test("what's wrong: the trade-in condition the faults filled in, in one line", () => {
  assert.equal(conditionLine(COND), "Screen: Cracked glass · Body: Light scuffs · 1 other issue · With charger · Over 11 months");
  assert.equal(conditionLine({ ...COND, powersOn: false, issues: [], accessories: { charger: false, box: false, bill: false } }), "Doesn't switch on · Screen: Cracked glass · Body: Light scuffs · No charger, box or bill · Over 11 months");
  assert.equal(faultsLine(view()), `Trade-in condition: ${conditionLine(COND)}`);
  assert.equal(faultsLine(view({ condition: null, faults: [] })), "Tick what's wrong.");
});

/* ─────────────────────────── the repair step ─────────────────────────── */

test("the owner's screen: no figure, one plain sentence, the quote form open — no amber essay", () => {
  const s = repairStep(view({ repair: OWNERS_SCREEN }));
  assert.equal(s.amount, null);
  assert.equal(s.headline, "Needs the service centre's quote");
  assert.equal(s.line, "Liquid damage can only be priced on the bench.");
  assert.equal(s.form, "needed");
  assert.deepEqual(s.sources, ["bench", "job_sheet"]);
  assert.ok(!/won't guess|Until the service centre/i.test(`${s.headline} ${s.line}`));
});

test("the plain part list: 'Battery ₹2,760 · Screen ₹28,470 · Rear camera — no price' — no sources, no list price", () => {
  const lines = repairLines(OWNERS_SCREEN);
  assert.deepEqual(lines, ["Battery ₹2,760", "Screen ₹28,470", "Rear camera — no price", "Liquid damage — needs the bench"]);
  for (const l of lines) assert.ok(!/source|list price|Samsung India|excl\. GST|↗/i.test(l), l);
});

test("a book price: one figure, one line, and the breakdown in the list — labour, GST, Care+ fee, without cover", () => {
  const s = repairStep(view());
  assert.deepEqual({ amount: s.amount, headline: s.headline, line: s.line, form: s.form }, { amount: 37444, headline: null, line: "Price book: parts, labour, GST.", form: "optional" });
  assert.deepEqual(repairLines(estimate()), ["Battery ₹2,760", "Screen ₹28,470", "Labour ₹500", "GST ₹5,714"]);
  const plan = estimate({
    coverage: "care_plus",
    lines: [{ part: "display", label: "Display assembly", faults: ["screen_cracked"], listPrice: 28470, charged: 0, covered: true, source: SOURCE }],
    labour: 0,
    gst: 0,
    carePlusFee: 4999,
    customerPays: 4999,
    listTotal: 34183,
  });
  assert.deepEqual(repairLines(plan), ["Screen — covered", "Care+ claim fee ₹4,999", "Without cover ₹34,183"]);
  const free = repairStep(view({ coverage: "warranty", repair: estimate({ coverage: "warranty", customerPays: 0, labour: 0, gst: 0 }) }));
  assert.equal(free.line, "Covered by the warranty.");
});

test("the book has no price for a part: one sentence naming it", () => {
  const unpriced = estimate({
    status: "unpriced",
    basis: null,
    lines: [{ part: "mic", label: "Microphone", faults: ["mic"], listPrice: null, charged: 0, covered: false, source: null }],
    customerPays: null,
    listTotal: null,
    missingParts: ["mic"],
  });
  const s = repairStep(view({ repair: unpriced }));
  assert.equal(s.line, "No book price for the microphone.");
  assert.deepEqual(s.sources, ["job_sheet", "bench"]);
  const two = repairStep(view({ repair: { ...unpriced, missingParts: ["display", "rear_camera"] } }));
  assert.equal(two.line, "No book price for the screen and the rear camera.");
});

test("a quote typed in, a centre that doesn't repair the brand, nothing to repair, no phone", () => {
  const typed = repairStep(view({ manualRepair: { amount: 8500, reason: "Bench diagnosis at the service centre", by: "Rahul Desai" } as never }));
  assert.deepEqual({ amount: typed.amount, line: typed.line, form: typed.form }, { amount: 8500, line: "Service centre's quote · Bench diagnosis at the service centre", form: null });
  const elsewhere = repairStep(view({ repairNotServiced: "This centre repairs Samsung phones only. Enter the customer's own repair quote to compare.", repair: null }));
  assert.equal(elsewhere.headline, "Needs the customer's outside quote");
  assert.deepEqual(elsewhere.sources, ["outside"]);
  assert.equal(repairStep(view({ faults: [], repair: null })).headline, "Nothing to repair");
  assert.equal(repairStep(view({ device: null })).headline, "Choose the phone first");
});

test("one amount field and a source: the server gets whole rupees and a reason it accepts (8+ characters)", () => {
  assert.deepEqual(repairQuotePatch("₹8,500", "bench"), { manualRepair: { amount: 8500, reason: "Bench diagnosis at the service centre" } });
  assert.deepEqual(repairQuotePatch("0", "job_sheet"), { manualRepair: { amount: 0, reason: "Service centre job sheet" } });
  assert.equal(repairQuotePatch("85.50", "bench"), null);
  assert.equal(repairQuoteProblem(""), "Whole rupees only.");
  assert.equal(repairQuoteProblem("600000"), "Whole rupees only.");
  assert.equal(repairQuoteProblem("12000"), null);
  for (const s of ["bench", "job_sheet", "outside"] as const) assert.ok(repairQuotePatch("1", s)!.manualRepair.reason.length >= 8);
});

/* ─────────────────────────── the page ─────────────────────────── */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("static: the repair step shows no price-book source, no 'list price' and no amber essay", () => {
  const src = read("./StepRepair.tsx");
  for (const bad of ["source ↗", "list price", "l.source", "won&apos;t guess", "won't guess", "Banner tone=\"warn\""]) assert.ok(!src.includes(bad), `StepRepair.tsx still has ${bad}`);
  assert.ok(src.includes("repairLines("), "the plain part list");
  assert.ok(src.includes("Service centre's quote (₹)"), "one amount field");
});

test("static: one step at a time, details closed by default, Back / Next docked", () => {
  const ws = read("./CaseWorkspace.tsx");
  const card = read("./StepCard.tsx");
  assert.ok(ws.includes("landingStep("), "the page opens where landingStep says");
  assert.equal((ws.match(/hidden=\{current !== "/g) ?? []).length, 6, "every step but the current one is hidden");
  assert.ok(!ws.includes("<DecisionPanel"), "no second money panel — the answer step is the answer");
  assert.ok(ws.includes("<StepHeader") && ws.includes("<StepDock"), "the progress header and the dock");
  assert.match(read("./StepNav.tsx"), /sticky bottom-0/, "Back / Next ride at the bottom of the screen");
  assert.match(card, /<details[^>]*data-details/);
  assert.ok(!/<details[^>]*\bopen\b/.test(card), "Show details is closed by default");
});
