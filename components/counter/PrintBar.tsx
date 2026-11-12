"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText } from "@/components/ui";

/** The top bar on a printable receipt/report page: back, email receipt, and print receipt. Hidden on paper. */
export function PrintBar({
  back,
  label = "Print",
  caseId,
  paymentId,
  defaultEmail,
}: {
  back: string;
  label?: string;
  caseId?: string;
  paymentId?: string | null;
  defaultEmail?: string | null;
}) {
  const resolvedCaseId =
    caseId || (back.startsWith("/cases/") ? back.replace("/cases/", "").split("/")[0] : undefined);

  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentInfo, setSentInfo] = useState<{
    to: string;
    subject: string;
    html: string;
    text: string;
    deliveryMode: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("autoprint") === "1") {
      const t = setTimeout(() => {
        window.print();
      }, 350);
      return () => clearTimeout(t);
    }
    if (params.get("email") === "1") {
      setEmailOpen(true);
    }
  }, []);

  async function sendEmailReceipt(e: React.FormEvent) {
    e.preventDefault();
    if (!resolvedCaseId) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await api<{
        ok: true;
        to: string;
        subject: string;
        html: string;
        text: string;
        deliveryMode: string;
      }>(`/api/cases/${encodeURIComponent(resolvedCaseId)}/razorpay`, {
        body: {
          action: "email_receipt",
          email: email.trim(),
          paymentId: paymentId ?? null,
        },
      });
      setSentInfo(res);
      setEmailOpen(false);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="no-print mb-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="btn btn-sm btn-ghost">
          ← Back
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {resolvedCaseId ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEmailOpen((v) => !v);
                setErr(null);
              }}
            >
              ✉ Email receipt
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-primary" onClick={() => window.print()}>
            🖨 {label}
          </button>
        </div>
      </div>

      {emailOpen && resolvedCaseId ? (
        <form
          onSubmit={sendEmailReceipt}
          className="rounded-[12px] border border-line bg-surface p-3.5 flex flex-wrap items-center gap-2.5"
        >
          <span className="text-[13px] font-semibold text-ink">Send receipt to customer email:</span>
          <input
            type="email"
            required
            placeholder="customer@example.com"
            className="input !min-h-[34px] !py-1 !px-3 flex-1 min-w-[220px] text-[13.5px]"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Send email receipt"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setEmailOpen(false)}
          >
            Cancel
          </button>
          <ErrorText error={err} />
        </form>
      ) : null}

      {sentInfo ? (
        <Banner tone="up">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>✓ Receipt emailed to {sentInfo.to}</strong> · <span className="text-[13px]">{sentInfo.subject}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
                onClick={() => setPreviewOpen((v) => !v)}
              >
                {previewOpen ? "Hide email preview" : "Preview email"}
              </button>
              <a
                href={`mailto:${encodeURIComponent(sentInfo.to)}?subject=${encodeURIComponent(sentInfo.subject)}&body=${encodeURIComponent(sentInfo.text)}`}
                className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2.5 !text-[12px]"
              >
                Open in mail client
              </a>
            </div>
          </div>
          {previewOpen ? (
            <div
              className="mt-3 rounded-[10px] border border-line bg-white p-3 max-h-[420px] overflow-auto"
              dangerouslySetInnerHTML={{ __html: sentInfo.html }}
            />
          ) : null}
        </Banner>
      ) : null}
    </div>
  );
}

