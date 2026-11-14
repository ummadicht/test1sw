"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, Card, Empty, ErrorText, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import { fmtWhen } from "@/components/pickups/format";
import type {
  ManagerPayoutView,
  PayoutLedgerRow,
  PayoutStatus,
} from "@/lib/server/payouts";

const STATUS_PILL: Record<PayoutStatus, { label: string; cls: string }> = {
  PENDING_APPROVAL: { label: "Pending Approval", cls: "pill-warn" },
  APPROVED: { label: "Approved", cls: "pill-up" },
  PROCESSING: { label: "Processing", cls: "pill-warn" },
  COMPLETED: { label: "Completed", cls: "pill-up" },
  REJECTED: { label: "Rejected", cls: "pill-bad" },
  FAILED: { label: "Failed", cls: "pill-bad" },
  REVERSED: { label: "Reversed", cls: "pill-bad" },
};

export function ManagerPayoutQueue({
  storeId,
  initialPayouts,
  initialBalance,
  initialLedger,
  showLedger = true,
}: {
  storeId: string;
  initialPayouts: ManagerPayoutView[];
  initialBalance: number;
  initialLedger?: PayoutLedgerRow[];
  showLedger?: boolean;
}) {
  const [payouts, setPayouts] = useState<ManagerPayoutView[]>(initialPayouts);
  const [availableBalance, setAvailableBalance] = useState<number>(initialBalance);
  const [ledger, setLedger] = useState<PayoutLedgerRow[]>(initialLedger ?? []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{
        payouts: ManagerPayoutView[];
        storeBalance?: { availableBalance: number };
        ledger?: PayoutLedgerRow[];
      }>(`/api/payouts?storeId=${encodeURIComponent(storeId)}`);
      setPayouts(res.payouts || []);
      if (res.storeBalance) setAvailableBalance(res.storeBalance.availableBalance);
      if (res.ledger) setLedger(res.ledger);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [storeId]);

  useEffect(() => {
    setPayouts(initialPayouts);
    setAvailableBalance(initialBalance);
    if (initialLedger) setLedger(initialLedger);
  }, [initialPayouts, initialBalance, initialLedger]);

  async function approve(id: string) {
    setErr(null);
    setBusyId(id);
    try {
      await api(`/api/payouts/${encodeURIComponent(id)}`, {
        body: { action: "approve" },
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    if (rejectReason.trim().length < 3) {
      setErr("Enter a reason for rejecting this payout request.");
      return;
    }
    setErr(null);
    setBusyId(id);
    try {
      await api(`/api/payouts/${encodeURIComponent(id)}`, {
        body: { action: "reject", reason: rejectReason.trim() },
      });
      setRejectingId(null);
      setRejectReason("");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const pending = payouts.filter((p) => p.status === "PENDING_APPROVAL");
  const alerts = payouts.filter(
    (p) => p.status === "FAILED" || p.status === "PROCESSING" || p.status === "REVERSED"
  );

  return (
    <div className="space-y-4" id="payout-approvals">
      {pending.length > 0 ? (
        <Banner tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>
                {pending.length} customer payout {pending.length === 1 ? "request awaits" : "requests await"} your approval
              </strong>{" "}
              — review customer, device, and store balance before &amp; after payout below to trigger Razorpay Payouts.
            </div>
            <span className="pill pill-warn num">{pending.length} pending</span>
          </div>
        </Banner>
      ) : null}

      {alerts.map((a) => (
        <Banner key={a.id} tone={a.status === "PROCESSING" ? "warn" : "bad"}>
          <strong>
            Payout Alert ({a.caseRef} · {inr(a.amount)}):
          </strong>{" "}
          {a.managerAlert || `Status is ${a.status}.`}
        </Banner>
      ))}

      <Card
        title={`Store Payout Approval Queue (${payouts.length})`}
        action={
          <span className="text-[13px] text-ink-2">
            Available store balance: <strong className="num text-ink"><Money value={availableBalance} /></strong>
          </span>
        }
        pad={false}
      >
        {payouts.length === 0 ? (
          <Empty title="No customer payout requests yet">
            When counter staff submit a customer trade-in payout request, it appears here for Store Manager approval.
          </Empty>
        ) : (
          <div className="overflow-x-auto px-5 pb-4">
            <table className="table min-w-[820px]">
              <thead>
                <tr>
                  <th>Case &amp; Device</th>
                  <th>Customer &amp; Fund Account</th>
                  <th className="text-right!">Requested</th>
                  <th className="text-right!">Balance Before</th>
                  <th className="text-right!">Balance After</th>
                  <th>Status</th>
                  <th className="text-right!">Manager Action</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => {
                  const st = STATUS_PILL[p.status] ?? { label: p.status, cls: "" };
                  const isBusy = busyId === p.id;
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link
                          href={`/cases/${p.caseId}`}
                          className="num font-semibold hover:underline whitespace-nowrap"
                        >
                          {p.caseRef}
                        </Link>
                        <div className="text-[13px] text-ink-2">{p.deviceLabel || "Trade-in phone"}</div>
                        <div className="text-[11.5px] text-muted">
                          By {p.requestedByName || p.requestedBy} · {fmtWhen(p.requestedAt)}
                        </div>
                      </td>
                      <td>
                        <div className="font-semibold text-[13.5px]">{p.customerName}</div>
                        <div className="num text-[12.5px] text-ink-2">{p.customerPhone}</div>
                        <div className="text-[12px] text-muted">
                          {p.payoutMode.toUpperCase()}
                          {p.fundAccountUpi ? ` · ${p.fundAccountUpi}` : ""}
                          {p.fundAccountNumber ? ` · A/C ${p.fundAccountNumber} (${p.fundAccountIfsc})` : ""}
                        </div>
                      </td>
                      <td className="text-right">
                        <Money value={p.amount} className="font-bold text-[15px]" />
                      </td>
                      <td className="text-right">
                        <Money value={p.balanceBefore} className="font-medium text-ink-2" />
                      </td>
                      <td className="text-right">
                        <Money
                          value={p.balanceAfter}
                          className={`font-semibold ${p.balanceAfter < 0 ? "text-bad" : "text-up"}`}
                        />
                      </td>
                      <td>
                        <span className={`pill ${st.cls}`}>{st.label}</span>
                        {p.razorpayPayoutId ? (
                          <div className="text-[11.5px] text-muted num mt-0.5">{p.razorpayPayoutId}</div>
                        ) : null}
                        {p.rejectionReason ? (
                          <div className="text-[12px] text-bad mt-0.5 max-w-[200px]">
                            &ldquo;{p.rejectionReason}&rdquo;
                          </div>
                        ) : null}
                        {p.failureReason ? (
                          <div className="text-[12px] text-bad mt-0.5 max-w-[200px]">
                            {p.failureReason}
                          </div>
                        ) : null}
                      </td>
                      <td className="text-right">
                        {p.status === "PENDING_APPROVAL" ? (
                          p.selfApprovalBlocked ? (
                            <span className="text-[12px] text-warn font-semibold">
                              Created by you (requires another manager)
                            </span>
                          ) : (
                            <div className="flex flex-col items-end gap-1.5">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  className="btn btn-sm btn-up !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]"
                                  disabled={isBusy || !p.canApprove}
                                  onClick={() => approve(p.id)}
                                >
                                  {isBusy ? "Paying…" : "Approve & Pay"}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-danger !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]"
                                  disabled={isBusy}
                                  onClick={() => setRejectingId(rejectingId === p.id ? null : p.id)}
                                >
                                  Reject
                                </button>
                              </div>
                              {rejectingId === p.id ? (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <input
                                    type="text"
                                    placeholder="Rejection reason…"
                                    className="input !min-h-[30px] !py-0.5 !px-2 text-[12.5px] w-[170px]"
                                    value={rejectReason}
                                    onChange={(e) => setRejectReason(e.target.value)}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-danger !min-h-[30px] !py-0.5 !px-2 !text-[12px]"
                                    disabled={isBusy || rejectReason.trim().length < 3}
                                    onClick={() => reject(p.id)}
                                  >
                                    Confirm
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          )
                        ) : (
                          <span className="text-[12.5px] text-muted">
                            {p.reviewedByName ? `Reviewed by ${p.reviewedByName}` : "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-2">
              <ErrorText error={err} />
            </div>
          </div>
        )}
      </Card>

      {showLedger && ledger.length > 0 ? (
        <Card title={`Immutable Payout Ledger (${ledger.length})`} pad={false}>
          <div className="overflow-x-auto px-5 pb-3">
            <table className="table min-w-[680px]">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Entry</th>
                  <th>Payout / Case</th>
                  <th className="text-right!">Amount</th>
                  <th className="text-right!">Balance Before</th>
                  <th className="text-right!">Balance After</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-[13px]">{fmtWhen(l.created_at)}</td>
                    <td>
                      <span className={`pill ${l.entry_type === "DEBIT" ? "pill-warn" : "pill-up"}`}>
                        {l.entry_type}
                      </span>
                    </td>
                    <td className="num text-[13px]">
                      <Link href={`/cases/${l.case_id}`} className="font-semibold hover:underline">
                        {l.payout_id}
                      </Link>
                    </td>
                    <td className="text-right font-semibold">
                      <Money value={l.entry_type === "DEBIT" ? -l.amount : l.amount} sign />
                    </td>
                    <td className="text-right">
                      <Money value={l.balance_before} />
                    </td>
                    <td className="text-right font-semibold">
                      <Money value={l.balance_after} />
                    </td>
                    <td className="text-[13px] text-ink-2">{l.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
