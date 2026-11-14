import Link from "next/link";
import { Banner, Card, Money } from "@/components/ui";
import { fmtWhen } from "@/components/pickups/format";
import type { CounterPayoutView, PayoutStatus } from "@/lib/server/payouts";

const STATUS_PILL: Record<PayoutStatus, { label: string; cls: string }> = {
  PENDING_APPROVAL: { label: "Pending Manager Approval", cls: "pill-warn" },
  APPROVED: { label: "Approved", cls: "pill-up" },
  PROCESSING: { label: "Processing via Razorpay", cls: "pill-warn" },
  COMPLETED: { label: "Paid via Razorpay", cls: "pill-up" },
  REJECTED: { label: "Rejected by Manager", cls: "pill-bad" },
  FAILED: { label: "Failed", cls: "pill-bad" },
  REVERSED: { label: "Reversed", cls: "pill-bad" },
};

/**
 * Customer-facing Payout Requests card for Store Counter login (`advisor`).
 * Shows ONLY customer payout amounts, status, and manager rejection reasons —
 * NEVER any store wallet, balance, exposure, or credit limit figures.
 */
export function CounterPayoutStatusCard({ payouts }: { payouts: CounterPayoutView[] }) {
  const rejected = payouts.filter((p) => p.status === "REJECTED");

  return (
    <Card title="Customer payout requests">
      {rejected.length > 0 ? (
        <div className="mb-3 space-y-2">
          {rejected.slice(0, 2).map((r) => (
            <Banner key={r.id} tone="bad">
              <div className="font-semibold">
                Payout rejected for <Link href={`/cases/${r.caseId}`} className="underline">{r.caseRef}</Link> (<Money value={r.amount} />)
              </div>
              {r.rejectionReason ? (
                <div className="text-[13px] mt-0.5">Reason: &ldquo;{r.rejectionReason}&rdquo;</div>
              ) : null}
            </Banner>
          ))}
        </div>
      ) : null}

      {payouts.length === 0 ? (
        <p className="text-[13.5px] text-muted">
          When a customer accepts a trade-in payout, submit a payout request on their case. It will be routed to the Store Manager for approval and Razorpay transfer.
        </p>
      ) : (
        <div className="space-y-2.5">
          {payouts.slice(0, 6).map((p) => {
            const st = STATUS_PILL[p.status] ?? { label: p.status, cls: "" };
            return (
              <div
                key={p.id}
                className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5 text-[13px] flex flex-wrap items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link href={`/cases/${p.caseId}`} className="num font-semibold text-ink hover:underline">
                      {p.caseRef}
                    </Link>
                    <span className="font-medium truncate">{p.customerName}</span>
                  </div>
                  <div className="text-[12px] text-muted mt-0.5">
                    {p.deviceLabel || "Trade-in"} · {fmtWhen(p.requestedAt)}
                  </div>
                  {p.status === "REJECTED" && p.rejectionReason ? (
                    <div className="text-[12px] text-bad mt-0.5">
                      Rejected: &ldquo;{p.rejectionReason}&rdquo;
                    </div>
                  ) : null}
                </div>
                <div className="text-right">
                  <div className="num font-bold text-[14.5px]">
                    <Money value={p.amount} />
                  </div>
                  <span className={`pill !text-[11px] mt-0.5 ${st.cls}`}>{st.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
