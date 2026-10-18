"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText, Field } from "@/components/ui";
import { inr } from "@/lib/domain/money";

/**
 * Close (part of) an open chargeback: the store made the shortfall good, or the
 * partner accepted a not-received dispute. Never more than is still open — the
 * service enforces that too.
 */
export function CloseShortfall({ caseId, caseRef, open, hint }: { caseId: string; caseRef: string; open: number; hint?: string }) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [amount, setAmount] = useState(String(open));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Math.floor(Number(amount));
  const amountOk = Number.isInteger(n) && n > 0 && n <= open;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/chargebacks/${caseId}/recover`, { body: { amount: n, note: note.trim() } });
      setShow(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  if (!show)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setShow(true)}>
        Close shortfall
      </button>
    );
  return (
    <form onSubmit={submit} className="space-y-3 min-w-[240px]" aria-label={`Close shortfall on ${caseRef}`}>
      <Field label="Amount recovered (₹)" hint={amountOk ? undefined : `₹1 to ${inr(open)}.`}>
        <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
      </Field>
      <Field label="How it was settled" hint={hint ?? "e.g. UPI ref …"}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} minLength={6} maxLength={200} required />
      </Field>
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy || !amountOk || note.trim().length < 6}>
          {busy ? "Saving…" : `Close ${amountOk ? inr(n) : ""}`}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
