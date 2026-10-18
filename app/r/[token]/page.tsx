import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { HttpError } from "@/lib/server/auth";
import { publicReport, type ReportEnvelope } from "@/lib/server/gradingReport";
import { originFromHeaders } from "@/lib/server/http";
import { Wordmark, headline } from "@/components/brand";
import { GradingReportView } from "@/components/report/GradingReportView";
import { PrintButton } from "@/components/report/PrintButton";
import { absoluteUrl, pinnedPath } from "@/components/counter/gradingView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Grade report", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export const viewport = { themeColor: "#f4f4f6" };

/**
 * THE PUBLIC GRADE REPORT — what the customer's QR (the store app, the
 * receipt) and the partner's pickup line open: what was tested and why the
 * phone got its grade (docs/GRADING.md). No sign-in — the 128-bit token is the
 * key — and no version list: the latest version, or exactly ?v=n.
 *
 * The body is public-safe by construction (lib/domain/gradingReport.ts): no
 * money of any kind, no store margin, no customer, a masked IMEI, no GradeIQ
 * letter, id or URL; photos come through /api/r/<token>/photo/<n>. This page
 * adds nothing but the brand, a print button and a QR of this exact version.
 *
 * Customer brand (components/brand.tsx): the text wordmark, Plus Jakarta Sans
 * headlines, light grey and blue, no logo. Phone-first; prints on A4.
 */
export default async function PublicReportPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ v?: string | string[] }> }) {
  const { token } = await params;
  const v = (await searchParams).v;
  let env: ReportEnvelope;
  try {
    env = publicReport(token, typeof v === "string" ? v : null);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }

  // SWAPUP_PUBLIC_URL in production; in dev the origin this page was opened on.
  const origin = originFromHeaders(await headers()) ?? "";
  const url = absoluteUrl(origin, pinnedPath(`/r/${token}`, env.version));
  const qr = { dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: "M" }), url };

  return (
    <main className="xc min-h-screen print:bg-white">
      <style>{`@page { size: A4; margin: 12mm; } @media print { html, body, .xc { background: #fff !important; } }`}</style>
      <div className="max-w-[680px] mx-auto px-4 pt-8 pb-12 print:p-0 print:max-w-none">
        <Wordmark store={env.body.case.store} />
        <div className="mt-6 mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className={`${headline.className} text-[24px] font-extrabold tracking-[-0.01em] leading-tight`}>Grade report</h2>
            <p className="text-[14px] text-[color:var(--xc-muted)]">
              Trade-in <span className="num">{env.body.case.ref}</span> · version {env.version}
            </p>
          </div>
          <PrintButton className="text-[14px] font-semibold text-[color:var(--xc-blue)] hover:underline" />
        </div>
        <GradingReportView env={env} token={token} variant="public" qr={qr} />
      </div>
    </main>
  );
}
