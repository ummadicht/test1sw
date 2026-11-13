"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import type {
  CaseRazorpaySummary,
  RazorpayJourney,
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
  repair_part_advance: "Repair · Part Advance",
  repair_remaining: "Repair · Remaining Balance",
  repair_full: "Repair · Full Payment",
  swap_direct: "Swap Up · Direct Payment",
  swap_emi: "Swap Up · Razorpay EMI",
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
  const [activeTab, setActiveTab] = useState<RazorpayJourney>(
    mode === "swap" ? "swap" : "repair"
  );
  const [repairOption, setRepairOption] = useState<"part_advance" | "full">("part_advance");
  const [customAdvance, setCustomAdvance] = useState<string>("");
  const [swapOption, setSwapOption] = useState<"direct" | "emi">("direct");
  const [selectedEmiMonths, setSelectedEmiMonths] = useState<number>(6);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<{
    payment: RazorpayPaymentRow;
    keyId: string;
    liveKeysConfigured: boolean;
  } | null>(null);
  const [selectedSimMethod, setSelectedSimMethod] = useState<"upi" | "card" | "emi" | "netbanking">("upi");

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
      if (s.repair.suggestedAdvance) {
        setCustomAdvance((prev) => (prev ? prev : String(s.repair.suggestedAdvance)));
      }
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

  const effectiveRepairTotal =
    repairAmount && repairAmount > 0
      ? repairAmount
      : summary?.repair.totalPayable && summary.repair.totalPayable > 0
        ? summary.repair.totalPayable
        : 5000;
  const effectiveSwapTotal = swapAmount ?? summary?.swap.totalPayable ?? null;
  const repairPaid = summary?.repair.paidAmount ?? 0;
  const repairRemaining =
    effectiveRepairTotal !== null ? Math.max(0, effectiveRepairTotal - repairPaid) : 0;
  const defaultAdvance =
    effectiveRepairTotal !== null && effectiveRepairTotal > 0
      ? Math.max(100, Math.min(effectiveRepairTotal - 10, Math.round((effectiveRepairTotal * 0.3) / 10) * 10))
      : 0;

  const swapPaid = summary?.swap.paidAmount ?? 0;
  const swapRemaining =
    effectiveSwapTotal !== null ? Math.max(0, effectiveSwapTotal - swapPaid) : 0;

  const emiPlans = summary?.swap.emiPlans ?? [];
  const chosenEmiPlan =
    emiPlans.find((p) => p.months === selectedEmiMonths) ?? emiPlans[1] ?? emiPlans[0] ?? null;

  async function startCheckout(journey: RazorpayJourney, paymentPlan: RazorpayPaymentPlan) {
    setErr(null);
    setBusy(true);
    try {
      const advNum = Number(customAdvance || defaultAdvance);
      const res = await api<{
        payment: RazorpayPaymentRow;
        keyId: string;
        liveKeysConfigured: boolean;
        summary: CaseRazorpaySummary;
      }>(`/api/cases/${encodeURIComponent(caseId)}/razorpay`, {
        body: {
          action: "create_order",
          journey,
          paymentPlan,
          customAdvanceAmount: paymentPlan === "repair_part_advance" ? advNum : null,
          overrideTotalAmount: journey === "repair" ? effectiveRepairTotal : effectiveSwapTotal,
          emiMonths: paymentPlan === "swap_emi" ? selectedEmiMonths : null,
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
            description: `${caseRef} · ${PLAN_LABELS[paymentPlan]}`,
            order_id: res.payment.razorpay_order_id,
            prefill: {
              name: customerName || "",
              contact: customerPhone || "",
              method: paymentPlan === "swap_emi" ? "emi" : undefined,
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
                  paymentMethod: paymentPlan === "swap_emi" ? "emi" : "razorpay",
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
      setSelectedSimMethod(paymentPlan === "swap_emi" ? "emi" : "upi");
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

  return (
    <div className="rounded-[12px] border border-line bg-surface-2 p-4 space-y-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-[#072654] px-2.5 py-1 text-[12px] font-bold tracking-wide text-white">
            Razorpay
          </span>
          <span className="text-[15px] font-[720] text-ink">
            {mode === "repair"
              ? "Pay for Repair via Razorpay"
              : mode === "swap"
                ? "Pay for Swap Up via Razorpay"
                : "Razorpay Payment Options"}
          </span>
        </div>
        {mode === "both" ? (
          <div className="flex gap-1.5" role="tablist">
            <button
              type="button"
              className="chip !min-h-[32px] !text-[13px]"
              aria-pressed={activeTab === "repair"}
              onClick={() => setActiveTab("repair")}
            >
              Repair Payment
            </button>
            <button
              type="button"
              className="chip !min-h-[32px] !text-[13px]"
              aria-pressed={activeTab === "swap"}
              onClick={() => setActiveTab("swap")}
            >
              Swap Up (EMI / Direct)
            </button>
          </div>
        ) : null}
      </div>

      {/* ─────────────── REPAIR PAYMENT FLOW ─────────────── */}
      {(mode === "repair" || (mode === "both" && activeTab === "repair")) && (
        <div className="space-y-3">
          {effectiveRepairTotal === null || effectiveRepairTotal <= 0 ? (
            <p className="text-[13.5px] text-muted">
              Record a fault or enter a repair quote first to enable Razorpay repair payments.
            </p>
          ) : repairRemaining === 0 ? (
            <Banner tone="up">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>Repair paid in full via Razorpay ({inr(effectiveRepairTotal)}).</strong>
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
          ) : repairPaid > 0 && repairRemaining > 0 ? (
            <div className="rounded-[10px] border border-line bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="pill pill-up">✓ Part Advance Paid: {inr(repairPaid)}</span>
                  <div className="text-[14px] text-ink mt-1.5">
                    Total repair: <strong className="num">{inr(effectiveRepairTotal)}</strong> · Remaining balance due:{" "}
                    <strong className="num text-fix">{inr(repairRemaining)}</strong>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setEmailComposerFor("all");
                      setErr(null);
                    }}
                  >
                    ✉ Email Advance Receipt
                  </button>
                  <Link
                    href={`/cases/${caseId}/receipt?autoprint=1`}
                    className="btn btn-sm"
                  >
                    🖨 Print Advance Receipt
                  </Link>
                  <button
                    type="button"
                    className="btn btn-fix btn-sm"
                    disabled={busy}
                    onClick={() => startCheckout("repair", "repair_remaining")}
                  >
                    {busy ? "Opening Razorpay…" : `Pay Remaining ${inr(repairRemaining)} via Razorpay`}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid sm:grid-cols-2 gap-2.5">
                {/* Option 1: Part Advance + Remaining */}
                <label
                  className={`flex flex-col justify-between rounded-[10px] border p-3 cursor-pointer transition-colors ${
                    repairOption === "part_advance"
                      ? "border-[color:var(--ink)] bg-surface"
                      : "border-line bg-surface/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name={`rzp-repair-${caseId}`}
                      className="mt-1"
                      checked={repairOption === "part_advance"}
                      onChange={() => setRepairOption("part_advance")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-[720] text-ink">
                        Option 1: Part Advance + Remaining
                      </div>
                      <p className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">
                        Pay advance now to book the repair, and pay the remaining balance via Razorpay after repair completion.
                      </p>
                    </div>
                  </div>
                  {repairOption === "part_advance" && (
                    <div className="mt-3 pt-2.5 border-t border-line space-y-2">
                      <div className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="text-ink-2 font-medium">Advance now (₹):</span>
                        <input
                          type="number"
                          className="input num !min-h-[34px] !py-1 !px-2.5 max-w-[120px] text-right font-semibold"
                          min={1}
                          max={Math.max(1, effectiveRepairTotal - 1)}
                          value={customAdvance || String(defaultAdvance)}
                          onChange={(e) => setCustomAdvance(e.target.value)}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[12.5px] text-muted">
                        <span>Remaining on completion:</span>
                        <span className="num font-semibold text-ink">
                          {inr(Math.max(0, effectiveRepairTotal - Number(customAdvance || defaultAdvance)))}
                        </span>
                      </div>
                    </div>
                  )}
                </label>

                {/* Option 2: Full Repair Payment */}
                <label
                  className={`flex flex-col justify-between rounded-[10px] border p-3 cursor-pointer transition-colors ${
                    repairOption === "full"
                      ? "border-[color:var(--ink)] bg-surface"
                      : "border-line bg-surface/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name={`rzp-repair-${caseId}`}
                      className="mt-1"
                      checked={repairOption === "full"}
                      onChange={() => setRepairOption("full")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-[720] text-ink">
                        Option 2: Full Payment (100%)
                      </div>
                      <p className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">
                        Pay the complete repair quote of <strong className="num">{inr(effectiveRepairTotal)}</strong> upfront via Razorpay.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 pt-2.5 border-t border-line flex items-center justify-between text-[13px]">
                    <span className="text-ink-2">Payable now:</span>
                    <strong className="num text-ink">{inr(effectiveRepairTotal)}</strong>
                  </div>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-fix btn-sm"
                  disabled={busy}
                  onClick={() =>
                    startCheckout(
                      "repair",
                      repairOption === "part_advance" ? "repair_part_advance" : "repair_full"
                    )
                  }
                >
                  {busy
                    ? "Creating Razorpay Order…"
                    : repairOption === "part_advance"
                      ? `Pay Part Advance ${inr(Number(customAdvance || defaultAdvance))} via Razorpay`
                      : `Pay Full Repair ${inr(effectiveRepairTotal)} via Razorpay`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─────────────── SWAP / UPGRADE PAYMENT FLOW (DIRECT OR EMI) ─────────────── */}
      {(mode === "swap" || (mode === "both" && activeTab === "swap")) && (
        <div className="space-y-3">
          {effectiveSwapTotal === null || effectiveSwapTotal <= 0 ? (
            <p className="text-[13.5px] text-muted">
              Select a target upgrade phone with a net payable balance to pay via Razorpay (Direct or EMI).
            </p>
          ) : swapRemaining === 0 ? (
            <Banner tone="up">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>Swap upgrade balance ({inr(effectiveSwapTotal)}) paid in full via Razorpay.</strong>
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
              <div className="grid sm:grid-cols-2 gap-2.5">
                {/* Option 1: Direct Payment */}
                <label
                  className={`flex flex-col justify-between rounded-[10px] border p-3 cursor-pointer transition-colors ${
                    swapOption === "direct"
                      ? "border-[color:var(--ink)] bg-surface"
                      : "border-line bg-surface/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name={`rzp-swap-${caseId}`}
                      className="mt-1"
                      checked={swapOption === "direct"}
                      onChange={() => setSwapOption("direct")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-[720] text-ink">
                        Option 1: Direct Payment via Razorpay
                      </div>
                      <p className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">
                        Pay the net upgrade difference in one go via UPI, Credit/Debit Card, or NetBanking.
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 pt-2.5 border-t border-line flex items-center justify-between text-[13px]">
                    <span className="text-ink-2">Net customer payable:</span>
                    <strong className="num text-[15px] text-ink">{inr(swapRemaining)}</strong>
                  </div>
                </label>

                {/* Option 2: Razorpay EMI */}
                <label
                  className={`flex flex-col justify-between rounded-[10px] border p-3 cursor-pointer transition-colors ${
                    swapOption === "emi"
                      ? "border-[color:var(--ink)] bg-surface"
                      : "border-line bg-surface/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="radio"
                      name={`rzp-swap-${caseId}`}
                      className="mt-1"
                      checked={swapOption === "emi"}
                      onChange={() => setSwapOption("emi")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] font-[720] text-ink">
                          Option 2: EMI via Razorpay
                        </span>
                        <span className="pill pill-up !text-[11px]">No-Cost EMI available</span>
                      </div>
                      <p className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">
                        Convert <strong className="num">{inr(swapRemaining)}</strong> into monthly instalments on Credit/Debit cards &amp; Cardless EMI.
                      </p>
                    </div>
                  </div>
                  {chosenEmiPlan ? (
                    <div className="mt-3 pt-2.5 border-t border-line flex items-center justify-between text-[13px]">
                      <span className="text-ink-2">Selected plan:</span>
                      <strong className="num text-up">
                        {inr(chosenEmiPlan.monthlyAmount)}/mo × {chosenEmiPlan.months}m
                      </strong>
                    </div>
                  ) : null}
                </label>
              </div>

              {swapOption === "emi" && emiPlans.length > 0 && (
                <div className="rounded-[10px] border border-line bg-surface p-3 space-y-2">
                  <div className="text-[12.5px] font-bold uppercase tracking-wider text-ink-2">
                    Choose Razorpay EMI Tenure (on {inr(swapRemaining)})
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {emiPlans.map((plan) => {
                      const active = selectedEmiMonths === plan.months;
                      return (
                        <button
                          key={plan.months}
                          type="button"
                          onClick={() => setSelectedEmiMonths(plan.months)}
                          className={`rounded-[8px] border px-3 py-2 text-left transition-colors ${
                            active
                              ? "border-[color:var(--ink)] bg-surface-2 font-semibold"
                              : "border-line bg-surface hover:bg-surface-2/60"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[13px] font-bold">{plan.months} Months</span>
                            {plan.noCost ? (
                              <span className="text-[10.5px] font-bold text-up">NO COST</span>
                            ) : (
                              <span className="text-[10.5px] text-muted">{plan.interestRatePa}% p.a.</span>
                            )}
                          </div>
                          <div className="num text-[14px] font-[740] text-ink mt-0.5">
                            {inr(plan.monthlyAmount)}/mo
                          </div>
                          <div className="num text-[11.5px] text-muted">
                            Total {inr(plan.totalAmount)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-up btn-sm"
                  disabled={busy}
                  onClick={() =>
                    startCheckout("swap", swapOption === "emi" ? "swap_emi" : "swap_direct")
                  }
                >
                  {busy
                    ? "Creating Razorpay Order…"
                    : swapOption === "emi" && chosenEmiPlan
                      ? `Pay with Razorpay EMI (${inr(chosenEmiPlan.monthlyAmount)}/mo × ${chosenEmiPlan.months}M)`
                      : `Pay Direct ${inr(swapRemaining)} via Razorpay`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
                {activeOrder.payment.remaining_due > 0 ? (
                  <span className="num text-fix font-semibold">
                    Balance after this: {inr(activeOrder.payment.remaining_due)}
                  </span>
                ) : null}
              </div>

              <div className="space-y-2">
                <div className="text-[12.5px] font-bold uppercase tracking-wider text-ink-2">
                  Select Payment Method
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["upi", "UPI (GPay / PhonePe / Paytm)"],
                      ["card", "Credit / Debit Card"],
                      ["emi", "Razorpay EMI (Cards / Cardless)"],
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

