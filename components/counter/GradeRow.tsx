"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CaseView } from "@/lib/server/cases";
import { LETTER_NOTE, TONE_TEXT, absoluteUrl, certifiedLine, gradeLine, gradeTone } from "./gradingView";

/**
 * THE GRADE, one line (docs/GRADING.md) — "SwapUp grade: Good (B)", the
 * server's one-line why, and the grade report: "View report" (the desk's print
 * view, which also carries the customer's link) and "Show the customer (QR)".
 * The same line as the SwapUp Store answer screen. It sits under the answer's
 * headline, never inside its price tiles: the grade never moves a price.
 *
 * Every word is the server's (CaseView.grading); this only lays it out. The
 * reasons in full, what to check by hand and what a buyer must know are one
 * click away, on the report. What the advisor certified by eye in SwapUp Store
 * ("Check the phone": screen, body, liquid indicator) is one line under it, by name.
 *
 * `hideLabel`: under the answer's own grade line ("Current grade C · screen cracked"), the
 * "SwapUp grade: …" line is not said again — one grade on the screen; the why and the report stay.
 */
export function GradeRow({ view, hideLabel = false }: { view: CaseView; hideLabel?: boolean }) {
  const g = view.grading;
  const path = g?.report?.path ?? null;
  const [qr, setQr] = useState<{ dataUrl: string; url: string } | null>(null);
  useEffect(() => setQr(null), [path]);
  if (!g) return null;
  const checked = certifiedLine(view.certification);

  async function showQr() {
    if (!path) return;
    if (qr) return setQr(null);
    // The customer's link as they will scan it: this desk's own origin (SWAPUP_PUBLIC_URL in production) + the path.
    const url = absoluteUrl(window.location.origin, path);
    const QRCode = (await import("qrcode")).default;
    setQr({ dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: "M" }), url });
  }

  return (
    <div className="space-y-1" id="grade">
      {hideLabel ? null : (
        <p className={`text-[16px] font-[720] leading-snug ${TONE_TEXT[gradeTone(g.status, g.final)]}`} title={LETTER_NOTE}>
          {gradeLine(g.label)}
        </p>
      )}
      {g.why ? <p className="text-[13.5px] text-ink-2 leading-snug">{g.why}</p> : null}
      {checked ? <p className="text-[13.5px] text-ink-2 leading-snug">{checked}</p> : null}
      {g.report ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 no-print">
          <Link href={`/cases/${view.id}/report`} className="text-[13.5px] font-semibold text-fix hover:underline">
            View report
          </Link>
          <button type="button" className="text-[13.5px] font-semibold text-fix hover:underline" onClick={showQr} aria-expanded={!!qr}>
            {qr ? "Hide QR" : "Customer QR"}
          </button>
        </div>
      ) : null}
      {qr ? (
        <div className="flex items-center gap-4 pt-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
          <img src={qr.dataUrl} alt="QR code for the customer's grade report" width={160} height={160} className="w-[160px] h-[160px] shrink-0" />
          <p className="text-[13px] text-ink-2">
            Customer scans for the grade report. No prices.
            <span className="block num text-[11.5px] text-muted break-all mt-1">{qr.url}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}
