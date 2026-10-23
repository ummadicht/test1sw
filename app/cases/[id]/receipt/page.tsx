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
import { inr, fmtBp } from "@/lib/domain/money";
import { maskImei } from "@/lib/domain/imei";
import { PrintBar } from "@/components/counter/PrintBar";
import { conditionSummary, faultLabels, fmtWhen, idTypeLabel, maskPhone } from "@/components/counter/shared";
import { absoluteUrl, gradeTail, pinnedPath, shortHash, tokenOf } from "@/components/counter/gradingView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exchange receipt" };

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
    const r = gradingReportFor(u, caseId);
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

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await requirePage(null, `/cases/${id}/receipt`);
  let v: CaseView;
  try {
    v = getCaseForViewer(u, id);
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

  if (!v.lockedAt) {
    return (
      <Shell>
        <div className="card card-pad text-center">
          <div className="text-[18px] font-semibold">Not traded in yet</div>
          <p className="hint">Printed once the trade-in is taken.</p>
          <Link href={`/cases/${v.id}`} className="btn btn-sm mt-4">
            ← Back
          </Link>
        </div>
      </Shell>
    );
  }

  const store = getStore(v.storeId);
  const org = getOrg(v.orgId);
  // A test programme's receipt says so on its face: no real money changes hands.
  const test = !!org?.demo;
  const priceiq = v.quote?.source.kind === "priceiq";
  // The customer's copy: what we pay (the market price + the SwapUp premium) in ONE row, its market
  // price in the answer's own words under it. Never the word "premium", never the partner's name.
  const wePay = v.tradeValue === null ? null : v.tradeValue + (v.premiumValue ?? 0);
  // The line with its note — "Market price for grade A ₹29,710 · ₹34,960 less ₹5,250 for back glass cracked" —
  // so a grade price with something taken off is never printed without the working-out.
  const marketLine = v.offer?.answer.lines.find((l) => l.key === "market") ?? null;
  const marketWords = marketLine ? (marketLine.note ? `${marketLine.text} · ${marketLine.note}` : marketLine.text) : null;
  const b = v.bonus;
  const bonusBp = b ? (b.override?.bp ?? b.bp) : null;
  const cond = conditionSummary(v.condition);
  const report = await reportRow(u, v.id);

  return (
    <Shell>
      <PrintBar back={`/cases/${v.id}`} label="Print receipt" />
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
            <div className="text-[16px] font-[760] uppercase tracking-wide">Exchange receipt</div>
            <div className="num text-[15px] font-semibold">{v.ref}</div>
            <div className="text-ink-2">{fmtWhen(v.lockedAt, "long")}</div>
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
            <div>
              {idTypeLabel(v.customer?.idType)} ending <span className="num">{v.customer?.idLast4 ?? "—"}</span>
            </div>
          </div>
          <div>
            <h2 className="section-title mb-1.5">Phone traded in</h2>
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
            <div className="text-ink-2">
              Customer&apos;s data:{" "}
              {v.dataClear
                ? `reset, seen by ${v.dataClear.by}, ${fmtWhen(v.dataClear.at)} (not a certified erasure)`
                : v.dataClearState === "attested"
                  ? "reset ticked at hand-over (not a certified erasure)"
                  : "not cleared yet"}
            </div>
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
                <td className="py-3 text-right num text-[22px] font-[780] whitespace-nowrap">{inr(v.payable)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="mt-5">
          <h2 className="section-title mb-1.5">Terms</h2>
          <ol className="list-decimal pl-5 space-y-1 text-[12.5px] text-ink-2">
            <li>
              {priceiq ? "Trade-in: market price at its grade, less markdown and defects." : <>Trade-in: the buyback partner&apos;s quote for the condition above.</>} If the
              phone differs, the store may revise or reverse the exchange.
            </li>
            <li>The bonus is a promotion; no bank cashback or no-cost EMI with it.</li>
            <li>The customer owns this phone and removed accounts, SIM, memory card and data.</li>
            <li>Only the ID&apos;s last four characters are recorded.</li>
            <li>Not a tax invoice. The GST invoice shows the new phone&apos;s full price.</li>
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
