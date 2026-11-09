import Link from "next/link";
import QRCode from "qrcode";
import { requirePage } from "@/lib/server/page";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import { HttpError } from "@/lib/server/auth";
import { getOrg } from "@/lib/server/scope";
import type { CaseView } from "@/lib/server/cases";
import { inr } from "@/lib/domain/money";
import { PrintBar } from "@/components/counter/PrintBar";
import { fmtWhen } from "@/components/counter/shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Device tag" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas print:bg-white py-6 px-4 print:p-0">
      <style>{`@page { size: auto; margin: 8mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mx-auto max-w-[460px]">{children}</div>
    </div>
  );
}

/** A tag for the bag the traded-in phone waits in: the case ref, big, and a QR the collector can scan. */
export default async function TagPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await requirePage(null, `/cases/${id}/tag`);
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

  if (!v.lockedAt) {
    return (
      <Shell>
        <div className="card card-pad text-center">
          <div className="text-[18px] font-semibold">Not traded in yet</div>
          <p className="hint">A device tag is printed once the trade-in is taken and the phone stays at the store.</p>
          <Link href={`/cases/${v.id}`} className="btn btn-sm mt-4">
            ← Back to the case
          </Link>
        </div>
      </Shell>
    );
  }

  const qr = await QRCode.toDataURL(v.ref, { margin: 1, width: 360, errorCorrectionLevel: "M" });
  const org = await getOrg(v.orgId);
  const test = !!org?.demo;

  return (
    <Shell>
      <PrintBar back={`/cases/${v.id}`} label="Print tag" />
      <article className="bg-white border-2 border-dashed border-[color:var(--ink)] rounded-[14px] p-5 text-ink">
        <div className="flex items-center justify-between gap-3">
          <div className="section-title !text-ink">Traded-in device · keep with the phone</div>
          <div className="num text-[13px] font-bold">{v.storeCode}</div>
        </div>
        <div className="num text-[38px] leading-none font-[800] tracking-tight mt-3 break-all">{v.ref}</div>
        {v.status === "cancelled" ? <div className="mt-2 font-bold text-bad uppercase">Cancelled — return the phone to the customer</div> : null}
        <div className="flex gap-4 mt-4 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
          <img src={qr} alt={`QR code for ${v.ref}`} width={150} height={150} className="shrink-0 w-[150px] h-[150px]" />
          <dl className="text-[14px] space-y-1.5 min-w-0">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">Phone</dt>
              <dd className="font-semibold leading-tight">{v.device ? `${v.device.brand} ${v.device.model} ${v.device.variant ?? ""}` : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">IMEI ends</dt>
              <dd className="num font-semibold text-[18px]">{v.imei ? v.imei.slice(-4) : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">Trade-in value</dt>
              <dd className="num font-semibold">
                {inr(v.tradeValue)}
                {test ? <span className="ml-1.5 text-[11px] font-bold text-[color:var(--test)]">TEST</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted">Taken in</dt>
              <dd>{fmtWhen(v.lockedAt, "date")}</dd>
            </div>
          </dl>
        </div>
        <p className="text-[11.5px] text-muted mt-4">No tag, no hand-over.</p>
      </article>
    </Shell>
  );
}
