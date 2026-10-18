/**
 * THE CASE, STEP BY STEP (owner, 2026-10-17: "This screen looks complicated —
 * make it step wise, and simplify it", then "Reduce the flow — fewest steps").
 * The desk case page shows one step at a time, in the store app's order:
 *
 *     Phone → What's wrong → The answer   (→ Take the trade-in)
 *
 * with "Step 2 of 3 · What's wrong" on top and Back / Next at the bottom. The
 * answer holds both numbers (refurb quote vs trade-in + bonus), as the store app's
 * answer screen does; its asks and its "Change" links open the Repair quote and
 * the Trade-in as pages of their own ("The answer › Repair quote", Back to the
 * answer) — they are what the answer is made of, not steps to walk through. Each
 * step asks one question and says one line; everything else sits behind its
 * "Show details", closed. "Swap up" on the answer opens the last step. The
 * partner, who gets no answer, keeps the Trade-in as a step — never the store's repair quote.
 *
 * This file holds the rules, pure, so they are tested without a browser
 * (caseSteps.test.ts): the step order, which step a case opens on, what each
 * step's one line says, and the repair step's plain part list and quote form.
 * Every price and every reason is the server's (lib/domain); this only picks
 * where it goes and says it in fewer words.
 *
 * Runtime imports are relative with ".ts" so `node --test` can load this file;
 * everything from lib/server is a type only.
 */
import { AGE_LABEL, BODY_LABEL, FAULT_BY_ID, SCREEN_LABEL, type ConditionAnswers, type PartId } from "../../lib/domain/condition.ts";
import { inr } from "../../lib/domain/money.ts";
import type { RepairEstimate } from "../../lib/domain/repair.ts";
import type { CaseView } from "../../lib/server/cases.ts";

/* ─────────────────────────── the steps ─────────────────────────── */

export type StepId = "phone" | "faults" | "repair" | "tradein" | "answer" | "lock";

/** The progress header's names ("Step 2 of 3 · What's wrong"). */
export const STEP_TITLE: Record<StepId, string> = {
  phone: "Phone",
  faults: "What's wrong",
  repair: "Repair quote",
  tradein: "Trade-in",
  answer: "The answer",
  lock: "Take the trade-in",
};

/** Each step's element id — and its link: /cases/<id>#step-repair opens the repair step. */
export const STEP_ANCHOR: Record<StepId, string> = {
  phone: "step-phone",
  faults: "step-faults",
  repair: "step-repair",
  tradein: "step-tradein",
  answer: "answer",
  lock: "step-lock",
};

/**
 * Every link that names a part of the case page, old and new, to the step that holds it. The
 * condition and the new phone were steps of their own and are now inside "What's wrong" and
 * "Trade-in"; the store app's hand-off still sends #answer and #step-phone.
 */
const ANCHOR_STEP: Record<string, StepId> = {
  "step-phone": "phone",
  "step-faults": "faults",
  "step-condition": "faults",
  phonecheck: "faults",
  "step-repair": "repair",
  "step-tradein": "tradein",
  "step-upgrade": "tradein",
  answer: "answer",
  "step-answer": "answer",
  grade: "answer",
  "store-margin": "answer",
  "step-lock": "lock",
};

/** "#step-upgrade" → "tradein"; anything unknown → null. */
export function stepFromAnchor(anchor: string | null | undefined): StepId | null {
  if (!anchor) return null;
  let a = anchor.trim().replace(/^#/, "");
  try {
    a = decodeURIComponent(a);
  } catch {
    /* keep it as it is */
  }
  return Object.prototype.hasOwnProperty.call(ANCHOR_STEP, a) ? ANCHOR_STEP[a] : null;
}

/** The answer's own pages: opened from its asks and its "Change" links; Back returns to the answer. */
export const ANSWER_PAGES: readonly StepId[] = ["repair", "tradein"];

/**
 * The steps of this case, in order. The answer is the staff's (the partner gets no answer —
 * CaseView.offer is null for it — so the Trade-in stays its step, and the store's repair quote is not shown). "Take the
 * trade-in" is there only once "Swap up" opened it.
 */
export function stepOrder(x: { answer: boolean; lock: boolean }): StepId[] {
  // The partner: what it collects, never the store's repair quote to its customer.
  if (!x.answer) return ["phone", "faults", "tradein"];
  const s: StepId[] = ["phone", "faults", "answer"];
  if (x.lock) s.push("lock");
  return s;
}

/** One of the answer's own pages (not a numbered step) on a page that has the answer. */
export function answerPage(steps: readonly StepId[], id: StepId): boolean {
  return !steps.includes(id) && steps.includes("answer") && ANSWER_PAGES.includes(id);
}

/** The page can show this: one of its steps, or one of the answer's own pages. */
export function canShow(steps: readonly StepId[], id: StepId): boolean {
  return steps.includes(id) || answerPage(steps, id);
}

/** "Step 2 of 3 · What's wrong"; an answer page: "The answer › Repair quote". */
export function progressLabel(steps: StepId[], id: StepId): string {
  if (answerPage(steps, id)) return `${STEP_TITLE.answer} › ${STEP_TITLE[id]}`;
  const i = steps.indexOf(id);
  return `Step ${i < 0 ? 1 : i + 1} of ${steps.length} · ${STEP_TITLE[id]}`;
}

/**
 * Back and Next. The answer has no Next — its own buttons are the way on (Repair, Swap up,
 * Walked away) — and neither has the trade-in, whose Back is the answer. An answer page goes
 * back to the answer.
 */
export function neighbours(steps: StepId[], id: StepId): { back: StepId | null; next: StepId | null } {
  if (answerPage(steps, id)) return { back: "answer", next: null };
  const i = steps.indexOf(id);
  if (i < 0) return { back: null, next: null };
  return { back: i > 0 ? steps[i - 1] : null, next: id === "answer" || id === "lock" ? null : (steps[i + 1] ?? null) };
}

export type DoneView = Pick<CaseView, "device" | "faults" | "condition" | "conditionProblems" | "repair" | "manualRepair" | "quote" | "quoteExpired" | "upgrade">;

/** Is this step answered — the tick in the step list, and where an untested case opens. */
export function stepDone(v: DoneView, id: StepId): boolean {
  switch (id) {
    case "phone":
      return !!v.device?.variant;
    case "faults":
      // A fault ticked (or "nothing wrong") fills the trade-in condition; it is done once that is consistent.
      return v.condition !== null && v.conditionProblems.length === 0;
    case "repair":
      return v.repair?.status === "quoted" || (v.faults.length === 0 && !v.manualRepair && v.condition !== null);
    case "tradein":
      return v.quote?.status === "priced" && v.quote.amount !== null && !v.quoteExpired && !!v.upgrade;
    default:
      return false;
  }
}

/**
 * The phone was tested — SwapUp Check's results are on the case (its camera record) or a
 * Phonecheck report is attached (the grade is more than "not tested"): the page opens on the
 * answer, as the store app does.
 */
export function testedCase(v: Pick<CaseView, "camera" | "grading">): boolean {
  return v.camera !== null || (!!v.grading && v.grading.status !== "not_tested");
}

/**
 * Which step the page opens on:
 *   1. a link to a step (#step-repair, #answer, the store app's #step-phone) — that step;
 *      #step-lock only where the trade-in can be taken, else the answer;
 *   2. a tested case, the store app's ?view=answer, or a case this viewer can't change
 *      (closed, or read-only) — the answer: the test or the counter already answered the steps;
 *   3. otherwise the first step not yet answered, and the answer once they all are — a missing
 *      repair quote or new phone is one of the answer's asks, which opens its page.
 */
export function landingStep(x: {
  steps: StepId[];
  anchor?: string | null;
  answerFirst: boolean;
  tested: boolean;
  editable: boolean;
  canLock: boolean;
  done: (id: StepId) => boolean;
}): StepId {
  const has = (id: StepId) => x.steps.includes(id);
  const answer: StepId | null = has("answer") ? "answer" : null;
  const last = x.steps[x.steps.length - 1];
  const linked = stepFromAnchor(x.anchor);
  if (linked === "lock") return x.canLock && answer ? "lock" : (answer ?? last);
  if (linked && canShow(x.steps, linked)) return linked;
  if (!x.editable) return answer ?? "tradein";
  if (answer && (x.answerFirst || x.tested)) return answer;
  return x.steps.find((s) => s !== "answer" && s !== "lock" && !x.done(s)) ?? answer ?? last;
}

/* ─────────────────────────── each step's one line ─────────────────────────── */

const COVER_WORD: Record<CaseView["coverage"], string> = { none: "No cover", warranty: "Warranty", care_plus: "Care+" };

/** "Galaxy S23 Ultra · 256GB · IMEI recorded · No cover". */
export function phoneLine(v: Pick<CaseView, "device" | "imei" | "imeiCheck" | "coverage">): string {
  if (!v.device) return "No phone chosen yet.";
  const imei = !v.imei ? "no IMEI yet" : v.imeiCheck === "invalid" ? "IMEI check digit fails" : "IMEI recorded";
  return [v.device.model, v.device.variant ?? "storage not chosen", imei, COVER_WORD[v.coverage]].join(" · ");
}

/** "Screen: Cracked glass · Body: Light scuffs · 1 other issue · With charger · Over 11 months". */
export function conditionLine(c: ConditionAnswers | null): string | null {
  if (!c) return null;
  const out: string[] = [];
  if (!c.powersOn) out.push("Doesn't switch on");
  else if (!c.calls) out.push("Calls fail");
  out.push(`Screen: ${SCREEN_LABEL[c.screen]}`, `Body: ${BODY_LABEL[c.body]}`);
  if (c.issues.length) out.push(`${c.issues.length} other ${c.issues.length === 1 ? "issue" : "issues"}`);
  const acc = (["charger", "box", "bill"] as const).filter((k) => c.accessories[k]);
  out.push(acc.length ? `With ${acc.join(", ")}` : "No charger, box or bill");
  out.push(AGE_LABEL[c.age]);
  return out.join(" · ");
}

/** "What's wrong": the trade-in condition the faults filled in, or what to do first. */
export function faultsLine(v: Pick<CaseView, "faults" | "condition">): string {
  const c = conditionLine(v.condition);
  return c ? `Trade-in condition: ${c}` : "Tick what's wrong.";
}

/* ─────────────────────────── the repair step ─────────────────────────── */

/** The parts as a customer says them: "Screen", not "Display assembly". */
const PLAIN_PART: Record<PartId, string> = {
  display: "Screen",
  battery: "Battery",
  back_cover: "Back glass",
  charging_board: "Charging port",
  rear_camera: "Rear camera",
  front_camera: "Front camera",
  speaker: "Speaker",
  mic: "Microphone",
  buttons: "Side keys",
  motherboard: "Main board",
};

/**
 * The repair's plain list, for "Show details": "Battery ₹2,760", "Screen ₹28,470",
 * "Rear camera — no price", "Liquid damage — needs the bench", then labour, GST and the
 * Care+ fee when the book priced it, and what it would cost without cover. No sources,
 * no "list price": the figure on the step is the customer's.
 */
export function repairLines(r: RepairEstimate | null): string[] {
  if (!r) return [];
  const out = r.lines.map((l) => `${PLAIN_PART[l.part] ?? l.label} ${l.covered ? "— covered" : l.listPrice === null ? "— no price" : inr(l.charged)}`);
  for (const f of r.inspectionFaults) out.push(`${FAULT_BY_ID[f]?.label ?? f} — needs the bench`);
  if (r.status === "quoted" && r.basis === "book") {
    if (r.labour > 0) out.push(`Labour ${inr(r.labour)}`);
    if (r.gst > 0) out.push(`GST ${inr(r.gst)}`);
    if (r.carePlusFee > 0) out.push(`Care+ claim fee ${inr(r.carePlusFee)}`);
    if (r.listTotal !== null && r.customerPays !== null && r.listTotal !== r.customerPays) out.push(`Without cover ${inr(r.listTotal)}`);
  }
  return out;
}

/** "the rear camera", "the screen and the rear camera". */
function partsPhrase(parts: PartId[]): string {
  const names = parts.map((p) => `the ${(PLAIN_PART[p] ?? p).toLowerCase()}`);
  return names.length <= 1 ? (names[0] ?? "a part") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Where a typed-in repair quote comes from. The server wants a reason of 8+ characters; the choice is it. */
export type RepairSourceId = "bench" | "job_sheet" | "outside";
export const REPAIR_SOURCE: Record<RepairSourceId, { label: string; reason: string }> = {
  bench: { label: "Bench diagnosis", reason: "Bench diagnosis at the service centre" },
  job_sheet: { label: "Job sheet", reason: "Service centre job sheet" },
  outside: { label: "Customer's outside quote", reason: "Customer's outside repair quote" },
};

export type RepairStep = {
  /** What the customer pays to repair — the step's one figure. null = there is none. */
  amount: number | null;
  /** Said instead of a figure: "Needs the service centre's quote", "Nothing to repair". */
  headline: string | null;
  /** The one plain sentence under it. */
  line: string | null;
  /** The quote form: open ("needed"), behind "The bench quoted something else?" ("optional"), or none. */
  form: "needed" | "optional" | null;
  /** The form's source choices, the first one picked. */
  sources: RepairSourceId[];
};

type RepairInput = Pick<CaseView, "device" | "faults" | "condition" | "repair" | "manualRepair" | "repairNotServiced">;

/** The repair step: one figure, or one plain sentence saying why there is none, and the form when it is needed. */
export function repairStep(v: RepairInput): RepairStep {
  const book: RepairSourceId[] = ["job_sheet", "bench"];
  const r = v.repair;
  if (!v.device) return { amount: null, headline: "Choose the phone first", line: null, form: null, sources: [] };
  if (v.manualRepair) {
    const who = v.repairNotServiced ? "Customer's outside quote" : "Service centre's quote";
    return { amount: v.manualRepair.amount, headline: null, line: `${who} · ${v.manualRepair.reason}`, form: null, sources: [] };
  }
  if (v.repairNotServiced)
    return { amount: null, headline: "Needs the customer's outside quote", line: v.repairNotServiced, form: "needed", sources: ["outside"] };
  if ((v.faults.length === 0 && !v.manualRepair) || r?.status === "nothing_to_repair")
    return {
      amount: null,
      headline: "Nothing to repair",
      line: v.condition ? "A straight trade-in." : "No faults ticked yet.",
      form: null,
      sources: [],
    };
  if (!r) return { amount: null, headline: "Not priced yet", line: "Record the model and faults first.", form: null, sources: [] };
  if (r.status === "quoted") {
    const free = r.customerPays === 0 && r.coverage !== "none";
    const line = free ? `Covered by ${r.coverage === "warranty" ? "the warranty" : "Care+"}.` : "Price book: parts, labour, GST.";
    return { amount: r.customerPays, headline: null, line, form: "optional", sources: book };
  }
  if (r.status === "needs_inspection") {
    const what = r.inspectionFaults.map((f) => FAULT_BY_ID[f]?.label ?? f).join(", ");
    return { amount: null, headline: "Needs the service centre's quote", line: `${what} can only be priced on the bench.`, form: "needed", sources: ["bench", "job_sheet"] };
  }
  return { amount: null, headline: "Needs the service centre's quote", line: `No book price for ${partsPhrase(r.missingParts)}.`, form: "needed", sources: book };
}

/** "18,800" or "₹18800" → 18800; anything but whole rupees → null. */
const rupees = (t: string): number | null => {
  const s = t.replace(/[,\s₹]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
};

/** The server's own check on a typed-in repair quote (cases.ts updateCase): whole rupees, 0 to ₹5,00,000. */
export function repairQuoteProblem(amount: string): string | null {
  const n = rupees(amount);
  return n === null || n > 500_000 ? "Whole rupees only." : null;
}

/** The PATCH for a typed-in repair quote: the amount, and the chosen source as the reason the server needs. */
export function repairQuotePatch(amount: string, source: RepairSourceId): { manualRepair: { amount: number; reason: string } } | null {
  if (repairQuoteProblem(amount)) return null;
  return { manualRepair: { amount: rupees(amount)!, reason: REPAIR_SOURCE[source].reason } };
}
