"use client";

import { useState } from "react";
import { Money, ErrorText } from "@/components/ui";
import type { CaseOps } from "./ops";

function LedgerRow({ label, sub, stack, children }: { label: string; sub: React.ReactNode; stack?: boolean; children: React.ReactNode }) {
  // `stack`: the value goes under the label on a phone (an input needs the width).
  const cols = stack ? "grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]";
  return (
    <div className={`grid ${cols} items-center gap-x-4 px-5 py-3`}>
      <dt className="min-w-0">
        <div className="text-[14px] font-semibold">{label}</div>
        {sub ? <div className="text-[12.5px] text-muted leading-snug mt-0.5">{sub}</div> : null}
      </dt>
      <dd className={`${stack ? "sm:text-right" : "text-right"} text-[17px] font-semibold`}>{children}</dd>
    </div>
  );
}

/**
 * REFURB DECISION · STAFF ONLY — closed, right under the answer. The server's five lines
 * (CaseView.refurbEconomics, lib/domain/refurbEconomics.ts), printed as sent: the phone's value
 * as it is, what repairing it costs the store, its value repaired off the same price list, the
 * uplift said as the decision ("Repair before pickup: +₹654" / "Send as-is — …"), and what SwapUp
 * pays — the answer's own figures. Each figure carries where it came from, or why it is missing.
 * The repair cost is the store's to set: saved as the case's refurbCost, the store's own figure,
 * which moves no price. Never an offer to the customer; the partner never sees it.
 */
export function RefurbDecision({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const e = view.refurbEconomics;
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!e) return null;
  const { preRefurb: pre, repairCost: cost, postRepair: post, uplift, offer } = e;

  const shown = draft ?? (cost.amount === null ? "" : String(cost.amount));
  const typed = Number(shown.replace(/[,\s₹]/g, ""));
  const changed = draft !== null && shown.trim() !== "" && typed !== cost.amount;

  async function saveCost(ev: React.FormEvent) {
    ev.preventDefault();
    if (!shown.trim() || !Number.isInteger(typed) || typed < 0 || typed > 500_000) return setErr("Whole rupees only.");
    setSaving(true);
    const e2 = await save({ refurbCost: { amount: typed } });
    setSaving(false);
    setErr(e2);
    if (!e2) setDraft(null);
  }

  return (
    <details className="card no-print group" id="refurb-decision">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center justify-between gap-3 px-5 py-3.5">
        <span className="section-title">Refurb decision · staff only</span>
        <span className="text-[13px] font-semibold text-muted" aria-hidden>
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <dl className="divide-y divide-[color:var(--line)] border-t border-line">
        <LedgerRow label="Pre-refurb value" sub={pre.source ?? pre.why}>
          <Money value={pre.amount} />
        </LedgerRow>
        <LedgerRow label="Repair cost" sub={cost.source ?? cost.why} stack={editable}>
          {editable ? (
            <form onSubmit={saveCost} className="flex items-center sm:justify-end gap-2">
              <span className="text-muted text-[13px] font-normal">Store&apos;s own ₹</span>
              <input
                className="input num !min-h-[38px] !py-1.5 w-[110px] text-right"
                inputMode="numeric"
                aria-label="The store's own repair cost in rupees"
                value={shown}
                placeholder="—"
                onChange={(ev) => {
                  setDraft(ev.target.value);
                  setErr(null);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={!changed || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </form>
          ) : (
            <Money value={cost.amount} />
          )}
        </LedgerRow>
        <LedgerRow label="Post-repair value" sub={post.source ?? post.why}>
          <Money value={post.amount} />
        </LedgerRow>
        {/* The decision says its own figure: the uplift is not printed a second time beside it. */}
        <div className="px-5 py-3 bg-surface-2">
          <dt className="text-[12.5px] text-muted leading-snug">Repair uplift · post-repair − pre-refurb − repair cost</dt>
          <dd className={`text-[17px] font-bold mt-0.5 ${uplift.verdict === "repair" ? "text-fix" : ""}`}>{uplift.text ?? "—"}</dd>
          {uplift.why ? <dd className="text-[12.5px] text-muted leading-snug mt-0.5">{uplift.why}</dd> : null}
        </div>
        <LedgerRow label="SwapUp offer" sub={offer.source ?? offer.why}>
          <Money value={offer.amount} />
        </LedgerRow>
      </dl>
      {err ? (
        <div className="px-5 pb-3">
          <ErrorText error={err} />
        </div>
      ) : null}
    </details>
  );
}
