"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type {
  CounterPayoutView,
  ManagerPayoutView,
  PayoutMode,
  PayoutStatus,
} from "@/lib/server/payouts";
import { fmtWhen } from "./shared";

const STATUS_BADGE: Record<PayoutStatus, { label: string; cls: string }> = {
  PENDING_APPROVAL: { label: "Pending Manager Approval", cls: "pill-warn" },
  APPROVED: { label: "Approved · Initiating Razorpay", cls: "pill-up" },
  PROCESSING: { label: "Processing at Razorpay", cls: "pill-warn" },
  COMPLETED: { label: "Completed · Paid via Razorpay", cls: "pill-up" },
  REJECTED: { label: "Rejected by Manager", cls: "pill-bad" },
  FAILED: { label: "Payout Failed", cls: "pill-bad" },
  REVERSED: { label: "Payout Reversed", cls: "pill-bad" },
};

function isManagerView(p: CounterPayoutView | ManagerPayoutView): p is ManagerPayoutView {
  return "balanceBefore" in p && typeof p.balanceBefore === "number";
}

export function PayoutRequestPanel({
  caseId,
  caseRef,
  payoutAmount,
  customerName,
  customerPhone,
  deviceLabel,
  isManager,
}: {
  caseId: string;
  caseRef: string;
  payoutAmount: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deviceLabel?: string | null;
  isManager: boolean;
}) {
  const [payouts, setPayouts] = useState<(CounterPayoutView | ManagerPayoutView)[]>([]);
  const [storeBalance, setStoreBalance] = useState<number | null>(null);
  const [payoutMode, setPayoutMode] = useState<PayoutMode>("upi");
  const [upiId, setUpiId] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{
        payouts: (CounterPayoutView | ManagerPayoutView)[];
        storeBalance?: { availableBalance: number };
      }>(`/api/payouts?caseId=${encodeURIComponent(caseId)}`);
      setPayouts(res.payouts || []);
      if (isManager && res.storeBalance) {
        setStoreBalance(res.storeBalance.availableBalance);
      } else {
        setStoreBalance(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [caseId, isManager]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const effectiveAmount = payoutAmount && payoutAmount > 0 ? payoutAmount : 0;
  const latest = payouts[0] ?? null;
  const canCreateNew =
    effectiveAmount > 0 &&
    (!latest || latest.status === "REJECTED" || latest.status === "FAILED" || showNewForm);

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (effectiveAmount <= 0) return;
    setErr(null);
    setBusy(true);
    try {
      const idempotencyKey = `idem_${caseId}_${effectiveAmount}_${payoutMode}_${Date.now()}`;
      await api<{ payout: CounterPayoutView | ManagerPayoutView }>("/api/payouts", {
        body: {
          caseId,
          amount: effectiveAmount,
          payoutMode,
          fundAccountUpi: payoutMode === "upi" ? upiId.trim() : null,
          fundAccountBankName: payoutMode === "imps" || payoutMode === "neft" ? bankName.trim() : null,
          fundAccountNumber: payoutMode === "imps" || payoutMode === "neft" ? accountNumber.trim() : null,
          fundAccountIfsc: payoutMode === "imps" || payoutMode === "neft" ? ifsc.trim().toUpperCase() : null,
          customerName,
          customerPhone,
          idempotencyKey,
          notes: notes.trim() || null,
        },
      });
      setShowNewForm(false);
      await refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(payoutId: string) {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/payouts/${encodeURIComponent(payoutId)}`, {
        body: { action: "approve" },
      });
      await refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(payoutId: string) {
    if (rejectReason.trim().length < 3) {
      setErr("Enter a reason for rejecting this payout request.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/payouts/${encodeURIComponent(payoutId)}`, {
        body: { action: "reject", reason: rejectReason.trim() },
      });
      setRejectingId(null);
      setRejectReason("");
      await refresh();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (effectiveAmount <= 0 && payouts.length === 0) return null;

  return (
    <div className="rounded-[12px] border border-line bg-surface-2 p-4 space-y-4 no-print" data-testid="payout-request-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-[#072654] px-2.5 py-1 text-[12px] font-bold tracking-wide text-white">
            RazorpayX Payouts
          </span>
          <span className="text-[15px] font-[720] text-ink">
            Customer Trade-In Payout ({caseRef})
          </span>
        </div>
        <div className="text-[13.5px] text-ink-2">
          Customer Payout Amount: <strong className="num text-[15px] text-up">{inr(effectiveAmount)}</strong>
        </div>
      </div>

      {/* Only Store Managers ever see Store Balance Before / After */}
      {isManager && storeBalance !== null ? (
        <div className="rounded-[10px] border border-line bg-surface px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <div>
            <span className="text-muted">Store Available Balance (Manager Only): </span>
            <strong className="num text-ink"><Money value={storeBalance} /></strong>
          </div>
          {effectiveAmount > 0 && (!latest || latest.status === "PENDING_APPROVAL") ? (
            <div>
              <span className="text-muted">Balance After Payout: </span>
              <strong className={`num ${storeBalance - effectiveAmount < 0 ? "text-bad" : "text-up"}`}>
                <Money value={storeBalance - effectiveAmount} />
              </strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Existing Payout Requests */}
      {payouts.length > 0 ? (
        <div className="space-y-3">
          {payouts.map((p) => {
            const st = STATUS_BADGE[p.status] ?? { label: p.status, cls: "" };
            const mgr = isManager && isManagerView(p) ? p : null;
            return (
              <div key={p.id} className="rounded-[10px] border border-line bg-surface p-3.5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`pill ${st.cls}`}>{st.label}</span>
                      <span className="num font-bold text-[16px] text-ink">{inr(p.amount)}</span>
                      <span className="text-[12.5px] text-muted uppercase font-semibold">
                        via {p.payoutMode}
                      </span>
                    </div>
                    <div className="text-[13px] text-ink-2 mt-1">
                      Customer: <strong>{p.customerName}</strong> ({p.customerPhone})
                      {p.deviceLabel ? ` · ${p.deviceLabel}` : ""}
                    </div>
                    <div className="text-[12.5px] text-muted mt-0.5">
                      {p.payoutMode === "upi" && p.fundAccountUpi ? (
                        <>UPI VPA: <code className="num text-ink">{p.fundAccountUpi}</code> · </>
                      ) : null}
                      {(p.payoutMode === "imps" || p.payoutMode === "neft") && p.fundAccountNumber ? (
                        <>Bank A/C: <code className="num text-ink">{p.fundAccountNumber}</code> ({p.fundAccountIfsc}) · </>
                      ) : null}
                      Requested by {p.requestedByName || p.requestedBy} ({p.requestedByRole}) · {fmtWhen(p.requestedAt)}
                    </div>
                  </div>
                  {p.razorpayPayoutId ? (
                    <div className="text-right text-[12px] text-muted">
                      <div>Razorpay Payout ID</div>
                      <code className="num font-semibold text-ink">{p.razorpayPayoutId}</code>
                    </div>
                  ) : null}
                </div>

                {/* Rejection Banner for Counter & Manager */}
                {p.status === "REJECTED" ? (
                  <Banner tone="bad">
                    <div className="font-semibold">
                      Payout request rejected by Store Manager{p.reviewedByName ? ` (${p.reviewedByName})` : ""}
                    </div>
                    {p.rejectionReason ? (
                      <div className="mt-0.5 text-[13.5px]">Reason: &ldquo;{p.rejectionReason}&rdquo;</div>
                    ) : null}
                    <div className="mt-1 text-[12.5px] opacity-90">No money was transferred.</div>
                  </Banner>
                ) : null}

                {/* Pending Approval Banner for Counter User */}
                {!isManager && p.status === "PENDING_APPROVAL" ? (
                  <Banner tone="warn">
                    <strong>Routed to Store Manager for approval.</strong> Once approved, the {inr(p.amount)} payout will be processed automatically via Razorpay.
                  </Banner>
                ) : null}

                {/* Completed Banner */}
                {p.status === "COMPLETED" ? (
                  <Banner tone="up">
                    <strong>Payout of {inr(p.amount)} completed via Razorpay</strong>
                    {p.razorpayPayoutId ? ` (Ref: ${p.razorpayPayoutId})` : ""}.
                  </Banner>
                ) : null}

                {/* Manager-only balance & approval controls */}
                {mgr ? (
                  <div className="border-t border-line pt-2.5 space-y-2.5">
                    <div className="flex flex-wrap items-center gap-4 text-[13px]">
                      <span>
                        <span className="text-muted">Store Balance Before: </span>
                        <strong className="num"><Money value={mgr.balanceBefore} /></strong>
                      </span>
                      <span>
                        <span className="text-muted">Store Balance After: </span>
                        <strong className={`num ${mgr.balanceAfter < 0 ? "text-bad" : "text-up"}`}>
                          <Money value={mgr.balanceAfter} />
                        </strong>
                      </span>
                    </div>

                    {mgr.managerAlert ? (
                      <Banner tone={p.status === "FAILED" || p.status === "REVERSED" ? "bad" : "warn"}>
                        {mgr.managerAlert}
                      </Banner>
                    ) : null}

                    {p.status === "PENDING_APPROVAL" ? (
                      mgr.selfApprovalBlocked ? (
                        <Banner tone="warn">
                          You created this payout request. Another Store Manager must approve it (self-approval is not permitted).
                        </Banner>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="btn btn-sm btn-up"
                              disabled={busy || !mgr.canApprove}
                              onClick={() => handleApprove(p.id)}
                            >
                              {busy ? "Processing…" : `Approve & Pay ${inr(p.amount)} via Razorpay`}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busy}
                              onClick={() => setRejectingId(rejectingId === p.id ? null : p.id)}
                            >
                              Reject Request
                            </button>
                          </div>

                          {rejectingId === p.id ? (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <input
                                type="text"
                                className="input !min-h-[34px] !py-1 !px-3 flex-1 min-w-[220px] text-[13.5px]"
                                placeholder="Reason for rejection (sent to counter staff)…"
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={busy || rejectReason.trim().length < 3}
                                onClick={() => handleReject(p.id)}
                              >
                                Confirm Rejection
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Form for Counter Staff to request customer payout approval */}
      {canCreateNew ? (
        <form onSubmit={submitRequest} className="rounded-[10px] border border-line bg-surface p-3.5 space-y-3">
          <div className="text-[13.5px] font-semibold text-ink">
            When the customer accepts the {inr(effectiveAmount)} trade-in payout, submit a payout request for Store Manager approval:
          </div>

          <div className="grid sm:grid-cols-3 gap-2.5">
            <label className="block">
              <span className="label">Payout Mode</span>
              <select
                className="select !min-h-[36px] !py-1 text-[13.5px]"
                value={payoutMode}
                onChange={(e) => setPayoutMode(e.target.value as PayoutMode)}
                disabled={busy}
              >
                <option value="upi">UPI Instant Transfer (VPA)</option>
                <option value="imps">IMPS Bank Transfer</option>
                <option value="neft">NEFT Bank Transfer</option>
                <option value="store_credit">Store Credit Voucher</option>
              </select>
            </label>

            {payoutMode === "upi" ? (
              <label className="block sm:col-span-2">
                <span className="label">Customer UPI ID (VPA)</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. customer@okicici"
                  className="input !min-h-[36px] !py-1 text-[13.5px]"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  disabled={busy}
                />
              </label>
            ) : null}

            {payoutMode === "imps" || payoutMode === "neft" ? (
              <>
                <label className="block">
                  <span className="label">Account Number</span>
                  <input
                    type="text"
                    required
                    placeholder="Bank account number"
                    className="input num !min-h-[36px] !py-1 text-[13.5px]"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="block">
                  <span className="label">IFSC Code</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. HDFC0001234"
                    className="input num uppercase !min-h-[36px] !py-1 text-[13.5px]"
                    value={ifsc}
                    onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                    disabled={busy}
                  />
                </label>
                <label className="block">
                  <span className="label">Bank Name (optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. HDFC Bank"
                    className="input !min-h-[36px] !py-1 text-[13.5px]"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </>
            ) : null}
          </div>

          <label className="block">
            <span className="label">Counter Note (optional)</span>
            <input
              type="text"
              placeholder="Customer verified ID and accepted trade-in cash-out"
              className="input !min-h-[34px] !py-1 text-[13px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn btn-sm btn-primary !bg-[#072654] !border-[#072654] !text-white"
              disabled={busy || (payoutMode === "upi" && !upiId.trim())}
            >
              {busy
                ? "Submitting Request…"
                : `Request Manager Approval for ${inr(effectiveAmount)} Payout`}
            </button>
            {deviceLabel ? (
              <span className="text-[12.5px] text-muted">
                Device: {deviceLabel}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <ErrorText error={err} />
    </div>
  );
}
