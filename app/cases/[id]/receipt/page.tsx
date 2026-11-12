import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { requirePage } from "@/lib/server/page";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import { HttpError, type SessionUser } from "@/lib/server/auth";
import { gradingReportFor } from "@/lib/server/gradingReport";
import { originFromHeaders } from "@/lib/server/http";
import type { CaseView } from "@/lib/server/cases";
import { getStore, getOrg } from "@/lib/server/scope";
import { getCaseRazorpaySummary, type RazorpayPaymentPlan } from "@/lib/server/razorpay";
import { inr, fmtBp } from "@/lib/domain/money";
import { maskImei } from "@/lib/domain/imei";
import { PrintBar } from "@/components/counter/PrintBar";
import { conditionSummary, faultLabels, fmtWhen, idTypeLabel, maskPhone } from "@/components/counter/shared";
import { absoluteUrl, gradeTail, pinnedPath, shortHash, tokenOf } from "@/components/counter/gradingView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exchange & Payment Receipt" };

const PLAN_LABELS: Record<RazorpayPaymentPlan, string> = {
  repair_part_advance: "Repair · Part Advance",
  repair_remaining: "Repair · Remaining Balance",
  repair_full: "Repair · Full Payment (100%)",
  swap_direct: "Swap Up · Direct Payment",
  swap_emi: "Swap Up · Razorpay EMI",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas print:bg-white py-6 px-4 print:p-0">
      <style>{`@page { size: A4; margin: 14mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mx-auto max-w-[780px]">{children}</div>
    </div>
  );
}

type ReportRow = { label: string; version: number; final: boolean; sha256: string; url: string; qr: string };

/**
 * The grade report this exchange was made on: the version frozen at hand-over,
 * its SwapUp grade (with the letter), a short hash, and a QR to exactly that
 * version. Never breaks the receipt — no report, or any failure, is no row.
 */
async function reportRow(u: SessionUser, caseId: string): Promise<ReportRow | null> {
  try {
    const r = await gradingReportFor(u, caseId);
    const env = r.issued;
    const token = tokenOf(r.path);
    if (!env || !token) return null;
    const url = absoluteUrl(originFromHeaders(await headers()) ?? "", pinnedPath(`/r/${token}`, env.version));
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" });
    return { label: `${env.body.grade.label}${gradeTail(env.body.grade)}`, version: env.version, final: env.final, sha256: env.sha256, url, qr };
  } catch (e) {
    console.error(`[swapup] receipt: no grade report row for ${caseId}:`, e);
    return null;
  }
}

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ paymentId?: string }>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const paymentIdFilter = sp?.paymentId ?? null;

  const u = await requirePage(null, `/cases/${id}/receipt`);
  let v: CaseView;
  try {
    v = await getCaseForViewer(u, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404)
      return (
        <Shell>
          <div className="card card-pad text-center">
            <div className="text-[17px] font-semibold">Case not found</div>
            <Link href="/" className="hint">
              Back
            </Link>
          </div>
        </Shell>
      );
    throw e;
  }

  const rzpSummary = await getCaseRazorpaySummary(v.id);
  const paidPayments = rzpSummary.payments.filter((p) => p.status === "paid");
  const filteredPayments = paymentIdFilter
    ? paidPayments.filter((p) => p.id === paymentIdFilter || p.razorpay_order_id === paymentIdFilter)
    : paidPayments;
  const paymentsToShow = filteredPayments.length > 0 ? filteredPayments : paidPayments;

  const hasRepairQuote = (rzpSummary.repair.totalPayable ?? 0) > 0 || v.status === "repair_chosen";
  const hasRazorpayPayments = paidPayments.length > 0;

  if (!v.lockedAt && !hasRepairQuote && !hasRazorpayPayments) {
    return (
      <Shell>
        <div className="card card-pad text-center">
          <div className="text-[18px] font-semibold">Not traded in or paid yet</div>
          <p className="hint">Printed once a trade-in is locked, a repair is booked, or a Razorpay payment is completed.</p>
          <Link href={`/cases/${v.id}`} className="btn btn-sm mt-4">
            ← Back
          </Link>
        </div>
      </Shell>
    );
  }

  let defaultCustomerEmail: string | null = null;
  for (const p of rzpSummary.payments) {
    if (p.notes) {
      try {
        const parsed = JSON.parse(p.notes) as { emailedTo?: string };
        if (parsed.emailedTo) {
          defaultCustomerEmail = parsed.emailedTo;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  const store = await getStore(v.storeId);
  const org = await getOrg(v.orgId);
  const test = !!org?.demo;
  const priceiq = v.quote?.source.kind === "priceiq";
  const wePay = v.tradeValue === null ? null : v.tradeValue + (v.premiumValue ?? 0);
  const marketLine = v.offer?.answer.lines.find((l) => l.key === "market") ?? null;
  const marketWords = marketLine ? (marketLine.text ? (marketLine.note ? `${marketLine.text} · ${marketLine.note}` : marketLine.text) : null) : null;
  const b = v.bonus;
  const bonusBp = b ? (b.override?.bp ?? b.bp) : null;
  const cond = conditionSummary(v.condition);
  const report = await reportRow(u, v.id);

  const isRepairReceipt =
    v.status === "repair_chosen" ||
    (!v.lockedAt && hasRepairQuote) ||
    (paymentsToShow.length > 0 && paymentsToShow.every((p) => p.journey === "repair"));

  const receiptTitle = isRepairReceipt
    ? "Repair & Payment Receipt"
    : hasRazorpayPayments && !v.lockedAt
      ? "SwapUp Payment Receipt"
      : "Exchange receipt";

  const receiptTimestamp =
    paymentsToShow[0]?.paid_at || v.lockedAt || v.updatedAt || v.createdAt;

  return (
    <Shell>
      <PrintBar
        back={`/cases/${v.id}`}
        label="Print receipt"
        caseId={v.id}
        paymentId={paymentIdFilter}
        defaultEmail={defaultCustomerEmail}
      />
      <article className="relative overflow-hidden bg-white border border-line rounded-[14px] print:border-0 print:rounded-none p-8 print:p-0 text-[13.5px] leading-relaxed text-ink">
        {test ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rotate-[-24deg] text-[64px] font-[800] tracking-tight text-[color:var(--test)] opacity-[0.10] whitespace-nowrap select-none">
              TEST — no real money
            </div>
          </div>
        ) : null}

        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[color:var(--ink)] pb-4">
          <div>
            <div className="text-[20px] font-[780] tracking-tight">{store?.name ?? v.storeName}</div>
            <div className="text-ink-2">
              {store?.city ?? ""}
              {store?.city ? " · " : ""}Store code {v.storeCode}
            </div>
            {org ? <div className="text-muted text-[12px]">{org.name}</div> : null}
          </div>
          <div className="text-right">
            <div className="text-[16px] font-[760] uppercase tracking-wide">{receiptTitle}</div>
            <div className="num text-[15px] font-semibold">{v.ref}</div>
            <div className="text-ink-2">{fmtWhen(receiptTimestamp, "long")}</div>
          </div>
        </header>

        {v.status === "cancelled" ? (
          <div className="mt-4 rounded-[10px] border-2 border-[color:var(--bad)] text-bad font-bold text-center py-2 uppercase tracking-wide">
            Cancelled {fmtWhen(v.closedAt, "date")} — reversed
          </div>
        ) : null}
        {test ? <div className="mt-4 rounded-[10px] bg-test-bg text-[color:var(--test)] font-semibold px-3 py-2">Test programme — no real money</div> : null}

        <section className="grid sm:grid-cols-2 print:grid-cols-2 gap-6 mt-5">
          <div>
            <h2 className="section-title mb-1.5">Customer</h2>
            <div className="font-semibold text-[15px]">{v.customer?.name ?? "—"}</div>
            <div>
              Mobile <span className="num">{maskPhone(v.customer?.phone)}</span>
            </div>
            {v.customer?.idLast4 ? (
              <div>
                {idTypeLabel(v.customer?.idType)} ending <span className="num">{v.customer?.idLast4 ?? "—"}</span>
              </div>
            ) : null}
          </div>
          <div>
            <h2 className="section-title mb-1.5">{isRepairReceipt ? "Customer device" : "Phone traded in"}</h2>
            <div className="font-semibold text-[15px]">{v.device ? `${v.device.brand} ${v.device.model} ${v.device.variant ?? ""}` : "—"}</div>
            <div>
              IMEI <span className="num">{v.imei ? maskImei(v.imei) : "—"}</span>
              {v.imei2 ? (
                <>
                  {" · "}IMEI 2 <span className="num">{maskImei(v.imei2)}</span>
                </>
              ) : null}
            </div>
            {v.checks?.kym ? (
              <div className="text-ink-2">
                Government IMEI register (KYM): {v.checks.kym.status === "clear" ? "no block" : v.checks.kym.status}
                {v.checks.kym.reference ? ` · ${v.checks.kym.reference}` : ""}
              </div>
            ) : null}
            {v.lockedAt ? (
              <div className="text-ink-2">
                Customer&apos;s data:{" "}
                {v.dataClear
                  ? `reset, seen by ${v.dataClear.by}, ${fmtWhen(v.dataClear.at)} (not a certified erasure)`
                  : v.dataClearState === "attested"
                    ? "reset ticked at hand-over (not a certified erasure)"
                    : "not cleared yet"}
              </div>
            ) : null}
            <div className="text-ink-2">Faults: {v.faults.length ? faultLabels(v.faults) : "none"}</div>
            {cond.length ? <div className="text-ink-2">Declared condition: {cond.join(" · ")}</div> : null}
          </div>
        </section>

        {report ? (
          <section className="mt-5 flex gap-4 items-start rounded-[10px] border border-line px-4 py-3 print:break-inside-avoid">
            <div className="min-w-0 flex-1">
              <h2 className="section-title mb-1">Grade report</h2>
              <div className="font-semibold text-[15px]">SwapUp grade: {report.label}</div>
              <div className="text-ink-2">
                Version {report.version}
                {report.final ? ", frozen at hand-over" : ""} · <span className="num">#{shortHash(report.sha256)}</span>
              </div>
              <div className="text-[12px] text-muted mt-1">As tested at the store; it doesn&apos;t set the trade-in value.</div>
              <div className="num text-[11px] text-muted break-all mt-0.5">{report.url}</div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
            <img src={report.qr} alt={`QR code for the grade report, version ${report.version}`} width={96} height={96} className="shrink-0 w-[96px] h-[96px]" />
          </section>
        ) : null}

        {/* Repair Bill Section (when customer opted for repair or paid for repair) */}
        {isRepairReceipt && rzpSummary.repair.totalPayable ? (
          <section className="mt-6">
            <h2 className="section-title mb-1.5">Repair summary</h2>
            <table className="w-full border-collapse">
              <tbody>
                {(v.repair?.lines ?? []).map((line) => (
                  <tr key={line.part} className="border-b border-line">
                    <td className="py-1.5 pr-3 text-ink-2">{line.label}</td>
                    <td className="py-1.5 text-right num whitespace-nowrap">{inr(line.listPrice)}</td>
                  </tr>
                ))}
                <tr className="border-b border-line">
                  <td className="py-2 pr-3 font-semibold">Total repair estimate</td>
                  <td className="py-2 text-right num font-semibold whitespace-nowrap">{inr(rzpSummary.repair.totalPayable)}</td>
                </tr>
                <tr className="border-b border-line">
                  <td className="py-2 pr-3 text-up font-semibold">Paid via Razorpay</td>
                  <td className="py-2 text-right num font-bold text-up whitespace-nowrap">− {inr(rzpSummary.repair.paidAmount)}</td>
                </tr>
                <tr>
                  <td className="py-3 pr-3 text-[16px] font-[760]">Remaining balance due on pickup</td>
                  <td className="py-3 text-right num text-[20px] font-[780] whitespace-nowrap">
                    {inr(rzpSummary.repair.remainingBalance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        ) : null}

        {/* Exchange Section (when customer traded in or chose an upgrade phone) */}
        {(!isRepairReceipt || v.lockedAt) ? (
          <section className="mt-6">
            <h2 className="section-title mb-1.5">The exchange</h2>
            <table className="w-full border-collapse">
              <tbody>
                <tr className="border-b border-line">
                  <td className="py-2 pr-3">
                    <div className="font-semibold">New phone: {v.upgrade?.label ?? "—"}</div>
                  </td>
                  <td className="py-2 text-right num whitespace-nowrap">{inr(v.upgrade?.price)}</td>
                </tr>
                <tr className="border-b border-line">
                  <td className="py-2 pr-3">
                    <div>We pay you</div>
                    <div className="text-[12px] text-muted">{marketWords ?? "Quoted by the buyback partner"}</div>
                  </td>
                  <td className="py-2 text-right num whitespace-nowrap">− {inr(wePay)}</td>
                </tr>
                <tr className="border-b border-line">
                  <td className="py-2 pr-3">
                    <div>Less upgrade bonus{bonusBp !== null ? ` (${fmtBp(bonusBp)})` : ""}</div>
                    {b ? (
                      <div className="text-[12px] text-muted">
                        {b.campaignName} · funded by {b.fundedBy}
                        {b.override ? " · set by the manager" : ""}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 text-right num whitespace-nowrap">− {inr(v.bonusValue ?? 0)}</td>
                </tr>
                <tr>
                  <td className="py-3 pr-3 text-[16px] font-[760]">Amount payable</td>
                  <td className="py-3 text-right num text-[22px] font-[780] whitespace-nowrap">{inr(v.payable ?? rzpSummary.swap.totalPayable)}</td>
                </tr>
              </tbody>
            </table>
          </section>
        ) : null}

        {/* Razorpay Payment Receipt Transactions */}
        {paymentsToShow.length > 0 ? (
          <section className="mt-6 print:break-inside-avoid">
            <h2 className="section-title mb-1.5">Razorpay payment receipt</h2>
            <table className="w-full border-collapse border border-line rounded-[8px] overflow-hidden text-[13px]">
              <thead>
                <tr className="bg-surface-2 text-left text-[12px] text-ink-2 border-b border-line">
                  <th className="py-2 px-3">Payment Plan &amp; Reference</th>
                  <th className="py-2 px-3">Method &amp; Date</th>
                  <th className="py-2 px-3 text-right">Amount Paid</th>
                </tr>
              </thead>
              <tbody>
                {paymentsToShow.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-ink">
                        {PLAN_LABELS[p.payment_plan]}
                        {p.emi_months ? ` (${p.emi_months}M EMI · ${inr(p.emi_monthly_amount)}/mo)` : ""}
                      </div>
                      <div className="num text-[11.5px] text-muted">
                        Order: {p.razorpay_order_id} · Payment: {p.razorpay_payment_id ?? "—"}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-ink-2">
                      <div className="uppercase font-semibold text-[12px]">{p.payment_method || "UPI"}</div>
                      <div className="text-[11.5px] text-muted">{fmtWhen(p.paid_at || p.created_at)}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right num">
                      <div className="font-bold text-up">{inr(p.amount)}</div>
                      {p.remaining_due > 0 ? (
                        <div className="text-[11.5px] text-fix font-semibold">
                          Balance due: {inr(p.remaining_due)}
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted">Paid in full</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section className="mt-5">
          <h2 className="section-title mb-1.5">Terms</h2>
          <ol className="list-decimal pl-5 space-y-1 text-[12.5px] text-ink-2">
            {isRepairReceipt ? (
              <>
                <li>Repair spare parts are priced as per the published OEM service schedule for the model above.</li>
                <li>If paid via Razorpay Part Advance, the remaining balance is payable upon repair completion and device handover.</li>
                <li>Only the ID&apos;s last four characters are recorded.</li>
              </>
            ) : (
              <>
                <li>
                  {priceiq ? "Trade-in: market price at its grade, less markdown and defects." : <>Trade-in: the buyback partner&apos;s quote for the condition above.</>} If the
                  phone differs, the store may revise or reverse the exchange.
                </li>
                <li>The bonus is a promotion; no bank cashback or no-cost EMI with it.</li>
                <li>The customer owns this phone and removed accounts, SIM, memory card and data.</li>
                <li>Only the ID&apos;s last four characters are recorded.</li>
                <li>Not a tax invoice. The GST invoice shows the new phone&apos;s full price.</li>
              </>
            )}
          </ol>
        </section>

        <section className="grid grid-cols-2 gap-10 mt-12">
          <div>
            <div className="border-t border-[color:var(--ink)] pt-1.5 text-[12.5px]">Customer signature</div>
            <div className="text-[12px] text-muted">{v.customer?.name ?? ""}</div>
          </div>
          <div>
            <div className="border-t border-[color:var(--ink)] pt-1.5 text-[12.5px]">Advisor signature</div>
            <div className="text-[12px] text-muted">{v.checks?.by ?? v.advisorName ?? ""}</div>
          </div>
        </section>
      </article>
    </Shell>
  );
}

