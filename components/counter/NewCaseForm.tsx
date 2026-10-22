"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";
import { RECORD_ANYWAY, imeiEntry, startCase } from "./imeiFirst";
import { ReadTheScreen } from "./ImeiCapture";

/**
 * Open a case the moment the customer sits down — THE IMEI FIRST (owner, 2026-10-19: "Scan IMEI
 * first"; SUP-35): the customer dials *#06#, the advisor types it or has the server read the screen,
 * and Start opens the case and saves the IMEI with the store app's PATCH, so the case opens on what
 * the server found (the model, the GSMA blacklist, an IMEI already traded in). Name and mobile can
 * wait; so can the IMEI, for the hand-over. Rules: imeiFirst.ts.
 */
export function NewCaseForm() {
  const router = useRouter();
  const [imei, setImei] = useState("");
  /** IMEI 2, from a confirmed read only; typing IMEI 1 again drops it (it was that read's phone). */
  const [imei2, setImei2] = useState<string | null>(null);
  const [anyway, setAnyway] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The case a failed Start opened: Start again saves on it, never a second one. */
  const [caseId, setCaseId] = useState<string | null>(null);

  const entry = imeiEntry(imei, anyway);
  const digits = phone.replace(/\D/g, "");
  const phoneBad = digits.length > 0 && !/^[6-9]\d{9}$/.test(digits);

  function typeImei(v: string) {
    setImei(v.replace(/[^\d\s]/g, ""));
    setImei2(null);
    setAnyway(false);
    setError(null);
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (entry.problem) return setError(entry.problem);
    if (phoneBad) return setError("Enter 10 digits, or leave it blank.");
    setBusy(true);
    setError(null);
    const r = await startCase(api, {
      customerName: name,
      customerPhone: digits || null,
      imei: entry.imei ? { imei: entry.imei, imei2 } : null,
      caseId,
    });
    if (r.error === null) {
      router.push(`/cases/${r.caseId}`);
      return;
    }
    setCaseId(r.caseId);
    setError(r.error);
    setBusy(false);
  }

  return (
    <form onSubmit={start} className="space-y-4">
      <div>
        <label className="block" htmlFor="new-case-imei">
          <span className="label">IMEI</span>
        </label>
        <p className="hint !mt-0 mb-2">Customer dials *#06#.</p>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="new-case-imei"
            className="input num max-w-[260px]"
            value={imei}
            onChange={(e) => typeImei(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="15 digits"
            maxLength={18}
            autoFocus
            disabled={busy}
            aria-invalid={!!entry.warn || undefined}
          />
          <ReadTheScreen
            disabled={busy}
            onConfirm={(v) => {
              setImei(v.imei);
              setImei2(v.imei2);
              setAnyway(false);
              setError(null);
            }}
            onMisread={typeImei}
          />
        </div>
        {imei2 && entry.imei ? <p className="hint num">IMEI 2 · {imei2}</p> : null}
        {entry.warn ? (
          <div className="mt-2 space-y-1.5">
            <p className="hint !mt-0 text-warn font-semibold">{entry.warn}</p>
            <label className="flex items-center gap-2 text-[14px] text-ink-2">
              <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} disabled={busy} />
              {RECORD_ANYWAY}
            </label>
          </div>
        ) : null}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Customer name (optional)</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="e.g. Meera Iyer" maxLength={80} disabled={busy} />
        </label>
        <label className="block">
          <span className="label">Mobile (optional)</span>
          <input
            className="input num"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+]/g, ""))}
            inputMode="tel"
            autoComplete="off"
            placeholder="10 digits"
            maxLength={14}
            disabled={busy}
            aria-invalid={phoneBad || undefined}
          />
          {phoneBad ? <span className="hint" style={{ color: "var(--bad)" }}>10 digits, starting 6–9.</span> : null}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? (entry.imei ? "Checking the IMEI…" : "Opening…") : caseId ? "Try again →" : "Start case →"}
        </button>
        <span className="hint !mt-0">{entry.imei ? "The IMEI is checked as the case opens." : "No IMEI? It can wait for the hand-over."}</span>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
