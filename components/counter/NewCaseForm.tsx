"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";

/** Open a case the moment the customer sits down. Name and mobile can wait. */
export function NewCaseForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "");
  const phoneBad = digits.length > 0 && !/^[6-9]\d{9}$/.test(digits);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (phoneBad) {
      setError("Enter 10 digits, or leave it blank.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>("/api/cases", { body: { customerName: name.trim() || undefined, customerPhone: digits || undefined } });
      router.push(`/cases/${c.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Customer name (optional)</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="e.g. Meera Iyer" maxLength={80} />
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
            aria-invalid={phoneBad || undefined}
          />
          {phoneBad ? <span className="hint" style={{ color: "var(--bad)" }}>10 digits, starting 6–9.</span> : null}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Opening…" : "Start case →"}
        </button>
        <span className="hint !mt-0">Details can wait.</span>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
