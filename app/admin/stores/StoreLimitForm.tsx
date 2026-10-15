"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText, Money } from "@/components/ui";
import { inr } from "@/lib/domain/money";
import { parseRupees } from "@/components/admin/format";

/** Inline "Change limit" for one store: new ₹ limit + a reason (both audited). */
export function StoreLimitForm({ storeId, storeName, limit, exposure }: { storeId: string; storeName: string; limit: number; exposure: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(limit));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const n = parseRupees(amount);

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setOpen(true);
            setSaved(null);
            setAmount(String(limit));
            setReason("");
            setError(null);
          }}
        >
          Change limit
        </button>
        {saved ? <span className="text-[12.5px] text-up font-semibold">{saved}</span> : null}
      </div>
    );
  }

  const invalid = n === null || n < 0;
  const unchanged = n === limit;
  return (
    <form
      className="w-[280px] space-y-2"
      aria-label={`Change credit limit for ${storeName}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid || unchanged) return;
        setBusy(true);
        setError(null);
        try {
          await api(`/api/admin/stores/${encodeURIComponent(storeId)}/limit`, { body: { limit: n, reason: reason.trim() } });
          setSaved(`Limit now ${inr(n)}`);
          setOpen(false);
          router.refresh();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block">
        <span className="label">New limit (₹)</span>
        <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus required />
      </label>
      <label className="block">
        <span className="label">Reason</span>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Diwali season volume"
          required
          minLength={4}
          maxLength={200}
        />
      </label>
      {n !== null && n !== limit ? (
        <p className="hint">
          {inr(limit)} → <strong className="text-ink">{inr(n)}</strong> ({n > limit ? "+" : "−"}
          {inr(Math.abs(n - limit))})
        </p>
      ) : null}
      {n !== null && n < exposure ? (
        <p className="hint !text-[color:var(--bad)]">
          The store is already carrying <Money value={exposure} />. Below that it cannot take any trade-in until a pickup brings it back under.
        </p>
      ) : null}
      {invalid && amount.trim() ? <p className="hint !text-[color:var(--bad)]">Enter a whole rupee amount.</p> : null}
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy || invalid || unchanged || reason.trim().length < 4}>
          {busy ? "Saving…" : "Save limit"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
