"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type {
  CaseRazorpaySummary,
  RazorpayPaymentPlan,
  RazorpayPaymentRow,
} from "@/lib/server/razorpay";
import { fmtWhen } from "./shared";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (res: unknown) => void) => void;
    };
  }
}

async function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.Razorpay) return true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const PLAN_LABELS: Record<RazorpayPaymentPlan, string> = {
  repair_part_advance: "Repair · Full Payment",
  repair_remaining: "Repair · Full Payment",
  repair_full: "Repair · Full Payment",
  swap_direct: "Swap Up · Complete Payment (100%)",
  swap_emi: "Swap Up · Complete Payment (100%)",
};

function parseReceiptEmailNote(notes: string | null): { emailedTo?: string; emailedAt?: string } {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes) as { emailedTo?: string; emailedAt?: string };
    return parsed || {};
  } catch {
    return {};
  }
}

export function RazorpayPaymentPanel({
  caseId,
  caseRef,
  mode,
  repairAmount,
  swapAmount,
  customerName,
  customerPhone,
  onPaid,
}: {
  caseId: string;
  caseRef: string;
  /** Which tab to highlight by default ('repair' | 'swap' | 'both') */
  mode: "repair" | "swap" | "both";
  repairAmount: number | null;
  swapAmount: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  onPaid?: (payment: RazorpayPaymentRow, summary: CaseRazorpaySummary) => void;
}) {
  const [summary, setSummary] = useState<CaseRazorpaySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<{
    payment: RazorpayPaymentRow;
    keyId: string;
    liveKeysConfigured: boolean;
  } | null>(null);
  const [selectedSimMethod, setSelectedSimMethod] = useState<"upi" | "card" | "netbanking">("upi");

  // Email receipt state
  const [emailComposerFor, setEmailComposerFor] = useState<string | "all" | null>(null);
  const [receiptEmail, setReceiptEmail] = useState<string>("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [sentReceipt, setSentReceipt] = useState<{
    to: string;
    subject: string;
    html: string;
    text: string;
    paymentId: string | null;
  } | null>(null);
  const [previewHtmlOpen, setPreviewHtmlOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api<CaseRazorpaySummary>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`);
      setSummary(s);
      setReceiptEmail((prev) => {
        if (prev) return prev;
        for (const p of s.payments) {
          const n = parseReceiptEmailNote(p.notes);
          if (n.emailedTo) return n.emailedTo;
        }
        return prev;
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const effectiveSwapTotal = swapAmount ?? summary?.swap.totalPayable ?? null;
  const swapPaid = summary?.swap.paidAmount ?? 0;
  const swapRemaining =
    effectiveSwapTotal !== null ? Math.max(0, effectiveSwapTotal - swapPaid) : 0;

  async function startCheckout() {
    setErr(null);
    setBusy(true);
    try {
      const res = await api<{
        payment: RazorpayPaymentRow;
        keyId: string;
        liveKeysConfigured: boolean;
        summary: CaseRazorpaySummary;
      }>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`, {
        body: {
          action: "create_order",
          journey: "swap",
          paymentPlan: "swap_direct",
          customAdvanceAmount: null,
          overrideTotalAmount: effectiveSwapTotal,
          emiMonths: null,
          customerName,
          customerPhone,
        },
      });

      setSummary(res.summary);

      if (res.liveKeysConfigured) {
        const loaded = await loadRazorpayScript();
        if (loaded && window.Razorpay) {
          const rzp = new window.Razorpay({
            key: res.keyId,
            amount: res.payment.amount * 100,
            currency: "INR",
            name: "SwapUp",
            description: `${caseRef} · Complete Swap Payment`,
            order_id: res.payment.razorpay_order_id,
            prefill: {
              name: customerName || "",
              contact: customerPhone || "",
            },
            theme: { color: "#0f172a" },
            handler: async (response: {
              razorpay_order_id: string;
              razorpay_payment_id: string;
              razorpay_signature: string;
            }) => {
              const verified = await api<{
                payment: RazorpayPaymentRow;
                summary: CaseRazorpaySummary;
              }>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`, {
                body: {
                  action: "verify_payment",
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                  paymentMethod: "razorpay",
                },
              });
              setSummary(verified.summary);
              onPaid?.(verified.payment, verified.summary);
            },
          });
          rzp.open();
          setBusy(false);
          return;
        }
      }

      // Open interactive Razorpay Checkout modal (when testing without live secret or in iframe)
      setSelectedSimMethod("upi");
      setActiveOrder({
        payment: res.payment,
        keyId: res.keyId,
        liveKeysConfigured: res.liveKeysConfigured,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function completeSimulatedCheckout() {
    if (!activeOrder) return;
    setBusy(true);
    setErr(null);
    try {
      const verified = await api<{
        payment: RazorpayPaymentRow;
        summary: CaseRazorpaySummary;
      }>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`, {
        body: {
          action: "verify_payment",
          razorpayOrderId: activeOrder.payment.razorpay_order_id,
          paymentMethod: selectedSimMethod,
        },
      });
      setSummary(verified.summary);
      setActiveOrder(null);
      onPaid?.(verified.payment, verified.summary);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendEmailReceipt(e: React.FormEvent) {
    e.preventDefault();
    if (!receiptEmail.trim()) return;
    setErr(null);
    setEmailBusy(true);
    try {
      const targetPaymentId = emailComposerFor === "all" ? null : emailComposerFor;
      const res = await api<{
        ok: true;
        to: string;
        subject: string;
        html: string;
        text: string;
        summary: CaseRazorpaySummary;
      }>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`, {
        body: {
          action: "email_receipt",
          email: receiptEmail.trim(),
          paymentId: targetPaymentId,
        },
      });
      setSummary(res.summary);
      setSentReceipt({
        to: res.to,
        subject: res.subject,
        html: res.html,
        text: res.text,
        paymentId: targetPaymentId,
      });
      setEmailComposerFor(null);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setEmailBusy(false);
    }
  }

  const paidPayments = (summary?.payments ?? []).filter((p) => p.status === "paid");

  if (mode === "repair") {
    return null;
  }

  return (
    <div className="rounded-[12px] border border-line bg-surface-2 p-4 space-y-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-[#072654] px-2.5 py-1 text-[12px] font-bold tracking-wide text-white">
            Razorpay
          </span>
          <span className="text-[15px] font-[720] text-ink">
            Swap Up · Complete Payment (100% Full Payment Only)
          </span>
        </div>
        <span className="pill pill-up !text-[11.5px]">No part-payment</span>
      </div>

      {/* ─────────────── SWAP / UPGRADE COMPLETE PAYMENT FLOW ─────────────── */}
      <div className="space-y-3">
        {effectiveSwapTotal === null || effectiveSwapTotal <= 0 ? (
          <p className="text-[13.5px] text-muted">
            Select a target upgrade phone with a net payable balance to complete full payment via Razorpay.
          </p>
        ) : swapRemaining === 0 ? (
          <Banner tone="up">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>Swap upgrade complete payment ({inr(effectiveSwapTotal)}) paid in full via Razorpay.</strong>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]"
                  onClick={() => {
                    setEmailComposerFor("all");
                    setErr(null);
                  }}
                >
                  ✉ Email receipt
                </button>
                <Link
                  href={`/cases/${caseId}/receipt?autoprint=1`}
                  className="btn btn-sm !min-h-[30px] !py-1 !px-2.5 !text-[12.5px]"
                >
                  🖨 Print receipt
                </Link>
              </div>
            </div>
          </Banner>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-[color:var(--ink)] bg-surface p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[14px] font-[720] text-ink">
                    Complete Swap Payment (100% Full Payable)
                  </div>
                  <p className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">
                    Full payment is required to swap the phone. Part-payment is not available — customer either completes the full swap payment or chooses repair and walks out.
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-[11.5px] uppercase tracking-wider text-muted font-semibold">
                    Total Payable Now
                  </div>
                  <div className="num text-[20px] font-[780] text-ink">{inr(swapRemaining)}</div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-up btn-sm"
                disabled={busy}
                onClick={() => startCheckout()}
              >
                {busy
                  ? "Creating Razorpay Order…"
                  : `Pay Complete Amount ${inr(swapRemaining)} via Razorpay`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─────────────── INTERACTIVE RAZORPAY CHECKOUT MODAL ─────────────── */}
      {activeOrder ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Razorpay Checkout"
        >
          <div className="w-full max-w-[420px] rounded-[16px] overflow-hidden bg-surface shadow-2xl border border-line">
            <div className="bg-[#072654] text-white px-5 py-4 flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-widest opacity-80">
                  Razorpay Trusted Checkout
                </div>
                <div className="text-[18px] font-bold mt-0.5">
                  SwapUp · {caseRef}
                </div>
                <div className="text-[12.5px] opacity-90">
                  {PLAN_LABELS[activeOrder.payment.payment_plan]}
                </div>
              </div>
              <div className="text-right">
                <div className="num text-[22px] font-extrabold">
                  {inr(activeOrder.payment.amount)}
                </div>
                {activeOrder.payment.emi_months ? (
                  <div className="text-[11.5px] opacity-90 num">
                    {inr(activeOrder.payment.emi_monthly_amount)}/mo × {activeOrder.payment.emi_months}M
                  </div>
                ) : null}
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-[12.5px] text-muted flex items-center justify-between border-b border-line pb-2.5">
                <span>Order ID: <code className="num text-ink">{activeOrder.payment.razorpay_order_id}</code></span>
                <span className="num text-up font-semibold">100% Complete Payment</span>
              </div>

              <div className="space-y-2">
                <div className="text-[12.5px] font-bold uppercase tracking-wider text-ink-2">
                  Select Complete Payment Method
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(
                    [
                      ["upi", "UPI (GPay / PhonePe / Paytm)"],
                      ["card", "Credit / Debit Card"],
                      ["netbanking", "NetBanking"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelectedSimMethod(id)}
                      className={`rounded-[8px] border px-3 py-2 text-left text-[13px] ${
                        selectedSimMethod === id
                          ? "border-[#072654] bg-surface-2 font-semibold text-ink"
                          : "border-line text-ink-2"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => setActiveOrder(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary !bg-[#072654] !border-[#072654] !text-white"
                  disabled={busy}
                  onClick={completeSimulatedCheckout}
                >
                  {busy ? "Verifying Payment…" : `Authorize & Pay ${inr(activeOrder.payment.amount)}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─────────────── INLINE EMAIL RECEIPT COMPOSER ─────────────── */}
      {emailComposerFor !== null ? (
        <form
          onSubmit={handleSendEmailReceipt}
          className="rounded-[10px] border border-line bg-surface p-3.5 space-y-2.5"
        >
          <div className="text-[13px] font-semibold text-ink flex items-center justify-between">
            <span>
              ✉ Email Receipt for {caseRef}
              {emailComposerFor !== "all" ? " (selected payment)" : ""}
            </span>
            <button
              type="button"
              className="text-[12px] text-muted hover:text-ink"
              onClick={() => setEmailComposerFor(null)}
            >
              Close
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              required
              placeholder="customer@example.com"
              className="input !min-h-[34px] !py-1 !px-3 flex-1 min-w-[210px] text-[13.5px]"
              value={receiptEmail}
              onChange={(e) => setReceiptEmail(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={emailBusy || !receiptEmail.trim()}
            >
              {emailBusy ? "Sending Receipt…" : "Send Email Receipt"}
            </button>
          </div>
        </form>
      ) : null}

      {/* ─────────────── SENT EMAIL RECEIPT CONFIRMATION & PREVIEW ─────────────── */}
      {sentReceipt ? (
        <Banner tone="up">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>✓ Receipt emailed to {sentReceipt.to}</strong>
              <div className="text-[12.5px] opacity-90">{sentReceipt.subject}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
                onClick={() => setPreviewHtmlOpen((v) => !v)}
              >
                {previewHtmlOpen ? "Hide Email Preview" : "Preview Email"}
              </button>
              <a
                href={`mailto:${encodeURIComponent(sentReceipt.to)}?subject=${encodeURIComponent(sentReceipt.subject)}&body=${encodeURIComponent(sentReceipt.text)}`}
                className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
              >
                Open in Mail App
              </a>
            </div>
          </div>
          {previewHtmlOpen ? (
            <div
              className="mt-3 rounded-[10px] border border-line bg-white p-3 max-h-[380px] overflow-auto"
              dangerouslySetInnerHTML={{ __html: sentReceipt.html }}
            />
          ) : null}
        </Banner>
      ) : null}

      {/* ─────────────── PAYMENT RECEIPTS / HISTORY ─────────────── */}
      {paidPayments.length > 0 && (
        <div className="border-t border-line pt-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12px] font-bold uppercase tracking-wider text-ink-2">
              Razorpay Transactions &amp; Receipts ({caseRef})
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
                onClick={() => {
                  setEmailComposerFor("all");
                  setErr(null);
                }}
              >
                ✉ Email Receipt
              </button>
              <Link
                href={`/cases/${caseId}/receipt?autoprint=1`}
                className="btn btn-sm !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
              >
                🖨 Print Receipt
              </Link>
            </div>
          </div>
          <div className="space-y-2">
            {paidPayments.map((p) => {
              const emailMeta = parseReceiptEmailNote(p.notes);
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-line bg-surface px-3 py-2.5 text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-ink">{PLAN_LABELS[p.payment_plan]}</span>
                    {p.emi_months ? (
                      <span className="text-up font-medium">
                        {" "}
                        ({p.emi_months}M EMI · <Money value={p.emi_monthly_amount} />/mo)
                      </span>
                    ) : null}
                    <div className="text-[12px] text-muted num">
                      Order {p.razorpay_order_id} · Payment {p.razorpay_payment_id} · {(p.payment_method || "upi").toUpperCase()} ·{" "}
                      {fmtWhen(p.paid_at || p.created_at)}
                    </div>
                    {emailMeta.emailedTo ? (
                      <div className="text-[11.5px] text-up font-medium mt-0.5">
                        ✓ Receipt emailed to {emailMeta.emailedTo}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="num font-bold text-up">Paid {inr(p.amount)}</div>
                      {p.remaining_due > 0 ? (
                        <div className="num text-[11.5px] text-muted">
                          Remaining: {inr(p.remaining_due)}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2 !text-[11.5px]"
                        title="Email receipt for this payment"
                        onClick={() => {
                          setEmailComposerFor(p.id);
                          setErr(null);
                        }}
                      >
                        ✉ Email
                      </button>
                      <Link
                        href={`/cases/${caseId}/receipt?paymentId=${encodeURIComponent(p.id)}&autoprint=1`}
                        className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2 !text-[11.5px]"
                        title="Print receipt for this payment"
                      >
                        🖨 Print
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ErrorText error={err} />
    </div>
  );
}

