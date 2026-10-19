"use client";

import { useState } from "react";
import { Money, ErrorText } from "@/components/ui";
import { buySell } from "@/lib/domain/buySell";
import type { CaseOps } from "./ops";
import { sellSub } from "./marginLines";

function LedgerRow({ label, sub, strong, stack, children }: { label: string; sub: React.ReactNode; strong?: boolean; stack?: boolean; children: React.ReactNode }) {
  // `stack`: the value goes under the label on a phone (an input needs the width).
  const cols = stack ? "grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]";
  return (
    <div className={`grid ${cols} items-center gap-x-4 px-5 py-3 ${strong ? "bg-surface-2" : ""}`}>
      <dt className="min-w-0">
        <div className={strong ? "text-[15px] font-bold" : "text-[14px] font-semibold"}>{label}</div>
        {sub ? <div className="text-[12.5px] text-muted leading-snug mt-0.5">{sub}</div> : null}
      </dt>
      <dd className={`${stack ? "sm:text-right" : "text-right"} ${strong ? "text-[24px] font-[760] tracking-tight" : "text-[17px] font-semibold"}`}>{children}</dd>
    </div>
  );
}

/**
 * STORE MARGIN · STAFF ONLY — closed, right under the answer (the same card, under the
 * same name, as the SwapUp Store app's). The store's numbers for this trade-in
 * (lib/domain/buySell.ts): what it pays the customer, what the refurb costs it, what the
 * phone sells for once refurbished (the refurbished market price from PriceIQ, less
 * 2–5%), and the margin. Never an offer to the customer. The refurb cost is the advisor's
 * to set; it is saved as the case's refurbCost — the store's own figure, which moves no
 * price. The partner never sees this.
 */
export function StoreMargin({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const q = view.quote;
  const rq = view.repairedQuote;
  const m = view.marketSell;
  const partner = q?.partner ?? view.partner?.partnerName ?? "The partner";
  const b = buySell({ quote: q, repairedQuote: rq, refurbCost: view.refurbCost, repair: view.repair, faultCount: view.faults.length, market: m, partner });
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = draft ?? (b.refurb === null ? "" : String(b.refurb));
  const typed = Number(shown.replace(/[,\s₹]/g, ""));
  const changed = draft !== null && shown.trim() !== "" && typed !== b.refurb;

  async function saveRefurb(e: React.FormEvent) {
    e.preventDefault();
    if (!shown.trim() || !Number.isInteger(typed) || typed < 0 || typed > 500_000) return setErr("Whole rupees only.");
    setSaving(true);
    const e2 = await save({ refurbCost: { amount: typed } });
    setSaving(false);
    setErr(e2);
    if (!e2) setDraft(null);
  }

  const refurbSub =
    b.refurbBasis === "quote" && view.refurbCost
      ? `Entered by ${view.refurbCost.by}`
      : b.refurbBasis === "estimate"
        ? "Price-book estimate"
        : b.refurbBasis === "none"
          ? "Nothing to repair"
          : b.refurbWhy;

  return (
    <details className="card no-print group" id="store-margin">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center justify-between gap-3 px-5 py-3.5">
        <span className="section-title">Store margin · staff only</span>
        <span className="text-[13px] font-semibold text-muted" aria-hidden>
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <dl className="divide-y divide-[color:var(--line)] border-t border-line">
        {/* The figure needs no note; only a missing one says why. */}
        <LedgerRow label="Buy" sub={b.buy === null ? b.buyWhy : null}>
          <Money value={b.buy} />
        </LedgerRow>
        <LedgerRow label="Store's refurb cost" sub={refurbSub} stack={editable}>
          {editable ? (
            <form onSubmit={saveRefurb} className="flex items-center sm:justify-end gap-2">
              <span className="text-muted text-[15px]" aria-hidden>
                ₹
              </span>
              <input
                className="input num !min-h-[38px] !py-1.5 w-[110px] text-right"
                inputMode="numeric"
                aria-label="Store's refurb cost in rupees"
                value={shown}
                placeholder="—"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setErr(null);
                }}
              />
              <button className="btn btn-sm btn-primary" disabled={!changed || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </form>
          ) : (
            <Money value={b.refurb} />
          )}
        </LedgerRow>
        <LedgerRow
          label="Sell after refurb"
          sub={sellSub({ sellBasis: b.sellBasis, sellWhy: b.sellWhy, market: m, repairedReason: rq?.reason ?? null, partner })}
        >
          <Money value={b.sell} />
        </LedgerRow>
        <LedgerRow label="Margin" sub={b.margin !== null ? "Sell − buy − refurb cost" : b.marginWhy} strong>
          <Money value={b.margin} className={b.margin !== null && b.margin < 0 ? "text-bad" : ""} />
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
