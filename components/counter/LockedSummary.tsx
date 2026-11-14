"use client";

import Link from "next/link";
import { useState } from "react";
import { Money, Pct, Banner, ErrorText } from "@/components/ui";
import { inr, fmtBp } from "@/lib/domain/money";
import { OUTCOME_LABEL, PICKUP_STATUS_LABEL, type ClearanceOutcome, type PickupStatus } from "@/lib/domain/lifecycle";
import { maskImei } from "@/lib/domain/imei";
import { quoteSourceLabel } from "@/lib/domain/ratecard";
import { QuoteSource } from "./StepTradeIn";
import { idTypeLabel, maskPhone, fmtWhen, faultLabels, conditionSummary, COVER_LABEL } from "./shared";
import type { CaseOps, PickupInfo } from "./ops";
import { DataClearCard } from "./DataClearCard";
import { TONE_TEXT, gradeTone } from "./gradingView";
import { RazorpayPaymentPanel } from "./RazorpayPaymentPanel";
import { PayoutRequestPanel } from "./PayoutRequestPanel";

/** After the trade-in is taken: what was agreed, who checked it, and where the phone is now. */
export function LockedSummary({
  ops,
  isManager,
  isCounter,
  isPartner,
  showCustomer,
  pickup,
}: {
  ops: CaseOps;
  isManager: boolean;
  /** Store staff — they record the customer's data clearing. */
  isCounter: boolean;
  /** The buyback partner: its figure is the market price it pays back ("Trade-in value"), never what the customer was paid. */
  isPartner: boolean;
  /** Store and programme staff see the customer's details; the partner sees the phone only. */
  showCustomer: boolean;
  pickup: PickupInfo | null;
}) {
  const { view, act, busy } = ops;
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cl = view.clearance;
  const bonusBp = view.bonus ? (view.bonus.override?.bp ?? view.bonus.bp) : null;
  // What the customer was paid: the market price + the SwapUp premium frozen at lock (none before premiums).
  const premiumBp = view.offer?.swap.premium?.bp ?? null;
  const wePay = view.tradeValue === null ? null : view.tradeValue + (view.premiumValue ?? 0);

  const timeline: { label: string; at: string | null; note?: string }[] = [
    { label: "Case opened", at: view.createdAt, note: view.advisorName ? `by ${view.advisorName}` : undefined },
    { label: "Trade-in taken", at: view.lockedAt, note: view.checks ? `checks by ${view.checks.by}` : undefined },
  ];
  if (view.dataClearState === "done" || view.dataClearState === "due")
    timeline.push({ label: "Customer's data cleared", at: view.dataClear?.at ?? null, note: view.dataClear ? `seen by ${view.dataClear.by}` : undefined });
  if (view.status === "cancelled") timeline.push({ label: "Trade-in cancelled", at: view.closedAt });
  if (pickup) timeline.push({ label: "Collected by the partner", at: pickup.collectedAt, note: pickup.collectorName ? `by ${pickup.collectorName}` : undefined });
  if (cl) timeline.push({ label: `Partner's verdict: ${OUTCOME_LABEL[cl.outcome as ClearanceOutcome] ?? cl.outcome}`, at: cl.at, note: `by ${cl.by}` });
  if (view.settledAt || pickup?.settledAt) timeline.push({ label: "Settled by the partner", at: view.settledAt ?? pickup?.settledAt ?? null });

  async function cancel() {
    if (reason.trim().length < 4) return setErr("Say why.");
    setErr(await act("cancel", { reason: reason.trim() }));
  }

  return (
    <div className="space-y-5">
      {view.dataClearState === "due" ? <DataClearCard ops={ops} canRecord={isCounter} /> : null}
      <section className="card">
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <h2 className="text-[17px] font-[720]">Trade-in</h2>
        </header>
        <div className="px-5 pb-5 pt-3 space-y-5">
          {view.status === "cancelled" ? (
            <Banner tone="warn">
              Cancelled — value back on the credit line{view.closedReason ? <>: &ldquo;{view.closedReason}&rdquo;</> : "."}
            </Banner>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <div className="section-title">{isPartner ? "Trade-in value" : "We pay you"}</div>
              <div className="kpi mt-1">
                <Money value={isPartner ? view.tradeValue : wePay} />
              </div>
              {!isPartner && view.premiumValue ? (
                <div className="hint">
                  Market price {inr(view.tradeValue)} + SwapUp premium{premiumBp ? ` ${fmtBp(premiumBp)}` : ""}
                </div>
              ) : null}
              <div className="mt-1">
                <QuoteSource quote={view.quote} />
              </div>
            </div>
            <div>
              <div className="section-title">Upgrade bonus</div>
              <div className="kpi mt-1 text-up">
                <Money value={view.bonusValue} />
              </div>
              {view.bonus ? (
                <div className="hint">
                  {bonusBp !== null ? <Pct bp={bonusBp} /> : null} · {view.bonus.campaignName} · funded by {view.bonus.fundedBy}
                </div>
              ) : null}
            </div>
            {isPartner ? null : (
              <div>
                <div className="section-title">Customer pays</div>
                <div className="kpi mt-1">
                  <Money value={view.payable} />
                </div>
                {view.upgrade ? (
                  <div className="hint">
                    for {view.upgrade.label} (<Money value={view.upgrade.price} />)
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {!isPartner && wePay && wePay > 0 ? (
            <PayoutRequestPanel
              caseId={view.id}
              caseRef={view.ref}
              payoutAmount={wePay}
              customerName={view.customer?.name}
              customerPhone={view.customer?.phone}
              deviceLabel={
                view.device
                  ? `${view.device.brand} ${view.device.model}${view.device.variant ? ` ${view.device.variant}` : ""}`
                  : null
              }
              isManager={isManager}
            />
          ) : null}

          {!isPartner && view.payable && view.payable > 0 ? (
            <RazorpayPaymentPanel
              caseId={view.id}
              caseRef={view.ref}
              mode="swap"
              repairAmount={null}
              swapAmount={view.payable}
              customerName={view.customer?.name}
              customerPhone={view.customer?.phone}
            />
          ) : null}

          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-[14px]">
            <div>
              <dt className="text-muted text-[12.5px]">Customer</dt>
              <dd className="font-semibold">
                {showCustomer ? (
                  <>
                    {view.customer?.name ?? "—"} · <span className="num">{view.customer?.phone ?? "—"}</span>
                    <div className="text-[13px] font-normal text-ink-2">
                      {idTypeLabel(view.customer?.idType)} ending <span className="num">{view.customer?.idLast4 ?? "—"}</span>
                    </div>
                  </>
                ) : (
                  <span className="num">{maskPhone(view.customer?.phone)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-[12.5px]">Old phone</dt>
              <dd className="font-semibold">
                {view.device ? `${view.device.brand} ${view.device.model} ${view.device.variant ?? ""}` : "—"}
                <div className="text-[13px] font-normal text-ink-2 num">IMEI {view.imei ? (showCustomer ? view.imei : maskImei(view.imei)) : "—"}</div>
                {view.imei2 ? (
                  <div className="text-[13px] font-normal text-ink-2 num">IMEI 2 {showCustomer ? view.imei2 : maskImei(view.imei2)}</div>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-[12.5px]">Hand-over checks</dt>
              <dd>
                {view.checks ? (
                  <>
                    All confirmed by {view.checks.by}, {fmtWhen(view.checks.at)}
                    {view.checks.kym ? (
                      <div className="text-[13px] text-ink-2">
                        IMEI register: {view.checks.kym.status === "clear" ? "no block" : view.checks.kym.status}
                        {view.checks.kym.reference ? ` · ${view.checks.kym.reference}` : ""}
                      </div>
                    ) : null}
                    {view.checks.imeiCheckAck ? <div className="text-[13px] text-warn">IMEI check digit failed — staff confirmed.</div> : null}
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted text-[12.5px]">Pickup</dt>
              <dd>
                {pickup ? (
                  <>
                    <span className="num font-semibold">{pickup.ref}</span> · {PICKUP_STATUS_LABEL[pickup.status as PickupStatus] ?? pickup.status}
                  </>
                ) : view.status === "locked" ? (
                  view.dataClearState === "due" ? "Clear the data first" : "Waiting at the store"
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted text-[12.5px]">SwapUp grade</dt>
              <dd>
                {view.grading ? (
                  <>
                    <span className={`font-semibold ${TONE_TEXT[gradeTone(view.grading.status, view.grading.final)]}`}>{view.grading.label}</span>
                    {view.grading.report ? (
                      <span className="text-[13px] text-ink-2">
                        {" "}
                        · report v{view.grading.report.version}
                        {view.grading.report.final ? ", frozen at hand-over" : ""}
                      </span>
                    ) : null}
                    {view.grading.why ? <div className="text-[13px] text-ink-2">{view.grading.why}</div> : null}
                  </>
                ) : (
                  <span className="text-muted">No grade report.</span>
                )}
              </dd>
            </div>
          </dl>

          {cl ? (
            <div className={`rounded-[12px] px-4 py-3 border ${cl.outcome === "cleared" ? "bg-up-bg border-line" : "bg-warn-bg border-line"}`}>
              <div className="font-semibold">{OUTCOME_LABEL[cl.outcome as ClearanceOutcome] ?? cl.outcome}</div>
              <div className="text-[14px] mt-1">
                Partner accepted <Money value={cl.accepted} className="font-semibold" />
                {cl.shortfall > 0 ? (
                  <>
                    {" "}
                    · shortfall <Money value={cl.shortfall} className="font-semibold text-bad" />
                  </>
                ) : null}
              </div>
              {cl.reason ? <div className="text-[13.5px] text-ink-2 mt-1">&ldquo;{cl.reason}&rdquo;</div> : null}
              <div className="hint">
                {cl.by}, {fmtWhen(cl.at)}
              </div>
            </div>
          ) : null}

          <div>
            <div className="section-title mb-2">Timeline</div>
            <ol className="relative border-l-2 border-line ml-1.5 space-y-3">
              {timeline.map((t) => (
                <li key={t.label} className="pl-4 relative">
                  <span className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ${t.at ? "bg-[color:var(--ink)]" : "bg-[color:var(--line-2)]"}`} aria-hidden />
                  <div className="text-[14px] font-semibold">{t.label}</div>
                  <div className="text-[12.5px] text-muted">
                    {t.at ? fmtWhen(t.at) : "pending"}
                    {t.note ? ` · ${t.note}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-wrap gap-2 no-print">
            <Link href={`/cases/${view.id}/receipt`} className="btn btn-sm">
              🖨 Print receipt
            </Link>
            <Link href={`/cases/${view.id}/receipt?email=1`} className="btn btn-sm">
              ✉ Email receipt
            </Link>
            <Link href={`/cases/${view.id}/tag`} className="btn btn-sm">
              Print tag
            </Link>
            {view.grading?.report ? (
              <Link href={`/cases/${view.id}/report`} className="btn btn-sm">
                Print grade report
              </Link>
            ) : null}
          </div>

          {isManager && view.status === "locked" ? (
            <div className="border-t border-line pt-4 no-print">
              {cancelling ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="label">Why cancel?</span>
                    <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. new phone returned" maxLength={200} />
                  </label>
                  <p className="hint !mt-0">Phone goes back; credit is released.</p>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={cancel}>
                      Cancel trade-in
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCancelling(false)}>
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setCancelling(true)}>
                  Cancel trade-in
                </button>
              )}
              <ErrorText error={err} />
            </div>
          ) : null}
        </div>
      </section>

      {view.dataClearState === "done" || view.dataClearState === "attested" ? <DataClearCard ops={ops} canRecord={isCounter} /> : null}
      <DeclaredCard ops={ops} />
    </div>
  );
}

/** What was declared at the counter — the description the partner's price was for. */
export function DeclaredCard({ ops }: { ops: CaseOps }) {
  const { view } = ops;
  const q = view.quote;
  return (
    <section className="card">
      <header className="px-5 pt-4">
        <h2 className="text-[17px] font-[720]">As declared</h2>
      </header>
      <div className="px-5 pb-5 pt-3 space-y-3 text-[14px]">
        <div>
          <span className="text-muted">Faults: </span>
          {view.faults.length ? faultLabels(view.faults) : "none"}
          <span className="text-muted"> · Cover: </span>
          {COVER_LABEL[view.coverage]}
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {conditionSummary(view.condition).map((s) => (
            <li key={s} className="pill">
              {s}
            </li>
          ))}
        </ul>
        {q && q.status === "priced" ? (
          <details className="rounded-[11px] border border-line">
            <summary className="cursor-pointer px-4 py-2.5 font-semibold">
              Price trace
            </summary>
            <table className="w-full text-[14px] mx-4 mb-3" style={{ width: "calc(100% - 2rem)" }}>
              <tbody>
                {q.lines.map((l, i) => (
                  <tr key={`${l.label}-${i}`} className="border-t border-line first:border-t-0">
                    <td className="py-1.5 pr-3 text-ink-2">{l.label}</td>
                    <td className="py-1.5 text-right">
                      <Money value={l.amount} sign={i > 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint px-4 pb-3 !mt-0">
              {quoteSourceLabel(q.source)} · quoted {fmtWhen(q.quotedAt)}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
