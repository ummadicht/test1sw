import Link from "next/link";
import { requirePage } from "@/lib/server/page";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import { HttpError } from "@/lib/server/auth";
import type { CaseView } from "@/lib/server/cases";
import { getStore, getOrg } from "@/lib/server/scope";
import { inr, fmtBp } from "@/lib/domain/money";
import { maskImei } from "@/lib/domain/imei";
import { PrintBar } from "@/components/counter/PrintBar";
import { conditionSummary, faultLabels, fmtWhen, idTypeLabel, maskPhone } from "@/components/counter/shared";

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

function SourceLine({ v }: { v: CaseView }) {
  const q = v.quote;
  if (!q) return <>—</>;
  if (q.source.kind === "sample") return <strong>SAMPLE — not a real quote</strong>;
  if (q.partnerRef) return <>Ref. {q.partnerRef}</>;
  return (
    <>
      {q.source.label}
      {q.source.effectiveFrom ? `, effective ${fmtWhen(q.source.effectiveFrom, "date")}` : ""}
    </>
  );
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
          <p className="hint">The exchange receipt is printed once the trade-in is taken at the counter (step 7 on the case).</p>
          <Link href={`/cases/${v.id}`} className="btn btn-sm mt-4">
            ← Back to the case
          </Link>
        </div>
      </Shell>
    );
  }

  const store = getStore(v.storeId);
  const org = getOrg(v.orgId);
  const sample = v.quote?.source.kind === "sample";
  const partner = v.quote?.partner ?? v.partner?.partnerName ?? "the buyback partner";
  const b = v.bonus;
  const bonusBp = b ? (b.override?.bp ?? b.bp) : null;
  const cond = conditionSummary(v.condition);

  return (
    <Shell>
      <PrintBar back={`/cases/${v.id}`} label="Print receipt" />
      <article className="relative overflow-hidden bg-white border border-line rounded-[14px] print:border-0 print:rounded-none p-8 print:p-0 text-[13.5px] leading-relaxed text-ink">
        {sample ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rotate-[-24deg] text-[64px] font-[800] tracking-tight text-[color:var(--sample)] opacity-[0.10] whitespace-nowrap select-none">
              SAMPLE — not a real quote
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
            Cancelled {fmtWhen(v.closedAt, "date")} — this exchange was reversed
          </div>
        ) : null}
        {sample ? (
          <div className="mt-4 rounded-[10px] bg-sample-bg text-[color:var(--sample)] font-semibold px-3 py-2">
            SAMPLE — the trade-in value below comes from a sample rate card, not a real {partner} quote.
          </div>
        ) : null}
        {v.demo ? <div className="mt-2 text-muted text-[12px]">Example case from the demo programme — not a real transaction.</div> : null}

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
                ? `factory reset by the customer, seen by ${v.dataClear.by} on ${fmtWhen(v.dataClear.at)} (not a certified erasure)`
                : v.dataClearState === "attested"
                  ? "factory reset ticked at hand-over (not a certified erasure)"
                  : "not cleared yet"}
            </div>
            <div className="text-ink-2">Faults: {v.faults.length ? faultLabels(v.faults) : "none reported"}</div>
            {cond.length ? <div className="text-ink-2">Declared condition: {cond.join(" · ")}</div> : null}
          </div>
        </section>

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
                  <div>Less trade-in value of the old phone</div>
                  <div className="text-[12px] text-muted">
                    Quoted by {partner} · <SourceLine v={v} />
                  </div>
                </td>
                <td className="py-2 text-right num whitespace-nowrap">− {inr(v.tradeValue)}</td>
              </tr>
              <tr className="border-b border-line">
                <td className="py-2 pr-3">
                  <div>Less upgrade bonus{bonusBp !== null ? ` (${fmtBp(bonusBp)})` : ""}</div>
                  {b ? (
                    <div className="text-[12px] text-muted">
                      {b.campaignName} · funded by {b.fundedBy}
                      {b.override ? " · set by the store manager" : ""}
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
              The trade-in value is {partner}&apos;s quote for the phone in the condition declared above. If the phone is found to differ from that
              description, the store may revise or reverse the exchange.
            </li>
            <li>The upgrade bonus is a promotion on this new phone. It cannot be combined with bank cashback or no-cost EMI offers.</li>
            <li>The customer confirms they own the phone traded in, have signed out of all accounts and removed their SIM, memory card and data.</li>
            <li>Only the last four characters of the customer&apos;s ID document are recorded.</li>
            <li>
              This is an exchange receipt, not a tax invoice. The new phone&apos;s GST invoice is issued at its full price, with the trade-in shown as
              part of the settlement.
            </li>
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
