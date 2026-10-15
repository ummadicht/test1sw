/**
 * THE REPAIR QUOTE — what the customer would pay to keep the phone.
 *
 * Built from the service centre's price book (part price per model) plus a
 * labour/service charge, adjusted for cover. It refuses in two honest ways:
 *
 *   needs_inspection  a fault with no fixed price (liquid, no power, frame,
 *                     network) — only a bench diagnosis can price it, so the
 *                     advisor must enter the centre's actual quote;
 *   unpriced          a part the book has no price for on this model.
 *
 * Either way the decision screen gets no repair number and says so, instead of
 * comparing an upgrade against a repair price nobody gave. A manual quote (the
 * figure from the centre's own job system) always wins over the book, with a
 * written reason, because the bench is closer to the truth than a list.
 *
 * Cover rules are deliberately simple and configurable per programme:
 *   warranty   manufacturer warranty — faults that are NOT physical/liquid
 *              damage are repaired free; physical damage is charged as normal.
 *   care_plus  an accidental-damage plan — physical damage is covered for a
 *              fixed per-claim service fee instead of the part price;
 *              non-physical faults are free as under warranty.
 */

import type { Rupees } from "./money.ts";
import { type FaultId, type PartId, FAULT_BY_ID, PART_LABEL } from "./condition.ts";
import { RuleError } from "./errors.ts";

export type SourceRef = {
  kind: "oem_public" | "client" | "sample" | "manual";
  label: string;
  url?: string;
  observedAt?: string;
};

export type RepairBookEntry = { modelId: string; part: PartId; price: Rupees; source: SourceRef };

export type Coverage = "none" | "warranty" | "care_plus";

export type RepairPolicy = {
  /** Service / labour charge per repair job (by the model's service tier), charged when anything is chargeable. */
  labour: Rupees;
  /** Per-claim processing fee under an accidental-damage plan, tax included. */
  carePlusFee: Rupees;
  /** GST on parts + labour, in basis points (1800 = 18%). Published part prices exclude it. */
  gstBp: number;
};

export type RepairLine = {
  part: PartId;
  label: string;
  faults: FaultId[];
  listPrice: Rupees | null;
  charged: Rupees;
  covered: boolean;
  source: SourceRef | null;
};

export type RepairEstimate = {
  status: "quoted" | "needs_inspection" | "unpriced" | "nothing_to_repair";
  basis: "book" | "manual" | null;
  lines: RepairLine[];
  labour: Rupees;
  gst: Rupees;
  carePlusFee: Rupees;
  /** What the customer pays. null unless status is "quoted". */
  customerPays: Rupees | null;
  /** What the repair is worth at list price, before cover — for context only. */
  listTotal: Rupees | null;
  coverage: Coverage;
  inspectionFaults: FaultId[];
  missingParts: PartId[];
  notes: string[];
};

export type ManualQuote = { amount: Rupees; reason: string; by: string };

export function estimateRepair(input: {
  book: RepairBookEntry[];
  modelId: string;
  faults: FaultId[];
  coverage: Coverage;
  policy: RepairPolicy;
  manual?: ManualQuote | null;
}): RepairEstimate {
  const { book, modelId, faults, coverage, policy, manual } = input;
  const notes: string[] = [];

  if (manual) {
    if (!Number.isInteger(manual.amount) || manual.amount < 0) throw new RuleError("Manual repair quote must be a whole, non-negative rupee amount.", 400);
    if ((manual.reason || "").trim().length < 8) throw new RuleError("A manual repair quote needs a reason (at least a few words).", 400);
    return {
      status: "quoted",
      basis: "manual",
      lines: [],
      labour: 0,
      gst: 0,
      carePlusFee: 0,
      customerPays: manual.amount,
      listTotal: null,
      coverage,
      inspectionFaults: [],
      missingParts: [],
      notes: [`Service centre quote entered by ${manual.by}: ${manual.reason.trim()}`],
    };
  }

  if (faults.length === 0) {
    return {
      status: "nothing_to_repair", basis: null, lines: [], labour: 0, gst: 0, carePlusFee: 0, customerPays: null,
      listTotal: null, coverage, inspectionFaults: [], missingParts: [], notes: ["No faults recorded."],
    };
  }

  // Group faults by the part that fixes them — one display fixes crack + lines + touch.
  const byPart = new Map<PartId, FaultId[]>();
  const inspectionFaults: FaultId[] = [];
  for (const f of faults) {
    const part = FAULT_BY_ID[f].part;
    if (!part) inspectionFaults.push(f);
    else byPart.set(part, [...(byPart.get(part) ?? []), f]);
  }

  const lines: RepairLine[] = [];
  const missingParts: PartId[] = [];
  let anyPhysicalCharged = false;
  for (const [part, fs] of byPart) {
    const entry = book.find((b) => b.modelId === modelId && b.part === part) ?? null;
    const physical = fs.some((f) => FAULT_BY_ID[f].physicalDamage);
    const covered =
      coverage === "warranty" ? !physical : coverage === "care_plus" ? true : false;
    if (!entry) missingParts.push(part);
    if (physical && coverage === "care_plus") anyPhysicalCharged = true;
    lines.push({
      part,
      label: PART_LABEL[part],
      faults: fs,
      listPrice: entry?.price ?? null,
      charged: entry && !covered ? entry.price : 0,
      covered,
      source: entry?.source ?? null,
    });
  }

  const base = { lines, coverage, inspectionFaults, missingParts, notes };
  if (inspectionFaults.length) {
    notes.push(
      `${inspectionFaults.map((f) => FAULT_BY_ID[f].label).join(", ")} can only be priced after a bench diagnosis — enter the service centre's quote.`
    );
    return { ...base, status: "needs_inspection", basis: null, labour: 0, gst: 0, carePlusFee: 0, customerPays: null, listTotal: null };
  }
  // A covered part needs no price to be free; a CHARGED part does.
  const blocking = lines.filter((l) => l.listPrice === null && !l.covered);
  if (blocking.length) {
    notes.push(`No price in the book for ${blocking.map((l) => l.label).join(", ")} on this model — enter the service centre's quote.`);
    return { ...base, status: "unpriced", basis: null, labour: 0, gst: 0, carePlusFee: 0, customerPays: null, listTotal: null };
  }

  const partsCharged = lines.reduce((s, l) => s + l.charged, 0);
  const fee = anyPhysicalCharged ? policy.carePlusFee : 0;
  const labour = partsCharged > 0 ? policy.labour : 0;
  // GST is charged on parts + labour (published part prices exclude it). The
  // plan fee is quoted tax-inclusive, so it is added after.
  const gst = Math.round(((partsCharged + labour) * policy.gstBp) / 10_000);
  const customerPays = partsCharged + labour + gst + fee;
  const listKnown = lines.every((l) => l.listPrice !== null);
  const listParts = lines.reduce((s, l) => s + (l.listPrice ?? 0), 0);
  const listTotal = listKnown ? listParts + policy.labour + Math.round(((listParts + policy.labour) * policy.gstBp) / 10_000) : null;

  if (coverage === "warranty" && lines.some((l) => l.covered)) notes.push("Non-physical faults are covered by the manufacturer warranty.");
  if (coverage === "warranty" && lines.some((l) => !l.covered)) notes.push("Physical damage is not covered by warranty and is charged.");
  if (fee) notes.push("Accidental damage is covered by the plan for its per-claim fee.");

  if (gst) notes.push(`Includes GST at ${policy.gstBp / 100}% on parts and labour.`);

  return { ...base, status: "quoted", basis: "book", labour, gst, carePlusFee: fee, customerPays, listTotal };
}
